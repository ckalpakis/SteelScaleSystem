# Steel Scale production deployment

This guide supersedes the topology/startup sections of the root deployment guide. Existing
Twilio/Vapi/GHL onboarding instructions remain valid. This increment was inspected and tested
locally; no live Railway settings, credentials, deployment or production database were changed.
Compare dashboard overrides with these files before rollout.

## Architecture and decisions

| Service    | Responsibility                                                                                                                                             | Entry point / configuration                                        |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Web/API    | Authentication, SSR/admin, CRM, configuration, synchronous booking requests, authenticated webhook intake                                                  | `npm start`, `railway.json`                                        |
| Worker     | Events, agent steps, due schedules/recovery scans, communication/integration delivery, retries, legacy SMS processing, lead pipelines, queued cron reports | `npm run start:workforce-worker`, `railway.workforce.json`         |
| PostgreSQL | Canonical tenant data, policy/approval/audit evidence, durable jobs, due times, send idempotency and outcomes                                              | Existing Railway Postgres service and volume                       |
| Redis      | BullMQ wake-up scheduling, cross-replica lane concurrency, bounded infrastructure retries and retained failures                                            | Private Railway Redis service, persistent volume, AOF, no eviction |

The existing PostgreSQL queue/outbox is deliberately retained. API transactions commit canonical
events and jobs together. Redis contains only versioned, payload-free lane wake-ups, not customer
messages or authorization decisions. The worker claims authoritative database rows using leases
and `FOR UPDATE SKIP LOCKED`. No unsafe PostgreSQL/Redis dual-write is introduced. Redis outages
delay processing but do not lose acknowledged customer jobs; the API remains available when
PostgreSQL is healthy. Redis is required on the worker, not the web service.

BullMQ has eight lanes: events, agents, integrations, communications, schedules, legacy_sms,
pipelines, maintenance. Each has global concurrency 1 across replicas. Canonical batches default
to 10 operations, stopping after an operation when 30 seconds have elapsed. Schedule scans run
every 30 seconds; other wake-ups every second. These are polling targets, not delivery-time SLAs.
Global serial lanes are a conservative rollout setting; multiple replicas provide failover, not
linear throughput. Benchmark before increasing concurrency or introducing tenant partitions.

BullMQ scheduler definitions persist in Redis and are upserted on worker startup. Job schedulers
produce wake-ups as work is consumed. All customer `availableAt`, `nextRunAt`, recovery deadlines,
approval expiry and communication state remain in PostgreSQL. No customer follow-up exists only
in a JavaScript timer. Local timers bound health/shutdown latency, provider timeouts and live
voice-session cleanup; they do not own scheduled customer work. See [BullMQ schedulers](https://docs.bullmq.io/guide/job-schedulers/).

## What moved, and compatibility boundaries

With `DURABLE_BACKGROUND_ENABLED=true` on both services:

- Signed legacy SMS ingress persists suppression and a `BackgroundTask` before acknowledgment.
  Slow booking/model work runs in the worker. A database failure returns 503 for provider retry.
- Admin lead searches persist their existing PipelineRun and an operational outbox task. A worker
  reconciler recovers the gap if the process dies between those writes. Web startup no longer
  launches interrupted pipelines.
- Authenticated `/internal/cron/daily-summary` and `/internal/cron/lead-intelligence` enqueue work
  and return **202** with `jobId`/status. They deduplicate by UTC day/hour respectively. Keep the
  existing external daily scheduler; the worker consumes its durable request. No surprise new
  cross-client daily-report schedule is enabled.

The flag defaults false for staged compatibility; production split is not complete until enabled
on both services. Do not roll it back to false with pending jobs or old web instances still
processing them. Websocket voice sessions, interactive model previews/builder extraction,
synchronous chatbot/Vapi booking requests, missed-call handling and request-bound admin analysis
remain on the web request path. They are not scheduled follow-up jobs. This is not an async
rewrite of every legacy API. GHL remains optional; existing booking/provider flows are preserved.

Canonical agents retain their registered internal tools, policy/approval boundaries, DND checks,
and certified Recovery adapter. Redis cannot authorize an action. Native communication delivery
still uses the existing separately gated human-message worker; this release does not activate
a new autonomous SMS sender.

## Retry, idempotency and failure policy

| Work                           | Durable authority / behavior                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Event processing               | WorkforceJob + BusinessEvent; tenant/event IDs and unique handler deliveries; 5 attempts, exponential backoff, dead status and AuditLog                |
| Agent execution                | AgentRun/Step/Action, correlationId, bounded run/step/action budgets, lease fencing and approval revalidation; no blanket model/action replay          |
| Outbound webhooks              | OutboundDelivery/Attempt, delivery ID reused on retry, bounded exponential backoff, retained dead state; recipient must deduplicate delivery IDs       |
| Native messages                | CommunicationDelivery/Attempt; only confirmed non-sends retry (3 attempts); ambiguous acceptance/timeouts become unknown, never automatically resent   |
| BullMQ wake-ups                | 5 attempts, exponential backoff from 1 second; stalled detection; 100 completed jobs retained per lane, failures retained until reviewed               |
| Legacy background side effects | BackgroundTask; unique scoped key + payload hash; one automatic execution, one-hour lease; exceptions/expired leases become unknown for reconciliation |

Legacy handlers cannot safely promise idempotent external effects, so their interrupted work is
not automatically replayed. This can require human recovery after a crash; it avoids silently
duplicating SMS, reports or paid discovery. Do not reset these tasks to pending. Inspect provider
and internal delivery evidence, resolve the underlying error, then authorize a new operation only
if its outcome is known. Jobs already queued for an old PipelineRun are not rerun merely because
a web process restarts. Pre-cutover `running` legacy PipelineRuns must be reconciled manually.

BackgroundTask preserves the existing Client boundary: customer tasks require clientId and use
organizationId only for an explicit Organization.legacyClientId link. The worker rechecks the link
and destination; it does not infer tenancy from a payload. Cross-client system report jobs have
neither tenant identifier. Completed payloads are cleared, retaining hashes/IDs/status. Unresolved
payloads may contain SMS text needed for recovery: restrict database access and establish a
reviewed retention policy. Neither Redis nor operator responses/logs include their bodies.

## Railway setup and release order

1. Keep the existing web service/domain and Postgres volume. Take a verified backup and rehearse
   restore into an isolated database. Record the currently running commit, feature flags and
   deployment configuration. Never paste secrets into Git or issue/log output.
2. Add private Redis with a persistent volume. Enable AOF (`appendonly yes`, `appendfsync everysec`)
   and `maxmemory-policy noeviction`; leave capacity headroom and alert on memory/write errors.
   Do not enable a public TCP proxy. These settings are operator configuration, not automatically
   applied by this repository. See [BullMQ production requirements](https://docs.bullmq.io/guide/going-to-production).
3. Build both services from the same reviewed commit and lockfile. Keep RAILPACK and
   `npm run build`; normal dependency install runs `prisma generate`. Ensure Prisma CLI remains
   installed in the pre-deploy environment (it is a devDependency; do not omit build dependencies).
   Select and pin a tested supported Node release in Railway; do not combine a runtime-major
   upgrade with this cutover without staging it.
4. Web: use `/railway.json` as its Config File Path. It preserves the existing migration
   pre-deploy command and now uses `/ready`. Worker: create a separate repository service with
   Config File Path `/railway.workforce.json`, no public domain, no pre-deploy migration command.
   Both bind Railway's injected PORT. Do not copy the web start command onto the worker.
5. Configure private reference variables below. Keep delivery/model flags off in staging. Set
   `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=35` on both services, longer than the default 25-second
   application drain. Railway's [teardown controls](https://docs.railway.com/deployments/deployment-teardown)
   determine how much time SIGTERM cleanup receives.
6. Disable independent worker autodeploy for the initial rollout. Deploy the web/migration owner
   first with durable background still false. Wait for migration success and web `/ready`.
   Then deploy the same-commit worker with WORKFORCE_WORKER_ENABLED=true and Redis configured.
   Its readiness must pass before enabling ingress delegation.
7. Drain existing legacy background executions, reconcile interrupted PipelineRuns, and enable
   DURABLE_BACKGROUND_ENABLED=true on both services. Keep the old deployment drained before
   sending new test traffic. A short maintenance window is safer than mixed legacy launch modes.
8. Verify authenticated webhook retry, test-tenant schedule restart, queue status and STOP paths.
   Enable existing business/model/delivery flags only after staging certification and approval.
   No production sends, credentials or new organizations are provisioned by these instructions.

Config-as-code remains supported; file values may override dashboard values. Inspect the effective
deployment settings instead of relying on the outdated deprecation sentence in older guides.
See [Railway config-as-code](https://docs.railway.com/config-as-code).

## Safe migrations and rollback

Only the web release owner runs `npm run prisma:deploy` (`prisma migrate deploy`). A failed
pre-deploy blocks the new release; do not start the new worker against an older schema.
This behavior is documented by [Railway pre-deploy commands](https://docs.railway.com/deployments/pre-deploy-command).

The new `20260909180000_production_background_tasks` migration is additive and atomic, with a
five-second lock wait limit. It creates BackgroundTask and indexes/FKs/check constraints. It does
not delete/backfill existing customer records. Earlier unshipped platform migrations must also
be reviewed: do not assume the live database already contains them. Readiness verifies the new
table and rejects unfinished Prisma migrations, but it is not a comprehensive schema-drift audit.

Before release: review `prisma migrate status`, run the populated migration rehearsal and a
backup/restore drill, budget locks/index build time on production-sized data, and reserve database
connections for migrations. Do not run `migrate dev`, `db push`, reset, seed or test scripts against
production. Never edit an already-applied migration. If a migration fails, inspect actual schema
state and the migration record before any reviewed `migrate resolve`; never mark it applied just
to unblock deployment.

Rollback code/flags, not the additive database schema. Pause worker/delivery paths before
rollback; retain pending jobs and audit evidence. Do not flush Redis or drop the new tables. A
rollback to older web code re-enables legacy execution, so reconcile/drain delegated legacy tasks
first. Future incompatible changes should use expand/backfill/verify/contract in separate releases.

## PostgreSQL connections

`src/db/client.ts` keeps one PrismaClient per process. Runtime URLs preserve supplied SSL and pool
options; absent options default to connection_limit=5, pool_timeout=10 seconds and
connect_timeout=5 seconds. DB_CONNECTION_LIMIT (1–50) supplies the pool default; an explicit URL
connection_limit wins. No per-request disconnects. Shutdown drains work before disconnecting.

Use `${{Postgres.DATABASE_URL}}` on both services, replacing Postgres with the actual service name.
Use the private direct connection for migrations; do not introduce PgBouncer until transaction
behavior has been certified. Budget approximately pool × (web replicas + worker replicas), plus
overlapping old/new deploys, migration and operator connections. Start with one web and one worker;
the default is not a promise that any Postgres tier supports arbitrary replica counts. Tune using
pool wait, lock wait, CPU and queue age, not only HTTP throughput. Refer to the installed
[Prisma 6 connection guidance](https://www.prisma.io/docs/orm/v6/prisma-client/setup-and-configuration/databases-connections).

## Environment inventory

Never commit real values; `.env` is ignored. Keep shared encryption keys stable across replicas,
separate staging/production keys, and provision only required provider secrets. The app does not
need GHL credentials unless that optional legacy booking integration is enabled.

| Variables                                                                | Placement / requirement                                                                                                       |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| NODE_ENV                                                                 | Both: production                                                                                                              |
| DATABASE_URL                                                             | Both: private Postgres reference; required                                                                                    |
| PORT                                                                     | Both: injected by Railway; do not copy web's port value                                                                       |
| APP_URL                                                                  | Both for messaging: exact public HTTPS web origin, never worker's private URL; signatures depend on it                        |
| SERVICE_ROLE                                                             | web / worker; log label                                                                                                       |
| LOG_LEVEL                                                                | Both: info normally; never debug private payloads                                                                             |
| REDIS_URL                                                                | Worker: `${{Redis.REDIS_URL}}`, private; required. redis:// or verified-TLS rediss:// supported                               |
| QUEUE_PREFIX                                                             | Worker: steel-scale by default; same across replicas, different for shared-Redis environments; letters/digits/_/- only        |
| WORKFORCE_WORKER_ENABLED                                                 | Worker true; web false                                                                                                        |
| DURABLE_BACKGROUND_ENABLED                                               | Both true after staged cutover; false default preserves legacy behavior                                                       |
| DB_CONNECTION_LIMIT                                                      | Both: default 5, range 1–50; URL pool setting takes precedence                                                                |
| WORKER_BATCH_SIZE                                                        | Worker: default 10, range 1–50                                                                                                |
| SHUTDOWN_TIMEOUT_MS                                                      | Both: default 25000, range 1000–120000                                                                                        |
| RAILWAY_DEPLOYMENT_DRAINING_SECONDS                                      | Railway service setting: 35 for default app drain; increase together                                                          |
| RAILWAY_DEPLOYMENT_ID                                                    | Injected by Railway; structured log label                                                                                     |
| ADMIN_USERNAME, ADMIN_PASSWORD                                           | Web: strong platform-operator Basic Auth; required for admin and operations                                                   |
| CRON_SECRET                                                              | Web: required for authenticated external cron requests                                                                        |
| WORKFORCE_ENABLED, CRM_ENABLED                                           | Both as appropriate: additive workforce and CRM gates                                                                         |
| AGENT_RUNTIME_ENABLED, AGENT_MODEL_ENABLED, AGENT_ALLOWED_MODELS         | Runtime gate, separate paid execution gate and reviewed comma-separated model allowlist; same reviewed config across services |
| AGENT_BUILDER_ENABLED, AGENT_BUILDER_AI_ENABLED, AGENT_BUILDER_MODEL     | Web: builder, paid extraction gate, allowlisted model; no automatic model fallback                                            |
| REVENUE_RECOVERY_ENABLED, REVENUE_RECOVERY_DELIVERY_ENABLED              | Recovery and separate certified-adapter claim gate; share relevant flags across services                                      |
| BUSINESS_KNOWLEDGE_ENABLED                                               | Both: approved organization-knowledge enforcement                                                                             |
| COMMUNICATIONS_ENABLED, COMMUNICATION_DELIVERY_ENABLED                   | Both: canonical ingress/ledger; worker native-send gate. Keep ingress on when pausing sends                                   |
| WEBHOOK_DELIVERY_ENABLED                                                 | Worker: outbound webhook sends; false until certified                                                                         |
| INTEGRATION_ENCRYPTION_KEY                                               | Both: stable 64 hexadecimal characters, required for integration/communication credentials and outbound delivery              |
| TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_SMS_DRY_RUN                | Legacy SMS configuration; web verifies signatures, worker sends delegated replies. Use dry-run in staging                     |
| VAPI_WEBHOOK_SECRET                                                      | Web: authenticate existing inbound Vapi integration                                                                           |
| LLM_PROVIDER, LLM_MODEL                                                  | Existing interactive chatbot/SMS provider configuration; mock in tests only                                                   |
| OPENAI_API_KEY, ANTHROPIC_API_KEY                                        | Only for configured paid provider/features; worker needs the configured legacy SMS/runtime provider key                       |
| LEAD_ANALYST_MODEL                                                       | Existing web admin analyst model override                                                                                     |
| GHL_API_KEY, GHL_LOCATION_ID, GHL_FALLBACK_CALENDAR_ID, GHL_API_BASE_URL | Optional existing GHL booking/calendar integration; base URL defaults to services.leadconnectorhq.com                         |
| BOOKING_DELIVERY_DRY_RUN                                                 | Existing booking sends; true for staging/tests, enable live only after certification                                          |
| SLACK_WEBHOOK_URL                                                        | Existing notifications/reports; configure on any process executing those flows                                                |
| LEAD_PIPELINE_CAMPAIGNS_JSON                                             | Worker for delegated cron campaigns; legacy web if delegation off; default []                                                 |
| OUTSCRAPER_API_KEY, OUTSCRAPER_API_BASE_URL                              | Optional discovery provider; default api.outscraper.com; worker and legacy provider admin paths as needed                     |
| APIFY_API_TOKEN, APIFY_API_BASE_URL                                      | Optional discovery provider; default api.apify.com/v2                                                                         |
| APIFY_ZILLOW_SEARCH_ACTOR_ID, APIFY_ZILLOW_DETAIL_ACTOR_ID               | Existing optional real-estate discovery overrides, not canonical workforce requirements                                       |
| WEBSITE_CHATBOT_CLIENT_ID                                                | Web: explicit legacy chatbot tenant; verify rather than relying on seeded default UUID                                        |
| DEMO_ENGINE_ENABLED, DEMO_AI_ENABLED, DEMO_VOICE_ENABLED                 | Web: optional demo and separate paid model/live voice gates                                                                   |
| DEMO_OPENAI_API_KEY, DEMO_CHAT_MODEL, DEMO_VOICE_MODEL                   | Web: optional demo-specific overrides; shared provider key fallback remains existing behavior                                 |

VAPI_API_KEY remains an unused example placeholder, not a deployment requirement. Feature flags
are exact `true` strings. Do not copy this table wholesale with placeholder credentials or enable
all features just to pass health checks. `/ready` does not certify provider credentials or consent.

## Health, logs and operator visibility

- Both services: `/health` is liveness; `/ready` checks database connectivity, required deployment
  table, unfinished migrations and shutdown state. Worker additionally checks Redis and recent
  successful canonical lane progress (three minutes). Long-running legacy lanes are excluded
  from that progress threshold; monitor their task age/one-hour lease explicitly.
- Probes coalesce dependency calls, briefly cache results and return within about two seconds.
  No credentials, dependency URLs, job payloads or stack traces are returned. While draining,
  probes return 503; no new worker batch is started.
- Railway's configured `/ready` check gates a deployment, not continuous runtime monitoring.
  Add external monitoring of web readiness and a private probe/alert for worker readiness,
  plus DB/Redis availability. See [Railway healthchecks](https://docs.railway.com/deployments/healthchecks).
- `/admin/operations` is read-only JSON behind existing **platform** admin authentication, not an
  organization-admin endpoint. It reports per-status queue counts, oldest pending event time and
  recent failed/unknown BackgroundTask IDs with scope/correlation IDs. It exposes no task bodies.
- From the private worker shell, `npm run ops:queues` reports BullMQ counts and recent retained
  failure IDs without payloads. There is deliberately no unauthenticated Bull Board or replay API.
- Pino emits JSON in production with service, role and deployment ID. Agent logs include
  organizationId, agentId, runId, eventId, correlationId and subjectId; selected context adds
  contactId/opportunityId where present. No model reasoning/context bodies are logged. DB audit
  records remain authoritative if a transaction rolls back after a diagnostic log entry.

Alert on growing overdue-job age, dead/unknown outcomes, failed BullMQ ticks, missed worker
progress, Redis memory/eviction/write errors, database pool exhaustion and repeated crash loops.
Investigate errors using correlationId → BusinessEvent → AgentRun/Step/Action → delivery attempts.
Apply access controls and retention to logs; IDs can still identify customer activity.

On Redis outage: leave web ingestion enabled if PostgreSQL is healthy, pause delivery if needed,
restore Redis connectivity/persistence and inspect queues. If Redis state was lost entirely,
restart the worker to re-upsert schedulers; pending customer work is recovered from PostgreSQL.
Do not replay accepted/unknown messages. On DB outage, ingress must fail/retry instead of acking
unstored work. On SIGTERM, active work drains until the deadline; remaining leases survive for
domain-specific recovery. Do not increase Railway restart count to hide deterministic failures.

## Verification and release gate

See [local verification results](DEPLOYMENT_VERIFICATION.md) for the tested changes and limits.

Use only an explicit loopback test database whose name matches steel_scale_demo_*test and a
loopback test Redis. The migration rehearsal requires a NEW empty database and inserts historical
fixtures before upgrading; it never resets a database. The regression runner seeds fictional
data and disables real providers. Never run these commands in a Railway production shell.

```bash
npm ci
npm run prisma:generate
npm run typecheck
npm run lint
npm run build
npm run format:check
# Set NODE_ENV=test, DATABASE_URL and REDIS_URL to isolated local services first:
npm run test:crm:migration
npm run test:regressions
npm run test:deployment:redis
npm run test:deployment:process
```

The production process test runs compiled web/worker entry points with external sends/models
disabled. Follow it with a staging smoke test under your actual Railway Node version, service
variables, private networking, rolling-deploy overlap and real provider sandbox accounts. Live
provider behavior, load capacity and backup recovery are release gates, not claims of local tests.
