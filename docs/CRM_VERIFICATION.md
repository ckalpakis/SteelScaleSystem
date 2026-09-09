# Canonical CRM verification

Date: September 8, 2026. These results cover the canonical CRM increment on top of
the earlier [workforce foundation](WORKFORCE_VERIFICATION.md).

## Results

| Check                                                                                          | Result                                                                                                                                      |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Prisma 6.12 format, validate and generate                                                      | Passed                                                                                                                                      |
| New migration on populated local PostgreSQL 16                                                 | Passed; 22 total migrations applied                                                                                                         |
| Reproducible empty-database -> old migrations -> populated fixtures -> CRM migration rehearsal | Passed                                                                                                                                      |
| Upgrade preservation                                                                           | Existing Client full row and all prior contact/opportunity/event/connection fields unchanged; IDs, users, mappings and event links verified |
| `npm run test:crm`                                                                             | 6/6 passed                                                                                                                                  |
| `npm run test:crm:integration`                                                                 | 12/12 passed                                                                                                                                |
| `npm run test:crm:browser`                                                                     | Passed desktop/mobile workflow against real Express and disposable PostgreSQL                                                               |
| `npm run test:regressions`                                                                     | 25/27 commands passed; only the two previously documented lead-intelligence failures remain                                                 |
| `npm run typecheck`                                                                            | Passed: application, Prisma seed and scripts                                                                                                |
| `npm run lint`                                                                                 | Passed                                                                                                                                      |
| `npm run build`                                                                                | Passed                                                                                                                                      |
| `npm run format:check` and `git diff --check`                                                  | Passed                                                                                                                                      |

The full regression command ran seed, missed-call, Vapi booking, chatbot, booking routing,
admin, daily summary, all 11 lead-intelligence phases, analyst, discovery providers, GHL
availability, demos (unit/integration), workforce (unit/integration) and CRM (unit/integration).
The final focused CRM integration rerun includes the added concurrency test.

Pre-existing failures reproduced without changes to their implementation or test files:

- Phase 5: `new enrichment observation triggers stale rescore: expected 1, received 0`;
  its fixed-date observations are stale relative to the current test clock.
- Phase 9: `idempotent rerun must not create another score`; existing pipeline replay behavior.

These remain failures, not skipped tests or a green full-suite claim. No new CRM, workforce,
demo, booking or admin regression was observed.

## Coverage

- Native contact creation without external IDs, normalization, updates, soft archival,
  optimistic versions and concurrent-write conflicts.
- Cross-tenant detail/read/update/archive rejection and foreign-tenant company, assignment,
  event-link and mapping FKs rejected directly by PostgreSQL, bypassing services.
- Opportunity creation, same-tenant contact relationships, wrong-pipeline/foreign-stage
  rejection, stage moves/outcomes, in-use outcome protection and atomic stage reorder.
- Connection-scoped external IDs, typed target mappings, idempotent mapping retries,
  conflicting remaps and explicit scoped unmapping.
- Required/type/option/date custom-field validation, tenant/entity mismatch, atomic rollback
  and historical value retention when a definition is archived.
- Employee assignment/deactivation/last-owner protection, tags, tasks/completion and note activity.
- Estimate currency and dates, appointment ordering, conversation/message history semantics.
- Mapped webhooks update native contacts without duplicates; stale remote delivery cannot
  overwrite a subsequent native correction.
- API feature flags, bearer context, unknown organization-field rejection, permissions and
  revoked-principal checks after acquiring the tenant lock.
- Operator Basic authentication, scoped detail links, HTML escaping, no-store and CSRF rejection.
- Browser: contact creation/detail, custom value, note/timeline, opportunity create/stage move,
  pipeline board and mobile rendering, with outbound network blocked and no browser errors.
  A native-select accessibility label issue found during testing was fixed and retested.

## Reproduce safely

Use a disposable local PostgreSQL instance, **never a Railway/production URL**. Tests require
`NODE_ENV=test`, a loopback hostname and database name matching `steel_scale_demo_*test`.
The inherited name prefix is a safety guard shared with existing demo tests; CRM data is
not stored in demo models. Integration fixtures are fictional and remain in the disposable DB.

After creating the test DB, explicitly set its `DATABASE_URL`, then:

```bash
npm run prisma:deploy
npm run prisma:generate
npm run test:crm
npm run test:crm:integration
npm run test:regressions
npm run typecheck
npm run lint
npm run build
npm run format:check
git diff --check
```

The regression runner overrides provider credentials, selects mock/dry-run behavior,
disables workers and uses local provider doubles. It does not change `.env`.

For migration preservation, create a **separate empty** loopback test database, set its
explicit `DATABASE_URL` and `NODE_ENV=test`, then run `npm run test:crm:migration`.
The script refuses a nonempty DB, applies pre-CRM migrations from a temporary copy,
inserts legacy sentinels, applies the committed CRM migration and asserts preservation.
It never drops/reset tables or edits migration history.

Browser QA requires the already configured `playwright-core` plus a local compatible
Chromium/headless-shell. Set `CHROME_PATH` or `PLAYWRIGHT_BROWSERS_PATH` as appropriate,
then run `npm run test:crm:browser` against the migrated disposable database. The script
blocks external browser/server fetches and writes screenshots to a new temporary directory.
This run used the repository's Playwright harness approach after the in-app browser failed
to connect. Desktop pipeline and mobile contact screenshots were visually inspected.

## Deployment boundary

No production DB was accessed, Railway deployment triggered, real CRM connected, customer
message/booking sent, model request made, or Zap published. `CRM_ENABLED`, `WORKFORCE_ENABLED`
and `WORKFORCE_WORKER_ENABLED` remain false in `.env.example`. `.env` and existing production
data were not changed. Review the staging/backup/lock-window procedure in
[CANONICAL_DATA_MODEL.md](CANONICAL_DATA_MODEL.md) before enabling this increment.

The next implementation step is verified customer identity/session and invitation handling,
then a customer-scoped CRM/approval portal with searchable relationship pickers. Live
communication and regulated-data handling require separate consent, security and delivery work.
