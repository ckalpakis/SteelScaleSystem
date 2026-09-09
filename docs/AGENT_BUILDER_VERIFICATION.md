# Agent Builder verification

Verified September 8, 2026, using fictional fixtures and disposable loopback PostgreSQL 16.
No production database, Railway deployment, real `.env`, live model endpoint or customer
delivery was changed or used. Existing uncommitted platform increments were preserved.

## Changes in this increment

- New `src/agent-builder/` domain: strict blueprint schema, extraction abstraction, deterministic
  compiler, scoped version/generation/test service, JSON API, editable HTML UI and form mapping.
- Four additive Prisma tables with tenant-composite relationships, indices and checks in
  `20260909010000_agent_blueprints`; no existing table/data deletion or rewrite.
- Existing agent service version-creation logic extracted into shared transaction helpers;
  existing bounded OpenAI Responses transport extracted into a reusable helper. Existing
  runtime policy, tools, worker and execution modes remain authoritative.
- Application routes, conditional navigation, default-off example environment settings,
  test scripts and architectural/user/API documentation.
- Migration rehearsal assertions extended to verify new blueprint stores start empty.

## Results

| Check                                           | Result                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| Type checking (application, Prisma and scripts) | Pass                                                                    |
| Repository ESLint                               | Pass                                                                    |
| TypeScript production build                     | Pass                                                                    |
| Prettier check                                  | Pass                                                                    |
| Prisma format/generate/validate                 | Pass                                                                    |
| Builder unit tests                              | 7 pass                                                                  |
| Builder PostgreSQL/API/HTML integration tests   | 12 pass                                                                 |
| Existing runtime tests                          | 6 unit + 18 integration pass                                            |
| Local browser smoke test                        | Pass: desktop/mobile, controls, disabled AI, edit guard, no page errors |
| Migration application                           | Pass: all 26 migrations on disposable PostgreSQL                        |
| Populated legacy-to-current upgrade rehearsal   | Pass: seeded values and historical payloads preserved                   |
| Full regression runner                          | 33 checks pass; 2 previously documented legacy failures remain          |

The full regression runner retains a non-zero exit code for these pre-existing failures:

- `test:lead-intelligence-phase-5`: enrichment stale-rescore assertion, expected 1, received 0.
- `test:lead-intelligence-phase-9`: idempotent rerun unexpectedly creates another score.

These same failures were recorded before the builder increment in
[runtime verification](AGENT_RUNTIME_VERIFICATION.md). No scoring code was changed here.
All missed-call, booking, admin, daily summary, other scoring phases, GHL availability, demo,
workforce, CRM, canonical event, integration and runtime checks passed. The final added HTML
workflow test was also rerun separately after the full regression pass.

## New test coverage

Unit tests cover strict/closed shape, missing information, preservation of the estimate
example's exact threshold/delay/prohibition/escalation, supported runtime compilation,
conflicting permissions, model allowlists, knowledge approval, conjunction semantics,
side-effect-free preview, exact form amount conversion and mocked strict Responses requests.

Database/HTTP tests cover duplicate/concurrent generation, changed idempotency payloads,
stale AI responses after edits, credential revocation during extraction, failure redaction,
abandoned receipts, daily generation limits, every cross-tenant operation, composite FK
rejection, changed membership, mandatory review/test/hash checks, concurrent activation,
immutable history, unchanged active versions during draft editing, runtime-version conflicts,
changed model allowlists, JSON/auth/origin gates, action-bound CSRF, HTML escaping and the
actual Save Draft → Test Agent → reviewed Activate Agent form workflow. Saving/testing and
activation themselves create no runs, tasks, messages or action receipts.

Browser checks use the already-installed local Playwright harness. The in-app browser
connection failed before navigation, so that connection was not used. Fictional fixture data
and member credentials are created server-side; browser checks do not generate AI drafts,
activate agents, send messages or change credentials. Screenshots were inspected at 1440×1000
and 390×844. Camel-case readiness labels were made readable after the first visual review.

Live extraction quality and provider compatibility are **not** verified by mocked transport
tests. Paid AI remains default-off. Test Agent is a configuration preview, not a live model
simulation. The estimate example remains intentionally activation-blocked until its requested
runtime capabilities exist; see [limits and rollout](AGENT_BUILDER.md).

## Reproduce safely

Use `NODE_ENV=test` and an explicit disposable local `DATABASE_URL` whose database name starts
with `steel_scale_demo_` and ends with `test`. Guards reject other targets. Never point these
fixture-writing suites at production.

```sh
npm run prisma:generate
npm run typecheck
npm run lint
npm run build
npm run format:check
npm run test:agent-builder
npm run test:agent-builder:integration
npm run test:agents
npm run test:agents:integration
npm run test:agent-builder:browser
npm run test:regressions
```

The browser script needs an existing compatible Chromium installation (`PLAYWRIGHT_BROWSERS_PATH`
can select it). `npm run test:crm:migration` requires a **separate empty** disposable database:
it applies the older foundation, inserts preservation sentinels, then applies the remaining
migrations. It never resets/drops an existing database. The local rehearsal used
`steel_scale_demo_builder_upgrade_test`; the main suites used `steel_scale_demo_workforce_test`.
