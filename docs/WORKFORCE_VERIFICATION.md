# Workforce foundation verification

Date: September 8, 2026.

## Result

The additive foundation is implemented and verified locally. Both workforce flags remain
false in committed defaults. No Railway deployment, production database operation, real
customer message, real booking, paid model request or published Zap was performed.

The implementation includes organization-scoped CRM/event intake, integration credentials,
durable background evaluation, deterministic Revenue Recovery proposals, mandatory review,
unsent internal handoffs, audit history and operator-reported assisted payment evidence.
Customer login/portal, real natural-language compilation, live outbound recovery messaging
and verified/causal revenue attribution are not completed features.

## Checks actually run

| Check                                                     | Result                                                                                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Baseline type checking, lint and existing demo unit tests | Passed before implementation; 58 demo tests                                                                                  |
| Prisma generation, formatting and validation              | Passed with Prisma 6.12.0                                                                                                    |
| All historical migrations plus the new migration          | All 21 applied successfully to fresh local PostgreSQL 16                                                                     |
| Baseline schema → final schema diff                       | Exactly matches the generated additive portion of the new migration; no legacy table modifications                           |
| Populated legacy upgrade check                            | Client, ClientDestination and BookingAttempt full row JSON remained byte-for-byte unchanged; zero organizations auto-created |
| `npm run typecheck`                                       | Passed across app, Prisma and scripts projects                                                                               |
| `npm run lint`                                            | Passed                                                                                                                       |
| `npm run build`                                           | Passed                                                                                                                       |
| `npm run format:check`                                    | Passed                                                                                                                       |
| `git diff --check`                                        | Passed                                                                                                                       |
| `npm run test:workforce`                                  | 7/7 passed                                                                                                                   |
| `npm run test:workforce:integration`                      | 16/16 passed against real local PostgreSQL and Express                                                                       |
| `npm run test:demos`                                      | 58/58 passed                                                                                                                 |
| `npm run test:demos:integration`                          | Passed; existing 20-test suite                                                                                               |
| `npm run test:demos:browser`                              | Passed: desktop/mobile chat, simulated booking, voice UI, provider errors/reset, calculator and private preview              |
| Separate Railway web/worker config validation             | Passed; web config unchanged, worker config has no HTTP healthcheck or migration command                                     |

The browser harness initially could not find its required browser executable. The matching
Playwright headless browser was installed into the temporary test directory; the unchanged
browser harness then passed. It used provider/audio test doubles, not real AI or microphone
acceptance. Screenshots were saved outside the repository, preserving existing screenshots.

Sandbox restrictions initially blocked loopback DB/server operations. They succeeded after
permission to run the isolated local checks. No production URL or credential was substituted.
Initial new-code type/lint issues were corrected before the successful final checks.

### Existing service and lead-intelligence regression scripts

`npm run test:regressions` ran the seed and all existing non-browser suites, then the new
workforce suites. It passed test setup and 22 of 24 test commands. The browser suite was
run separately and passed. The new integration suite was subsequently rerun after adding
the total proposal budget test and passed all 16 tests.

Passed:

- Missed-call, Vapi booking, chatbot, booking routing, admin, daily summary.
- Lead-intelligence phases 1, 2, 3, 4, 6, 7, 8, 10, 11.
- Lead analyst, discovery provider adapters, GHL availability.
- Demo unit/integration suites and workforce unit/integration suites.

Two pre-existing failures remain:

| Script                           | Observed failure                                                            | Prior evidence                                                                               |
| -------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `test:lead-intelligence-phase-5` | `new enrichment observation triggers stale rescore: expected 1, received 0` | Same fixed-date fixture failure documented in `LIVE_DEMO_VERIFICATION.md` before this change |
| `test:lead-intelligence-phase-9` | `idempotent rerun must not create another score`                            | Same pipeline replay failure documented in that prior report                                 |

The regression command correctly exits nonzero for those failures. It does not hide them
or label the entire repository green. `git diff --exit-code HEAD` confirmed that legacy
services, routes, lead-intelligence, demo code, both failing test scripts, the original Railway
configuration and dependency lockfile were unchanged. No new regression was found in the
executed checks. The only shared code changes are the new isolated router mount and broader
Prisma error redaction for private domain data.

### New integration coverage

- Disabled API, authentication, machine JSON content type and browser Origin rejection.
- Independent organization provisioning, hashed credentials, expiration, rotation, revocation,
  inactive membership and role/scope enforcement.
- Tenant-scoped CRM/audit reads and PostgreSQL rejection of a cross-tenant customer FK.
- Zapier intake token binding, forbidden CRM/agent access, spoofed tenant fields and replay.
- Eight concurrent identical deliveries resulting in one event, customer and queued job.
- Atomic rollback when the customer prerequisite is missing, then successful retry.
- Out-of-order observations, stale event retention and sticky suppression.
- Competing worker claims, expired lease recovery and fencing of stale worker completion.
- Evaluation rollback, retries/dead letters and exhausted crash leases.
- Hourly scheduling deduplication and one recovery action per opportunity across agents.
- Concurrent approval decisions, tenant/role rejection, expiry, suppression and config changes.
- Closed/fresh opportunity exclusion and terminal operator rejection.
- Payment evidence requirements, currency checks and protection against duplicate credit.
- A 105-opportunity fixture across three agents: first job creates 100 proposals; the next
  scan creates only the remaining five.
- Disabled-by-default agents and optimistic configuration version checks.

## Local test environment and reproduction

Tests used the purpose-created Docker container `steel-scale-workforce-test-0908`, PostgreSQL
16, bound only to `127.0.0.1:54331`. Databases were `steel_scale_demo_workforce_test` and
`steel_scale_demo_workforce_upgrade_test`. These contain fictional fixtures only. The upgrade
test built the pre-change schema, inserted legacy fixtures, applied the new migration and
compared full row JSON snapshots. Temporary scripts/browser files and screenshots were
stored under `/private/tmp/steel-scale-workforce.64Nad8`.

For a fresh independent test run, provision your own disposable loopback PostgreSQL database
matching `steel_scale_demo_*test`, then use:

```sh
export NODE_ENV=test
export DATABASE_URL='postgresql://<test-user>:<test-password>@127.0.0.1:<test-port>/steel_scale_demo_workforce_test'
npm run prisma:deploy
npm run test:regressions
```

The test runner refuses non-loopback/non-test database names before any operation and masks
provider secrets. It uses SMS/booking dry runs, mock chat, and existing local delivery stubs.
Some legacy tests load `.env` themselves, which is why explicit environment overrides are
necessary. The test runner seeds only the selected disposable database. Do not use the seed
or legacy test scripts against production. Browser QA requires the matching Playwright
browser and should save screenshots to a temporary `DEMO_SCREENSHOT_DIR`.

## Exact source changes

Modified:

| File                          | Change                                                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `prisma/schema.prisma`        | 14 additive organization/workforce models, supporting enums and an inverse optional Client relation; legacy fields remain unchanged |
| `src/app.ts`                  | Mount `/api/workforce` before generic request logging/body parsing                                                                  |
| `src/db/client.ts`            | Extend private Prisma error/warning redaction to workforce/organization operations                                                  |
| `package.json`                | Add worker start, workforce unit/integration tests and guarded regression runner commands                                           |
| `.env.example`                | Add disabled workforce API/worker flags                                                                                             |
| `README.md`                   | Correct outdated scaffolding description and link foundation documentation                                                          |
| `ZAPIER_CLIENT_ONBOARDING.md` | Link separate workforce event intake documentation; preserve booking/availability instructions                                      |

Added:

- `prisma/migrations/20260908120000_add_workforce_foundation/migration.sql` — new tables/enums/
  indexes, composite FKs, credential ownership/money CHECKs, transaction and bounded lock wait.
- `src/workforce/shared.ts` — validation, JSON hashing and tenant transaction boundary.
- `src/workforce/tenancy/service.ts` — organizations, memberships, hashed credentials and scopes.
- `src/workforce/crm/projector.ts` — internal CRM projection and source ordering.
- `src/workforce/events/contracts.ts`, `events/service.ts` — canonical events and atomic intake.
- `src/workforce/integrations/adapters.ts` — optional Zapier/generic webhook adapters.
- `src/workforce/agents/config.ts`, `agents/runtime.ts` — reviewed configuration boundary and recovery evaluator.
- `src/workforce/policy/engine.ts`, `tools/registry.ts` — policy and validated internal actions.
- `src/workforce/jobs/queue.ts`, `jobs/scheduler.ts`, `jobs/worker.ts` — durable claims, scheduling and worker entrypoint.
- `src/workforce/approvals/service.ts`, `audit/service.ts`, `revenue/service.ts` — decisions, history and attribution evidence.
- `src/workforce/http/routes.ts` — scoped machine API and safe errors.
- `src/workforce/core.test.ts`, `foundation.integration.test.ts` — new foundation tests.
- `scripts/test-workforce-regressions.ts` — guarded, provider-isolated regression runner.
- `railway.workforce.json` — optional separate worker service configuration.
- `docs/ARCHITECTURE.md`, `docs/WORKFORCE_API.md`, this report — architecture, rollout, examples and evidence.

Generated Prisma Client and build output are ignored artifacts. No dependency was added,
no historical migration was edited, and `.env` was not modified.

## Recommended next implementation

Add authenticated customer identity/membership management and a small organization CRM/
approval portal over this foundation. Then pilot one consent-aware recovery delivery adapter
with receipt reconciliation and stop-on-reply behavior. Before live customer contact, address
the legacy webhook authentication gaps identified in the architecture document and validate
the complete workflow in staging. Keep natural-language configuration as an explicit,
validated proposal that a human reviews before enabling an agent.
