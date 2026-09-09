# Agent runtime verification

September 8, 2026. Local implementation only: no Railway deployment, production migration,
real customer message, appointment, live model request or external integration send.

## Scope

- Added `src/agents/` contracts, immutable-version service, context projection, policy,
  registered tools, provider interface/strict Responses adapter, run worker, approvals,
  scheduler, event subscription and management API.
- Reused existing workforce identities, organization locks, scoped credentials, native
  CRM validation, canonical publisher, audit and worker deployment. Legacy recovery
  behavior is retained behind its existing endpoints/configuration.
- Added the non-destructive `20260908230000_agent_runtime` migration; 12 new tenant-owned
  tables and their scoped foreign keys, indices and state/budget constraints.
- Added gated `/api/agents` management and explicit runtime/model/allowlist environment
  settings. No new end-user UI, dependency, automatic deployment or data backfill.
- Added safe agent database-error redaction and canonical internal-action completion
  receipts, which may use the existing outbound webhook subscriptions.

## Verification

Passed: 24 new tests (6 unit, 18 database/API), type checking, lint, build, formatting,
Prisma schema validation and whitespace checks. The new invoice-trigger and administrator-
stop cases also passed in the final targeted database/API run.

The unit suite covers strict definitions/decisions, unknown tools, all three modes,
permission precedence, suppression, channel/hour/action limits, bounded tool arguments,
and mocked Responses schema/refusal/incomplete-output handling.

The database/API suite covers immutable version history, preserved legacy agents,
Autopilot internal actions, Copilot exact approvals and approval races, Advisory non-execution,
tenant/context isolation and foreign keys, revocation and stale approvals, trigger/action
deduplication, bounded loops, concurrent/expired claims, event recursion suppression,
scheduling/expiry, unavailable external adapters, admin-only APIs, model-time context edits,
admission limits, native stage validation, employee assignments, follow-ups, manual escalation,
deadline/model-pause handling and administrator stopping of an in-flight model result.

The complete existing regression runner still reports the pre-existing lead-intelligence
phase 5 stale-rescore fixture (expected 1, got 0) and phase 9 rerun-score fixture. Neither
test was suppressed or changed. Agent tests use injected model responses and never call
OpenAI or a delivery provider.

All 25 migrations applied to the disposable PostgreSQL 16 database. A separate populated
upgrade rehearsal retained legacy Client/workforce values, identities, event payloads and
hashes, and verified the new runtime stores start empty. Unrelated existing schema drift
was deliberately not included in the migration.

Commands: `npm run typecheck`, `npm run lint`, `npm run build`, `npm run format:check`,
`npm run test:agents`, `npm run test:agents:integration`, `npm run test:regressions`,
`npm run test:crm:migration` and `npx prisma validate`.

## Follow-up

Verify an explicitly allowlisted model using fictional staging data before enabling
paid calls. Add consent-aware external delivery adapters and receipts before promising
autonomous messaging/booking. Add an organization-facing builder/approval interface and
retention/alerting policies separately. Migrate existing recovery agents only through an
explicit tenant-specific rollout with reviewed versions and comparison tests.
