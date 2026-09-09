# Steel Scale Systems architecture

Inspection and foundation implementation: September 8, 2026.

## Deployment increment: durable web/worker split

`src/platform/` owns operational infrastructure, not agent permissions. BullMQ/Redis schedules
bounded worker lanes over existing PostgreSQL event/job/action/delivery stores; PostgreSQL remains
the transactional source of truth for customer work and follow-up deadlines. The new additive
BackgroundTask outbox delegates legacy SMS, lead pipelines and authenticated cron requests when
DURABLE_BACKGROUND_ENABLED is enabled. Unknown legacy side effects require reconciliation.
Web and worker expose separate readiness probes and drain on shutdown. See
[deployment architecture and operations](DEPLOYMENT.md) for exact rollout order, environment
inventory, migration ownership, failure semantics and remaining request-bound legacy behavior.

## Current increment: natural-language Agent Builder

`src/agent-builder/` is a separate authoring domain over the existing runtime. A strict,
versioned `AgentBlueprint` retains proposed trigger/eligibility/delay/cadence, permissions,
escalation, channels, goals, stop rules, hours, knowledge and missing configuration.
Descriptions are extraction input only, not production system prompts. Owners edit visual
sections, save immutable versions, run a side-effect-free policy preview and explicitly review
the exact version before activation. Organization-bound generation reservations prevent
duplicate model calls; compiler and definition hashes bind tests to activation.

The deterministic compiler rejects unsupported semantics instead of dropping constraints.
The 48-hour estimate/amount/pricing example can be drafted and reviewed but remains blocked
until the runtime can enforce its requested behavior. Supported configurations activate through
shared existing runtime service transaction helpers; no new execution or authorization path
is introduced. Draft edits leave the existing enabled runtime version untouched.

Four additive organization-owned tables store blueprint identities, versions, tests and
generation receipts, with composite tenant foreign keys. `/agent-builder` uses the existing
member-key UI bridge and signed forms; `/api/agent-blueprints` uses scoped bearer credentials.
`AGENT_BUILDER_ENABLED` and the independent paid `AGENT_BUILDER_AI_ENABLED` default false.
The existing OpenAI Responses transport is shared, with strict schema output and local validation.

See [contract, limits, API and rollout](AGENT_BUILDER.md) and
[verification](AGENT_BUILDER_VERIFICATION.md).

## Previous increment: universal AI agent runtime

`src/agents/` adds a domain-agnostic, version-pinned runtime with strict model decisions,
an explicit tool registry, independent server policy, tenant-bound context, bounded leased
steps, exact-action approvals, finite schedules and action/result journals. Model I/O is
outside database transactions; native CRM effects, receipts, audit and canonical completion
facts commit atomically. Administrative stopping and changed context fence stale proposals.

The logical Agent reuses `WorkforceAgent` with `kind: universal`; existing deterministic
recovery agents and their opportunity-specific execution journals are untouched. New
`AgentVersion`/`AgentRun`/`AgentAction` structures avoid weakening those legacy constraints.
Version-specific goals, subscriptions, policy, permissions and escalation rules are derived
from one validated definition. Step snapshots provide context without a second model-writable CRM.

The existing worker admits canonical events and schedules, then runs one bounded decision
per claim. Both `AGENT_RUNTIME_ENABLED` and paid `AGENT_MODEL_ENABLED` default false. The
deployment-reviewed model allowlist is separate from organization-controlled definitions.
There is no arbitrary provider URL, application-function lookup or freeform tool parser.

Internal tools reuse CRM validation and event publication. Message sending and appointment
booking have typed contracts but deliberately unavailable executors until consent-aware,
idempotent delivery adapters exist. Agent completion is not financial attribution. No
production agent is automatically switched to the new runtime and no old event is replayed.

See [agent contracts, API, safeguards and rollout](AGENT_RUNTIME.md) and
[verification](AGENT_RUNTIME_VERIFICATION.md).

## Previous increment: universal Zapier/generic webhooks

`src/integrations/` adds versioned, connection-authenticated intake, bounded field-path
mapping, atomic related-record imports, redacted diagnostics and PostgreSQL organization
rate limits. `/api/integrations/webhooks/events` resolves tenant/connection only from a
hashed credential; the connection-specific URL additionally checks its path identity.
It composes the existing canonical intake/CRM services rather than duplicating CRM rules.

Canonical publication transactionally snapshots outbound subscriptions into a dedicated
delivery outbox. Network sending is outside the transaction, uses pinned public HTTPS,
HMAC signatures, stable delivery IDs, leases, exponential retry and retained dead-letter
records. URLs/signing secrets are encrypted at rest. The workforce worker reuses its
existing deployment but sending requires `WEBHOOK_DELIVERY_ENABLED=true` explicitly.

`/integrations` is organization-admin authenticated; `/admin/integrations` is a separate
operator surface. Both reuse existing server-rendered styles and signed CSRF forms.
There is no new customer SSO layer. Agent handoff/action/recovery facts are produced by
their existing approval/evidence services; webhook receipt does not claim external action
completion or revenue. Existing GHL and legacy booking/availability paths remain unchanged.

See [Zapier setup, contracts and security](ZAPIER_INTEGRATION.md) and
[verification](ZAPIER_VERIFICATION.md). This additive migration does not remove historical
records. New endpoints do not replay old events, and incoming/outgoing loops are suppressed
by default. At-least-once network delivery still requires receiver deduplication.

## Previous increment: universal events

`src/events/` now owns the canonical v2 event contract, publisher, router, handler registry,
external intake receipts and isolated GHL translation. CRM mutations publish committed
facts and durable jobs atomically; workers dispatch canonical events with transactional
handler receipts. Legacy v1 intake and existing GHL booking/availability remain supported.
The additive migration preserves historical event rows. GHL is optional, and its new
inbound endpoint is an authenticated relay, not a native public signature receiver.

See [event architecture and examples](EVENT_ARCHITECTURE.md) and
[event verification](EVENT_VERIFICATION.md) for the current contract, delivery guarantees,
tenant safeguards, limits and rollout. Earlier sections below describe prior increments.

## Previous increment: canonical CRM

The second increment extends the inspected architecture below without replacing legacy
booking, prospecting, demos or the workforce runtime. `src/crm/` now owns native CRUD,
tenant-scoped repositories, configurable pipelines, contact/company/opportunity/estimate
and activity models, assignments, typed custom fields and external mappings. `/admin/crm`
reuses the existing internal admin design and auth; `/api/workforce/crm` uses scoped bearer
credentials. Both require the additional `CRM_ENABLED` flag, default false.

The foundation's six Prisma names are now canonical (`OrganizationMember`, `Contact`,
`Opportunity`, `ExternalConnection`, `BusinessEvent`, `AuditLog`) while `@@map` preserves
existing SQL tables and IDs. The earlier architecture inventory below remains historical
context. Native data no longer requires source/external IDs. The v1 import envelope remains
compatible through mappings, and native opportunity events feed the existing runtime.

See [canonical model and migration decisions](CANONICAL_DATA_MODEL.md),
[CRM API/UI contract](CRM_API.md), and [CRM verification](CRM_VERIFICATION.md) for the
current implementation, safety constraints and rollout instructions.

## Existing production architecture

The repository is a modular Node.js application, not a Next.js or React application. It
uses Express 5, TypeScript 5 with strict mode, `NodeNext` module resolution, and ES2022
output. `src/app.ts` composes routers; `src/server.ts` listens and handles shutdown.
`npm run build` emits `dist/`; Railway starts `dist/server.js`. The frontend consists of
server-rendered admin HTML, static marketing pages, a JavaScript chatbot widget, and the
separate demo experience. The demo-builder directory contains historical overlay/scaffold
files; it is not a second production application.

Prisma 6 generates one PostgreSQL client (`src/db/client.ts`). The actual schema uses
PostgreSQL UUIDs, JSON, arrays and decimals; old prose mentioning SQLite does not describe
the implemented datastore. Type checking covers application, Prisma seed and scripts
projects. ESLint and Prettier are configured. Tests include executable integration scripts
and Node's test runner; there was no single general `npm test` command or CI workflow.

| Boundary             | Existing behavior and storage                                                                                                                                                                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client configuration | `Client` is the existing tenant/configuration root. Phone number is globally unique. Destinations and voice settings are separate one-to-one records.                                                                                                                                                                       |
| Booking              | Voice, chatbot and SMS create `BookingAttempt` records. Delivery retries the configured Zapier or GHL destination, then tries the global GHL safety calendar. Failures retain delivery history and trigger manual follow-up/alerts.                                                                                         |
| Availability         | Per-client Zapier request/callback with hashed callback token and expiry, or GHL calendar lookup. This is external calendar availability, not an internal calendar.                                                                                                                                                         |
| Telephony            | Twilio missed-call text-back, inbound SMS conversations and opt-outs; Vapi assistant configuration, call logs, booking tools and owner transfer. The schema permits Retell but no equivalent full Retell runtime was found.                                                                                                 |
| Admin                | Shared environment-backed HTTP Basic credentials. Client setup, lead import/search/dashboard, scoring, delivery and call queue. No user accounts, organization membership, login sessions or customer portal existed.                                                                                                       |
| Lead intelligence    | Client-scoped business prospects/contacts/leads, source versions, ingestion, website enrichment, deterministic offer scoring/recommendations, real-estate listing intelligence, outreach permissions, delivery campaigns and operator call queue. These are prospecting records, not service customers and their estimates. |
| Existing AI          | OpenAI/Anthropic/mock chatbot provider with booking tools; Vapi voice agent prompts; OpenAI evidence-based lead analyst; demo-only chat and Realtime voice with separate sessions and flags. There was no general agent runtime or organization policy engine.                                                              |
| Background work      | Lead pipeline runs persist status/heartbeat but launch with `setImmediate` and an in-memory active set. Startup resumes interrupted runs. Authenticated cron endpoints invoke daily summaries and discovery pipelines. No general durable job queue existed.                                                                |
| Demos                | Explicit operator draft/review/publish; standalone demos can exist without a Client. Private inputs, public share tokens, engagement events and live sessions are separate. Demos never constitute production onboarding, CRM records or revenue evidence.                                                                  |
| Observability        | Pino application logging, booking/provider attempts, outreach history and Slack/owner alerts. No universal event ledger or organization-wide approval/audit system existed.                                                                                                                                                 |

Route inventory: `/admin` and its client/lead/search/import/call-queue/demos routes,
`/demo`, `/chatbot`, `/internal/bookings`, `/internal/availability/zapier/:requestId`,
`/internal/cron/daily-summary`, `/internal/cron/lead-intelligence`, `/webhooks/twilio`,
`/webhooks/vapi`, `/health`, `/widget`, `/assets`, and marketing routes.

Railway configuration uses Railpack, `npm run build`, a pre-deploy
`npm run prisma:deploy`, `npm run start`, `/health`, and restart-on-failure. `/health` is a
process check, not a database/queue readiness check. There is no repository-defined worker
service or Dockerfile. Production Railway settings and data were not queried or changed.

Configuration is mostly loaded by `src/config/env.ts` via dotenv; demos and pipeline
campaign settings also read process variables directly. `.env.example` documents the
public contract; secret values in `.env` were not used to operate production integrations.

| Environment group    | Variables                                                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime/database     | `DATABASE_URL`, `NODE_ENV`, `PORT`, `APP_URL`, `LOG_LEVEL`                                                                                                       |
| Admin/scheduling     | `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `CRON_SECRET`, `LEAD_PIPELINE_CAMPAIGNS_JSON`                                                                                |
| Telephony            | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_DRY_RUN`, `VAPI_WEBHOOK_SECRET`; setup also documents `VAPI_API_KEY`                                      |
| Booking              | `BOOKING_DELIVERY_DRY_RUN`, `GHL_API_KEY`, `GHL_LOCATION_ID`, `GHL_FALLBACK_CALENDAR_ID`, `GHL_API_BASE_URL`; per-client Zapier URLs live in `ClientDestination` |
| AI                   | `LLM_PROVIDER`, `LLM_MODEL`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `LEAD_ANALYST_MODEL`                                                                         |
| Discovery            | `OUTSCRAPER_API_KEY`, `OUTSCRAPER_API_BASE_URL`, `APIFY_API_TOKEN`, `APIFY_API_BASE_URL`, `APIFY_ZILLOW_SEARCH_ACTOR_ID`, `APIFY_ZILLOW_DETAIL_ACTOR_ID`         |
| Notifications/widget | `SLACK_WEBHOOK_URL`, `WEBSITE_CHATBOT_CLIENT_ID`                                                                                                                 |
| Demo                 | `DEMO_ENGINE_ENABLED`, `DEMO_AI_ENABLED`, `DEMO_VOICE_ENABLED`, `DEMO_OPENAI_API_KEY`, `DEMO_CHAT_MODEL`, `DEMO_VOICE_MODEL`                                     |
| New foundation       | `WORKFORCE_ENABLED`, `WORKFORCE_WORKER_ENABLED`; both default false                                                                                              |

## Reuse, conflicts and incremental refactoring

Reuse the server, Prisma/PostgreSQL, migration pipeline, authentication utility for
operator bootstrap, provider wrappers, and the lead-intelligence pattern of typed adapters,
deterministic policy, source identity, idempotency and evidence. Production booking, SMS,
call queue, demos and prospecting retain their current behavior.

Do not rename `Client`, reinterpret prospecting `Lead` as a homeowner/customer, move demo
data into tenant CRM records, or route new agents through the existing booking fallback.
The workforce domain has no GHL import, credential requirement or fallback. A `ghl` provider
value is reserved; new workforce GHL normalization is not implemented. Existing GHL
booking and qualified-lead adapters remain operational in their existing boundaries.

Existing debt found during inspection:

- Shared admin Basic credentials are operator access, not customer identity/RBAC. Several
  legacy admin operations address rows by ID without tenant authorization because they are
  platform-wide operator features. Never expose those routes as a customer API.
- `/internal/bookings` has no authentication middleware. Twilio voice-status does not call
  the signature validator used by the SMS route. Vapi accepts requests if its secret is
  absent. These are existing security gaps; changing production webhook contracts requires
  a coordinated integration rollout and is a separate urgent hardening step.
- Many routes/services import the global DB client, couple delivery to business logic, and
  use synchronous retries. An external request can succeed before its outcome is persisted;
  this cannot be solved by claiming exactly-once delivery.
- Legacy background pipeline ownership is process-local; replicas can resume the same run.
  Migrate each workflow separately to durable claims after proving replay semantics.
- Existing migrations have documented index-name/FK drift. Prior verification also records
  failures in lead-intelligence phase 5 (fixed-date fixture) and phase 9 (pipeline replay).
  Do not silently rewrite historical migrations or include unrelated repairs in this one.
- Existing logs and some JSON columns can contain customer/provider data. The new HTTP
  boundary avoids generic request logging, and Prisma errors for private domains are redacted.
  Audit retention, encryption, database access controls and legacy logging need further work.

## Added domain boundaries

`src/workforce/` is an additive module with explicit dependencies:

```text
HTTP authentication -> tenant principal -> application operations
integration adapter -> canonical event -> CRM projection + event + queued job (one transaction)
worker -> agent runtime -> policy -> proposed action + approval + audit (one transaction)
human decision -> current policy recheck -> internal handoff + audit (one transaction)
operator payment evidence -> assisted revenue attribution, grouped by currency
```

| Directory       | Responsibility                                                                           |
| --------------- | ---------------------------------------------------------------------------------------- |
| `tenancy/`      | Organization bootstrap, membership role checks, scoped hashed credentials                |
| `crm/`          | Internal customer/opportunity projection; source identity and stale observation handling |
| `events/`       | Versioned event validation, replay detection and transactional outbox intake             |
| `integrations/` | Zapier/generic normalization into domain events; no provider business rules in runtime   |
| `agents/`       | Versioned configuration proposal boundary and deterministic recovery evaluation          |
| `policy/`       | Deny-by-default action policy, suppression and mandatory human review                    |
| `tools/`        | Explicit registry of validated actions; initial internal handoff only                    |
| `jobs/`         | PostgreSQL claims, leases, fencing, retries/dead letters and hourly scan scheduling      |
| `approvals/`    | Single-use expiring review decisions and revalidation before execution                   |
| `audit/`        | Transactional append-only application audit records                                      |
| `revenue/`      | Explicit payment evidence linked to a completed action and won opportunity               |
| `http/`         | Bounded JSON API, trusted tenant context, safe errors and scoped queries                 |

No new package/service dependency is required. Prisma transaction clients are passed into
domain operations. The HTTP module and standalone worker are composition roots. Pure
contracts, policies and tools do not import Express, legacy booking code, or provider SDKs.

### Data and tenancy decisions

The migration adds `Organization`, `OrganizationMembership`, and 12 `Workforce*` tables.
`Organization.legacyClientId` is an optional unique link to `Client`. Existing Client rows
are not updated and have no new required fields. Standalone organizations need no telephone
number, GHL account or legacy Client. Linking is an explicit operator action, not an automatic
backfill, and does not confer access to legacy admin endpoints.

All new tenant records have an organization FK. Cross-record relationships include
`organizationId` in composite foreign keys to enforce tenant consistency in PostgreSQL.
Deletion is restrictive, not cascading. Credentials have exactly one membership/integration
owner, enforced by a SQL CHECK. Money uses integer minor units plus currency, never floating
point amounts; nonnegative opportunities and positive payment evidence are DB CHECKs.

Tenant isolation combines authenticated query scoping and FK enforcement. PostgreSQL RLS
is **not** enabled; the shared application DB role can access all tenants. Future code must
continue to scope queries, and direct database credentials remain privileged.

Mutation transactions lock the organization's row, serializing foundation operations for
that tenant across replicas. This deliberately favors simple correctness at initial scale.
No model/provider/network calls occur while holding this lock. Higher throughput should
introduce narrower record locks after measuring contention; do not put slow tools inside it.

### Identity and HTTP contract

`/api/workforce` is disabled unless `WORKFORCE_ENABLED=true`. It is a machine JSON API,
not a finished portal: no cookies, CORS, signup, password storage, sessions or self-asserted
tenant headers. Browser Origin requests are rejected. Body limit is 32 KB. All responses
use no-store. Read endpoints return at most 100 records; pass the last ID as `?after=...`
where supported. This is ID pagination, not chronological ordering.

Only `POST /organizations` uses existing operator Basic authentication. Its body is
`{name, ownerSubject, legacyClientId?}`. `ownerSubject` is an operator-provisioned opaque
identity reference, not a verified external login. Bootstrap returns the organization,
a 90-day owner bearer credential, its ID and expiry. Tokens are cryptographically random,
stored only as SHA-256 hashes, and returned only when issued or rotated. Use HTTPS and
store the returned token securely. Lost/expired owner credentials currently require a
trusted operator provisioning procedure; a self-service recovery flow is not implemented.

Every subsequent request authenticates its bearer token and active membership/integration.
The organization and actor come exclusively from that credential. Membership roles and
credential scopes are both checked. Integration credentials are intake-only and cannot
read CRM data, configure agents or approve actions. Human decisions require owner/admin.

| Method/path under `/api/workforce`        | Contract                                                                                |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET /organization`                       | Current organization identity                                                           |
| `POST /integrations`                      | `{name, provider: "zapier"                                                              | "generic_webhook"}`; returns integration ID and intake token |
| `POST /credentials/:id/rotate`            | `{}`; atomically replaces a credential and revokes the old one                          |
| `POST /credentials/:id/revoke`            | `{}`; revokes tenant-owned credential                                                   |
| `POST /webhooks/:integrationId`           | Integration token plus canonical event; 202 accepted, 200 duplicate                     |
| `POST /customers`, `POST /opportunities`  | Human CRM-write token plus matching canonical upsert event; internal source             |
| `GET /customers`, `GET /opportunities`    | Organization-scoped records, ID pagination                                              |
| `POST /agents/propose`                    | `{description}`; template defaults with explicit provenance and review requirement      |
| `POST /agents`                            | `{name, description, config}`; always creates disabled recovery agent                   |
| `PATCH /agents/:id`                       | `{expectedVersion, enabled, config?}`; optimistic version check; increments version     |
| `GET /agents`                             | Current organization's agent configuration                                              |
| `POST /recovery/scan`                     | `recovery.scan.requested` envelope with empty data; queues explicit scan                |
| `GET /approvals`                          | Review records and their action/input/result, ID pagination                             |
| `POST /approvals/:id/decision`            | `{decision: "approve"                                                                   | "reject", reason}`; final decision and execution result      |
| `GET /events`, `/runs`, `/jobs`, `/audit` | Tenant-scoped diagnostic records, ID pagination                                         |
| `POST /jobs/:id/retry`                    | `{reason}`; audited reset of a dead job only                                            |
| `POST /revenue`                           | `{opportunityId, actionId, externalPaymentId, amountMinor, currency, evidence, paidAt}` |
| `GET /revenue`                            | Operator-reported assisted payment totals grouped by currency                           |

Unknown input fields, invalid dates/IDs/money, unsupported event/config versions and tools
are rejected. A token never accepts a tenant ID from the webhook body. Mutation HTTP errors
contain stable codes rather than raw Prisma errors or customer/provider payloads.

### Canonical events and CRM

Version 1 envelope: `{id, version: 1, type, occurredAt, data}`. `id` must remain stable across
provider retries. `occurredAt` must be timezone-qualified and reflect the source observation.
Use a new ID for a real update. Duplicate keys are `(organization, source, externalId)`;
reusing an event ID with changed normalized content returns 409. Canonical hashing ignores
JSON object key order. Source is server-assigned: `internal`, integration ID, or `scheduler`.

Customer data: `{externalId, name, email?, phone?, doNotContact?}`. Opportunity data:
`{externalId, customerExternalId, title, status, amountMinor, currency, lastActivityAt}`.
Statuses: `open`, `estimate_sent`, `won`, `lost`. Import the customer first in the same
source namespace. Missing customer returns 409 without committing event/job/CRM state;
retry after importing the customer. Amounts are integers in the currency's minor unit.

Older/equal source timestamps do not overwrite current state. Ignored events are retained
in the ledger with an audit explanation but do not enqueue evaluation. Suppression is sticky:
webhooks cannot clear `doNotContact`. Missing optional contact fields preserve existing data.
Customer identity and currency cannot change on an existing opportunity. Cross-source identity
merging, email/phone deduplication, contact deletion/clearing, consent grants and conflict
resolution are future explicit workflows. No historical prospect/customer data is auto-imported.

### Agent, approval and job behavior

Recovery config v1 is `{version:1, staleAfterDays:7, maxCandidates:50,
allowedTools:["recovery.prepare_handoff"], requireApproval:true}`. Bounds are 1–365 days
and 1–100 candidates. At most 20 agent records can be created per organization via the API.
The optional `AgentConfigCompiler` interface validates untrusted model output; no real model
compiler is wired yet. Descriptions are stored and template proposals are labeled honestly.

Enabled agents evaluate open/unsold opportunities with old activity, no suppression and no
previous recovery action. Hourly scans catch opportunities that become stale without new
webhooks. Opportunity events also trigger a bounded tenant scan. Each run snapshots config,
candidate IDs, cutoff, limits and deterministic rationale. Each job is capped at 100 proposals
total across up to 20 agents, evaluated in creation order. A bounded batch leaves remaining
candidates for the next scan. Initial policy allows **one** recovery proposal per opportunity
across recovery agents, including rejected/expired proposals. Multi-step cadences and re-entry
are intentionally deferred. Imported duplicate people in different source namespaces can
still need identity reconciliation before live delivery is enabled.

The only registered tool prepares an internal handoff. Proposals do not send SMS/email,
call customers, change estimates, make bookings or invoke paid models. Approvals expire in
seven days. Decisions are serialized, single-use and audited. Execution rechecks current
agent enablement/version, opportunity status/activity, customer suppression and record
changes since proposal; stale or prohibited actions are blocked. Approved handoff results
explicitly say `deliveryStatus: "not_sent"`. Completion means the internal artifact exists,
not that customer contact occurred. Consumers must inspect `executed` and the returned
approval status, including when an approval request is blocked and returns HTTP 200.

PostgreSQL `FOR UPDATE SKIP LOCKED` atomically claims jobs. A UUID lease token fences old
workers after a 60-second lease expires. DB-only evaluation, audit/action writes and job
completion commit together. Failure rolls back partial decisions; retries use exponential
backoff capped at five minutes, with five evaluation attempts and dead-letter records.
An exhausted crashed lease is marked dead on reclamation. No in-memory queue is required.
The worker handles shutdown by finishing its current bounded operation. It does not start
inside the HTTP process or alter the existing lead pipeline scheduler.

This is at-least-once scheduling with idempotent persisted decisions, not an exactly-once
claim for external effects. Before adding real send tools, implement delivery attempts,
provider idempotency, consent/channel permissions, stop-on-reply, rate limits, quiet hours,
receipts and reconciliation for ambiguous timeouts. Do not retry an uncertain send blindly.

### Revenue evidence

Payment evidence is explicit owner/admin input linked to a completed action and the same
won opportunity. Currency must match, and payment must be after action completion. Unique
organization/payment IDs prevent duplicate credit, including credit to multiple agents.
Totals are separated by currency. This is **operator-reported assisted revenue**, not verified
causal recovery, collected payments from a provider, or incremental lift. No estimate amount,
demo ROI scenario or approval automatically creates revenue. Refunds, reversals, payment
provider verification and attribution windows are future work; do not treat this as accounting.

## Safe migration and rollout

1. Keep both workforce flags false. Review the schema-only additive migration and take a
   Railway PostgreSQL backup using your existing operational process. Confirm restored
   backup behavior in staging before enabling tenants.
2. Apply migrations to an isolated/staging DB. The new migration creates only new tables,
   enums, indexes, FKs and CHECKs; it performs no old-table alterations, renames, deletes,
   backfills or updates. It is wrapped in a transaction with a five-second lock timeout.
   A failed lock acquisition rolls back rather than holding production locks indefinitely.
   Historical migrations are unchanged. Prisma's schema diff does not encode custom CHECKs.
3. Railway's existing pre-deploy command will apply the migration when this code is deployed.
   No deploy was performed for this implementation. If a migration fails, investigate its
   Prisma record and transaction result before following Prisma's failed-migration recovery
   workflow. Never run `migrate reset`, `db push --accept-data-loss`, or the seed against production.
4. Enable `WORKFORCE_ENABLED=true` in staging and provision a test organization via the new
   machine API. Existing Clients do not need linking or conversion. Verify tenant isolation,
   CRM imports, review decisions and legacy bookings/demos.
5. After the web migration succeeds, provision a separate Railway worker service from the
   same source/build, selecting `railway.workforce.json` as its configuration file. Use the
   shared `DATABASE_URL` and set both workforce flags true. The config runs
   `npm run start:workforce-worker` without an HTTP healthcheck or migration command.
   Remove any inherited HTTP healthcheck/pre-deploy overrides in the worker's service
   settings: it does not listen on `/health`, and migrations belong to the web release.
   The existing `railway.json` is unchanged and describes the web service only.
6. Enable one pilot organization/agent. Monitor pending/dead jobs, audit/run decisions and
   approval expiry. Check the unsent handoff with an operator before adding delivery tools.
7. Roll back behavior by disabling the API flag and stopping/disabling the worker service.
   Keep additive tables and evidence. Disabling the web flag alone does not stop a separately
   configured worker. An in-flight worker transaction may finish during graceful shutdown.
   Do not drop tables to roll back application behavior.

## Verification and next step

### Business member workspace

`src/workspace` is a bounded, tenant-scoped read projection over existing CRM,
Recovery, knowledge, approvals and integrations. It supplies launch guidance,
oldest-first personal/unassigned handoffs and explicit period/currency recovery
reporting. It is not another runtime, policy engine or worker health check.
Knowledge is verified through the existing retrieval boundary; simulations count
only against their exact current configuration.

`/workspace/crm` and `/admin/crm` share one CRM router factory and service. The
member router resolves the current member principal and never accepts an
organization selector or synthesizes operator access. Signed forms, permissions,
optimistic versions, canonical events and audit writes are retained. There is no
new migration or live-delivery setting. See [PRODUCT_WORKSPACE.md](PRODUCT_WORKSPACE.md)
for review findings, financial definitions, rollout and commercial priorities.

### Provider-independent communication (2026-09-08)

`src/communications` reuses canonical CRM messages/conversations and the working Twilio SMS
transport behind MessageProvider/SmsProvider/EmailProvider interfaces. Four additive scoped
tables hold encrypted account configuration, delivery evidence, attempt history and address
suppression. Native member sends use the existing workforce worker; agent Recovery dispatches
retain exact-action approval and their existing adapter claim/receipt boundary while writing
the universal ledger. No GHL messaging implementation existed; GHL booking support remains intact.

Canonical inbound publication records suppression before jobs run. Linked legacy Clients bridge
SMS into canonical records without automatic tenant conversion. Provider acceptance never becomes
delivery credit. Unknown outcomes are retained without automatic resend. New flags default off;
the native-send flag is not a switch for legacy Twilio or Recovery adapter traffic. See
[COMMUNICATIONS.md](COMMUNICATIONS.md) for contracts, failure semantics and rollout limits.

### Business Knowledge (2026-09-08)

`src/knowledge` adds sources, immutable documents, reviewed entries and immutable versions
with composite organization/provenance foreign keys. The additive migration also adds
Organization.knowledgeRevision without converting existing business records. The default-off
API/admin portal reuse workforce authentication, transaction locks, audit and rate limits.
Public retrieval excludes drafts, inactive/foreign/internal facts and cites exact versions.
Knowledge never grants permissions; restricted references cannot become automatic promises.

The runtime gains an explicitly permitted read tool and revision-aware context fencing.
Recovery can pin exact reviewed public versions and rechecks them at send boundaries. With
knowledge enabled, unbound legacy recovery text fails closed, not silently approved. Legacy
booking/chatbot prompt paths remain unchanged. Text/Markdown documents require excerpt review;
no remote fetch, embedding or model ingestion was introduced. See
[BUSINESS_KNOWLEDGE.md](BUSINESS_KNOWLEDGE.md) for limits and rollout sequencing.

### Revenue Recovery specialization (2026-09-08)

`src/recovery` now specializes the generic universal Agent Runtime through a registered
DecisionProvider and two allowlisted tools, not a second freeform loop or a vendor-specific
agent. Reviewed configuration lives on immutable AgentVersion.specialization. Canonical
events and the existing worker's bounded scanner admit tenant-scoped cases. Structured
classification is normalized to approved organization text; all external dispatches retain
the existing Policy Engine and exact HumanApproval boundary. Handoffs pause messaging,
and reviewed financial attribution is separate from delivery/activity evidence.

The additive recovery migration introduces Organization.active (existing rows default true),
AgentVersion.specialization and eight scoped recovery tables with composite foreign keys
and dispatch/receipt uniqueness. No legacy models or routing were removed. Both recovery
feature flags default off. Delivery requires a separately certified claim/receipt adapter;
this change does not activate a native SMS/email sender. See [REVENUE_RECOVERY.md](REVENUE_RECOVERY.md)
for the data contract, operating limits, rollout boundaries and adapter protocol.

See [WORKFORCE_VERIFICATION.md](WORKFORCE_VERIFICATION.md) for actual check results.
`npm run test:workforce` is DB-free. Integration tests and `npm run test:regressions` require
an explicit `NODE_ENV=test` loopback PostgreSQL URL with a database name matching
`steel_scale_demo_*test`. They refuse other targets before loading dotenv/app. Regression
runner overrides provider secrets and uses mock/dry-run/local stub integrations. The seed
is test setup only. Tests leave fictional workforce records in the disposable database.

Next implementation milestone: a customer identity/membership flow and a small CRM/approval
portal over this API, followed by one consent-aware recovery delivery adapter. The portal
requires an authenticated browser-session/CSRF design before relaxing the machine API's
Origin rule. Add a real natural-language compiler only as a reviewed proposal generator;
it must not expand permissions or enable agents on its own. Then bridge one legacy event
producer at a time with an outbox, explicit mapping and rollback controls. Move GHL behind
the optional integration contract only after existing booking acceptance tests pass for
each migrated customer.
