# Deployment verification

Local verification on September 8, 2026. No Railway deployment, live database migration,
production credential changes, live SMS/email or paid model calls were performed. Existing
uncommitted platform increments were preserved.

## Changes in this increment

- BullMQ 5 and its lockfile dependencies; eight independent worker lanes over PostgreSQL's
  existing durable canonical jobs/deadlines, with persistent Redis schedulers, retries/backoff,
  global lane concurrency, stalled detection and retained failed wake-ups.
- Additive BackgroundTask model/migration and legacy SMS/pipeline/cron delegation behind
  DURABLE_BACKGROUND_ENABLED. Client/organization scope, scoped deduplication keys, payload
  hashes, correlation IDs, leased execution and visible unknown outcomes. Completed payloads
  are cleared. Pending PipelineRun outbox gaps are reconciled without relaunching web work.
- Web/worker readiness, dependency failure responses, graceful shutdown deadlines, bounded
  Prisma pool defaults, structured agent/event trace fields and safer secret redaction.
- Read-only platform-operator queue status at /admin/operations and private ops:queues CLI.
- Existing Railway config retained; web/worker probes now use /ready. Only web owns migrations.
- Deployment architecture, full environment inventory, release/rollback/backup/monitoring
  instructions and updated architecture/root guide links.

## Verification evidence

| Check                                                                   | Result                                                                                                                                    |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Populated migration rehearsal                                           | Passed: all 30 migrations; legacy/client/workforce values, canonical identities, provider mappings and historical event payloads retained |
| Deployment unit tests                                                   | 3 passed: config bounds, TLS/connection parsing and trace projection                                                                      |
| Redis integration tests                                                 | 2 passed: persistent scheduler restart, deduplication, bounded retry/backoff and failed-job retention                                     |
| Compiled process test                                                   | Passed: production-mode worker readiness/SIGTERM drain and web startup without Redis, external effects disabled                           |
| Typecheck, lint, build, format check, Prisma validate, git diff --check | Passed                                                                                                                                    |

The final clean-database regression run passed **all 44 commands**, including all 10 deployment
PostgreSQL/API tests and the communications-enabled Recovery variant. Together with 3 deployment
unit tests, 2 Redis tests and the compiled process test, all 16 new deployment tests passed.

The final migration/regression database is steel_scale_demo_deployment_final_test on loopback
PostgreSQL. Earlier iterations used steel_scale_demo_deployment_test; these databases were not
reset or deleted. Redis tests use unique deployment-test prefixes in a loopback-only Redis 7
container configured with AOF and no eviction. No public Redis service was provisioned.

The new database tests cover tenant-scoped deduplication, concurrent fenced claims, due-time
persistence across client recreation, unknown outcomes without automatic replay, SQL scope
constraints, execution-time tenant-link checks, pipeline outbox-gap recovery, deferred cron
idempotency, operator authentication and redacted health/failure responses.

## Regressions fixed during verification

- The historical scoring fixture used current-clock updatedAt with historical calculatedAt.
  Pinning the fixture's updatedAt restores deterministic stale-signal assertions without
  weakening the existing scoring expectations.
- Lead pipelines attempted website audits for businesses without websites. Those runs became
  partially completed and were scored again on replay. The pipeline now filters auditable
  businesses; the test additionally requires completion before its unchanged dedupe assertion.
- New logger imports initially captured configuration before test initialization. Logging no
  longer eagerly imports application configuration; the database loads dotenv explicitly.
- The new pipeline reconciler's raw query was corrected to use the legacy mapped client_id
  and created_at database columns. A dedicated gap-recovery test protects that path.

## Not certified locally

Live Railway dashboard overrides, Railway's installed Node version, provider delivery semantics,
production load capacity, Redis failover and backup restore time require staging/operations
verification. The local Node runtime was v25.4.0; pin and test the intended production runtime
before deployment. No browser/UI changes or browser verification are claimed.

Legacy interrupted external effects intentionally require reconciliation rather than automatic
replay. Request-bound booking/live voice remains in the web service. Native autonomous Recovery
delivery certification is still a separate rollout gate. See [DEPLOYMENT.md](DEPLOYMENT.md).
