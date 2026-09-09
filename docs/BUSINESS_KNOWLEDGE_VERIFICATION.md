# Business Knowledge verification

Verified locally on 2026-09-08. No Railway deployment, production database change, customer
message or paid model call. Existing uncommitted platform work was preserved. This increment
adds the knowledge domain and narrow runtime/recovery integrations; it is not a legacy rewrite.

## Changes

- Four canonical scoped models, immutable version/document provenance, explicit review and
  optimistic revision checks. An additive atomic migration adds Organization.knowledgeRevision
  and four tables, composite foreign keys, indexes, checks and immutability triggers. A five-second
  lock timeout prevents indefinite lock waits. No destructive backfill or model deletion.
- Sixteen structured categories, public/internal audiences, active/inactive sources and entries,
  bounded text/Markdown documents, exact approved excerpts, cited retrieval and unsupported answers.
- Current-member API and Business Knowledge admin with library, editors, approval/history,
  document input, source controls and a no-model question tester. Existing navy/steel layout
  and responsive panels were retained following the frontend-design skill.
- Explicit registered runtime read tool, knowledge-revision context fencing, pinned approved
  Recovery versions checked before AI outbound execution, and source IDs in decision evidence.
- Default-off flag, routes/navigation, logging redaction, regression commands and architecture docs.

## Verification

| Check                                | Result                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Knowledge unit tests                 | 20 passed, including all 16 categories, permission-field rejection, risk and byte/format limits.                       |
| Knowledge database/API tests         | 12 passed.                                                                                                             |
| Desktop/mobile browser checks        | Passed; no page errors, viewport overflow, model calls, runs or dispatches.                                            |
| Prisma format/generate/validate      | Passed.                                                                                                                |
| Final populated upgrade rehearsal    | All 28 migrations applied; legacy/client, workforce, canonical IDs, provider mappings and historical events preserved. |
| Full regression suite                | 37 of 39 commands passed; only the two previously documented lead-intelligence failures remain.                        |
| Typecheck, lint, build, format check | Passed.                                                                                                                |
| git diff --check                     | Passed.                                                                                                                |

The final migration and regression rehearsal used a new isolated local PostgreSQL database,
steel_scale_demo_knowledge_final_test. No database reset/deletion was used. Prior local rehearsal
databases retain their fictional records. Two unrelated baseline failures remain:

- test:lead-intelligence-phase-5: stale enrichment rescore expects 1, receives 0.
- test:lead-intelligence-phase-9: idempotent rerun creates another score.

Legacy missed calls, booking, Vapi, chatbot, admin, summaries, GHL availability, demos and all
workforce/CRM/events/integrations/runtime/builder/recovery/knowledge commands otherwise passed.

## Security and behavioral coverage

Tests cover foreign-tenant services, retrieval and SQL links; same-entry scoped approvals;
draft exclusion; source/document/entry withdrawal; immutable history; stale review rejection;
unknown/ambiguous questions; exact answer/source matching; internal employee exclusion;
financing availability versus an unsupported monthly payment; source validation; document
deduplication/excerpt enforcement; runtime tool and context changes; fresh Recovery message
guards; inactive organizations; authentication, Origin and CSRF; revoked members; integration
credential rejection; default-off behavior; and the complete admin save/review/test/edit cycle.

These tests do not measure live-model factual accuracy. The tester is deterministic lexical
retrieval and only emits an exact reviewed general answer; sensitive/approximate matches are
reference-only. No claim is made that arbitrary internal model prose or unchanged legacy
booking/chatbot prompts are now fact-certified. See the execution boundaries and rollout
compatibility requirements in [BUSINESS_KNOWLEDGE.md](BUSINESS_KNOWLEDGE.md).

## Browser evidence

The browser skill's in-app runtime failed to initialize because sandboxPolicy metadata was
missing. The existing local Playwright installation provided the fallback. Backend services
created fictional fixtures; browser activity was read-only and external page requests were
blocked. No browser approval, file upload or activation action was performed. Form mutations
were verified separately through local HTTP integration tests with action-bound CSRF.

Inspected library/review screens at 1440px and 390px, all 16 category options, document source
text, text-file input, approval controls and version history. The mobile library deliberately
scrolls its wide table inside its panel; the viewport itself does not overflow.

Screenshots (temporary local fictional data):

`/var/folders/6g/s7q848wd6gg2lxf34qbqbks40000gn/T/steel-scale-knowledge-browser-xoS2mf/`

Contains library-desktop.png, library-mobile.png, review-desktop.png and review-mobile.png.
The OS may clean these temporary artifacts.

## Reproduce

Use NODE_ENV=test and an explicit loopback DATABASE_URL naming a disposable
steel_scale_demo_*test database. Guards run before dotenv/app import. Migrations require a
new empty database; the full regression runner overrides production providers with mock,
dry-run or local stubs. Fixtures are left in the disposable database.

```bash
npm run test:crm:migration
npm run test:regressions
npm run test:knowledge
npm run test:knowledge:integration
npm run test:knowledge:browser
npm run typecheck
npm run lint
npm run build
npm run format:check
npx prisma validate
```

Browser checks require an installed compatible Playwright Chromium; set
PLAYWRIGHT_BROWSERS_PATH to that existing installation when needed. No browser/dependency
download or production seed is part of deployment. Follow the knowledge guide before enabling
BUSINESS_KNOWLEDGE_ENABLED on both web and worker: old unbound recovery templates fail closed.
