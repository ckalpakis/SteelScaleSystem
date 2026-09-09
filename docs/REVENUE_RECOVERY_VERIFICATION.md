# Revenue Recovery verification

Verified locally on 2026-09-08. No Railway deployment, production database changes,
provider communication or paid model calls were made. Existing dirty-worktree additions
from the preceding CRM/events/integration/runtime/builder increments were retained.

## Implemented scope

- `src/recovery`: versioned service-business configuration, runtime provider and fixed
  tools, scoped event handler/scheduler, fresh message guards, consent journal, handoff
  service, claim/receipt delivery protocol, reviewed attribution, dashboard/API and
  separate simulation system.
- Additive migration: eight scoped recovery tables, AgentVersion.specialization and
  Organization.active. Composite ownership FKs, action/request/provider receipt uniqueness,
  state checks and one-unresolved-dispatch constraint.
- Existing runtime/policy/approval, canonical CRM/events, organization credentials,
  worker, webhook system, admin layout and OpenAI structured-output helper reused.
- Default-off flags, mounted routes/navigation, regression commands and documentation.
- 37 fictional service-business scenarios; no production CRM scenario seeding.

## Checks

| Check                                         | Result                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Recovery unit/scenario tests                  | 43 passed; includes all 37 seeded scenarios.                                               |
| Recovery PostgreSQL/API integration tests     | 30 passed (73 recovery tests total with unit/scenario tests).                              |
| Desktop/mobile browser checks                 | Passed, no page errors or horizontal viewport overflow.                                    |
| Prisma format/generate/validate               | Passed.                                                                                    |
| All migrations in local test database         | Applied successfully (27 migrations).                                                      |
| Populated legacy-to-current upgrade rehearsal | Passed; existing CRM/client/provider/event data unchanged.                                 |
| Full regression suite                         | 35 of 37 commands passed; the two previously documented lead-intelligence failures remain. |
| Typecheck, lint, build and formatting         | Passed.                                                                                    |

The full regression run used newly migrated `steel_scale_demo_recovery_upgrade_test`.
Earlier runs in the repeatedly reused workforce test database exhausted an old test's
500-job global queue drain because accumulated fixtures remained. The same workforce
suite passed in the fresh rehearsal database. No existing data was deleted/reset to
make tests pass. Two actual pre-existing failures remain:

- `test:lead-intelligence-phase-5`: new enrichment observation stale rescore expects 1,
  receives 0.
- `test:lead-intelligence-phase-9`: idempotent rerun creates another score.

The full suite passed recovery before the final added archived-pipeline and pending
employee-opt-out, advisory and rejection checks; those are covered by the final dedicated recovery run. Legacy
booking, missed calls, Vapi, chatbot, admin, GHL availability, demos, workforce, CRM,
events, integrations, generic runtime and Agent Builder commands otherwise passed.

## Security and behavior coverage

Tests cover scoped reads/API/SQL FKs, duplicated events/scans/claims/receipts, review/version
fences, cadence, accepted estimates, appointments, current stage/pipeline eligibility,
disabled/inactive/suppressed states, revoked consent, changed value/currency, employee
activity, working hours, attempts and unprocessed replies. Handoff tests exercise pricing,
takeover, response, return, close, revoked employee authority and queued human responses
blocked by an unprocessed STOP. Lease tests cover unknown outcomes, disabled-agent expiry
reconciliation, conclusive-not-sent retries without extra logical attempts, and late
definitive receipts without automatic resumption. Attribution tests reject unsupported
financial claims, avoid shared-contact multi-opportunity credit, replay reviews safely
and revoke recovered credit after reopening.

Simulation tests prove no live runs, dispatches, CRM records or revenue are created.
Classification includes all requested intents plus prompt injection, Unicode opt-outs,
unknown input and fake operational safety failures. These are offline classification
fixtures, **not evidence of live-model accuracy**.

## Browser evidence

`scripts/test-recovery-browser.ts` seeds a fictional local organization/case/handoff via
backend services, then performs read-only authenticated browser checks. It blocks external
page requests and disables model and delivery flags. The existing Steel Scale navy/steel
layout was retained; desktop (1440px) and mobile (390px) were visually inspected. The
in-app browser setup was attempted but failed on unavailable sandbox metadata; the
existing local Playwright installation was used instead.

Screenshots from the final UI run:

`/var/folders/6g/s7q848wd6gg2lxf34qbqbks40000gn/T/steel-scale-recovery-browser-ceJh8k/`

Contains dashboard-desktop.png, dashboard-mobile.png, handoff-desktop.png and handoff-mobile.png.
These temporary screenshots contain fictional data and may be cleaned up by the OS.

## Reproduction

Use a disposable loopback PostgreSQL database, NODE_ENV=test and explicit DATABASE_URL
whose database name matches `steel_scale_demo_*test`. The test guard runs before app/dotenv
loading. The full regression runner replaces production-provider credentials with empty
values and mock/dry-run implementations. Tests intentionally leave their isolated fixtures.

```bash
npm run test:recovery
npm run test:recovery:integration
npm run test:recovery:browser
npm run test:regressions
npm run typecheck
npm run lint
npm run build
npm run format:check
npx prisma validate
```

Browser checks require a compatible installed Chromium; PLAYWRIGHT_BROWSERS_PATH can
select it. `npm run test:crm:migration` requires a **separate empty** local test database.
It applies old migrations, inserts preservation sentinels and applies the remaining
migrations without dropping/resetting anything.

## Not verified / rollout gates

No live model-quality benchmark, delivery-provider integration, installed Zap, production
load test, legal/consent certification, native SMS/email sender or independent accounting
verification is included. All AI messages retain exact-action review. Delivery uses a
trusted adapter, one-time short-lived claims, durable provider deduplication and confirmed
receipts. Already-claimed messages have an explicit external in-flight race boundary.

Next: certify one sandbox delivery adapter and its consent/idempotency/receipt behavior,
evaluate representative real-world language with approved test data, and run a small
human-reviewed staging pilot. See [the rollout guide](REVENUE_RECOVERY.md).
