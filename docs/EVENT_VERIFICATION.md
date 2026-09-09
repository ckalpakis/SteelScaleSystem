# Universal event verification

Verification date: September 8, 2026. All database writes used disposable PostgreSQL 16
databases on loopback port 54331. No Railway deployment, production migration, provider
webhook subscription or real message send was performed.

## Automated coverage

- `test:events`: contract/type/scope validation, lifecycle registry, stage transitions,
  inbound identity, invoice/job references, bounded JSON, dates and handler registration.
- `test:events:integration`: concurrent duplicates and changed-payload conflicts; tenant
  boundaries and composite FKs; stage/won correlation; estimate transitions; message
  identity deduplication across different delivery IDs; one unsent reply draft; handler
  failure rollback/retry; single recovery run; legacy intake/dispatch; GHL location/mapping
  validation; invoice/job observation-only behavior; delayed updates and local-edit safety.
- `test:crm:migration`: creates pre-CRM schema in an empty local database, inserts legacy
  Client/workforce sentinels, then applies all current migrations. Existing field values,
  event payloads/hashes/versions and source IDs are compared before/after. New metadata
  stays null for historical rows; receipt tables start empty. It refuses non-empty DBs
  and never resets or drops one.

The CRM integration timeline assertion now expects the additional `task.completed` fact
alongside `task.updated`; this is intentional lifecycle fan-out, not a duplicate event.

## Results

- New event unit tests: 7 passed.
- New event database/API tests: 11 passed.
- Populated additive migration rehearsal: passed, all 23 migrations applied.
- Full regression runner: all CRM, workforce, demo, booking, GHL availability, chatbot,
  missed-call, admin and other listed checks passed except the two previously recorded
  lead-intelligence failures below.
- Typecheck, lint, build, Prisma schema validation and repository formatting: passed.

Known failures, also present before the event increment:

1. `test:lead-intelligence-phase-5`: fixed-date stale-rescore fixture expects 1, receives 0.
2. `test:lead-intelligence-phase-9`: rerun creates another score in its legacy fixture.

`npm run test:regressions` intentionally exits nonzero for these failures; they have not
been suppressed or changed as part of this event work. The runner disables external
providers, uses mock/dry-run modes and requires an explicit disposable test database.

To repeat database checks, set `NODE_ENV=test` and an explicit loopback `DATABASE_URL`
whose database name starts `steel_scale_demo_` and ends `test`. Run `prisma:deploy` only
against that disposable target, then `test:events:integration` or `test:regressions`.
The migration rehearsal needs a separate completely empty disposable database.

## Deliberately not enabled or implemented

Native public vendor webhook signature receivers/OAuth setup, automatic SMS/email sends,
bulk replay tooling, a message-driven agent beyond the existing recovery handler, and
native invoice/job domains remain follow-on work. Connection provider labels do not mean
those vendors are connected. GHL's authenticated relay is implemented; existing outbound
booking/availability paths remain unchanged. Production flags remain opt-in.

Recommended next increment: add a provider-authenticated receiver for one concrete
integration, preserving stable source event/message IDs, then implement an approved-action
outbox sender with provider idempotency and delivery reconciliation before enabling sends.
