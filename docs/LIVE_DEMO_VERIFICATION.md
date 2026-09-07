# Live-demo implementation verification

Date: September 7, 2026. Branch: `feature/live-demo-experience`.

## Outcome

The existing Demo Builder now has a customer-facing website preview with interactive AI chat, a browser voice-receptionist console, transcripts, microphone controls, fullscreen presentation and demo appointment cards. Real-provider adapters are implemented, but paid OpenAI conversation/audio acceptance testing was **not performed**. Bookings and outbound messaging remain simulated. See [the complete implementation and local-test guide](LIVE_DEMO_EXPERIENCE.md).

No commit, push, merge, PR, deployment or production infrastructure/configuration change was made. `.env` was not modified. All three feature flags remain `false` in `.env.example`. No paid demo-provider call or real customer message was used for verification.

## Checks actually run

| Check                                          | Result                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `npx prisma format`                            | Passed                                                                                                  |
| `npx prisma validate`                          | Passed                                                                                                  |
| `npm run prisma:generate`                      | Passed, Prisma Client 6.12.0                                                                            |
| `npm run prisma:deploy` on isolated PostgreSQL | Passed; all 20 repository migrations applied to a fresh test DB                                         |
| Prisma baseline-schema → current-schema diff   | Only the new `SalesDemoSession` table, indexes and FK; matches the added migration                      |
| Full historical DB → current schema diff       | Reports existing unrelated index-name/FK drift; see below                                               |
| `npm run typecheck`                            | Passed: app, Prisma seed and scripts projects                                                           |
| `npm run lint`                                 | Passed                                                                                                  |
| `npm run format:check`                         | Passed                                                                                                  |
| `npm run build`                                | Passed                                                                                                  |
| `npm run test:demos`                           | 58/58 passed                                                                                            |
| `npm run test:demos:integration`               | 20/20 passed against PostgreSQL                                                                         |
| `npm run test:demos:browser`                   | Passed: desktop chat/booking, voice UI, error recovery/reset, calculator, mobile, authenticated preview |
| `git diff --check`                             | Passed                                                                                                  |

The integration suite exercises real Express routes, real PostgreSQL transactions and real local WebSocket sideband connections, with paid-provider HTTP responses stubbed. It covers quota races, per-demo/daily/voice/concurrency caps, CSRF/origin/auth, session scope, turn/expiry checks, in-flight archive revocation, simulated booking persistence, duplicate voice starts, policy tampering, socket loss, hangup retry, replica-safe cleanup, private data boundaries and a real ingestion/scoring operation producing zero demos/provider calls. Existing create/publish/edit/archive/privacy/event-cap tests are retained.

Browser tests use the actual application and DB for chat, but substitute provider responses and microphone/WebRTC transports. They check the greeting is requested only after the data connection opens. They **do not prove actual speech/audio quality, provider account permissions, paid model connectivity or production-proxy behavior**.

Initial implementation/test failures (fixture field names, TypeScript browser-harness helper, lint and formatting) were fixed and the affected checks rerun. The in-app browser connection was unavailable; installed Chrome timed out. A temporary Playwright Chromium headless-shell download successfully ran the browser suite. Screenshots contain **test-double responses**, not a real paid AI call.

### Existing application regressions

Run with the disposable DB, SMS dry runs, mock chat, local booking/Slack test servers and no authorized live customer integrations:

- Passed: `test:missed-call`, `test:vapi-booking`, `test:chatbot`, `test:booking-routing`, `test:admin`, `test:daily-summary`.
- Passed: `test:lead-intelligence-phase-1`, `-2`, `-3`, `-4`, `-6`, `-7`, `-8`, `-10`, `-11`.
- Failed: `test:lead-intelligence-phase-5` — “new enrichment observation triggers stale rescore: expected 1, received 0.” The fixture uses fixed September 2–3 timestamps while business creation uses the current clock; stale scoring compares against the latest source timestamp.
- Failed: `test:lead-intelligence-phase-9` — “idempotent rerun must not create another score.” Its fixture pipeline returns `partially_completed`, then adds a score on rerun.

The two lead-intelligence failures reproduce with all demo flags disabled. `git diff --exit-code HEAD -- src/lead-intelligence scripts/test-lead-intelligence-phase-5.ts scripts/test-lead-intelligence-phase-9.ts` confirms those implementation/test files were unchanged. They were not fixed as part of the demo UI/runtime change. This is **not** a claim that every repository test passes.

The first Vapi smoke run rejected an unauthenticated request because the existing local secret was picked up during application initialization. Repeating with `VAPI_WEBHOOK_SECRET` explicitly blank in the isolated test process passed; production authentication was not weakened. Prisma can load `.env` independently of `DOTENV_CONFIG_PATH`, so blank/mask real provider credentials explicitly when running legacy scripts. Never use a production DB for them.

### Historical migration drift

The entire migrated database differs from the current schema in pre-existing areas: truncated index names on `LeadContactPermission`, `RealEstateListingSourceRecord`, `RealEstateListingSourceVersion`, plus `RealEstateListing.lead_id` FK behavior. The baseline-to-current source diff contains none of those changes. No unrelated schema repairs or destructive migrations were added.

### Local test environment

Tests used loopback PostgreSQL 16 in the container `steel-scale-live-demo-test-0907`, database `steel_scale_demo_live_test`, port 54329. It was created specifically for this work, with fictional fixtures. The container is stopped after verification and retained locally; it is not a Railway database. The independent local setup commands in [LIVE_DEMO_EXPERIENCE.md](LIVE_DEMO_EXPERIENCE.md) use port 54330 to avoid conflicts.

## Every repository file created or modified

Generated/ignored dependency caches, generated Prisma Client and `dist/` output are excluded from this source/artifact inventory.

### Created

| File                                                                    | Purpose                                                                     |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `src/demo-engine/experience-view.ts`                                    | Customer-facing website/voice/chat HTML                                     |
| `public/demo/experience.css`                                            | Desktop/mobile presentation styling                                         |
| `public/demo/experience.js`                                             | Chat, WebRTC/audio, transcripts, controls, events and ROI interactions      |
| `src/demo-engine/live-provider.ts`                                      | Bounded OpenAI chat/voice adapters and demo-only tools                      |
| `src/demo-engine/live-runtime.ts`                                       | Session persistence, limits, call control, sideband processing and watchdog |
| `src/demo-engine/live-routes.ts`                                        | Authenticated/scoped live session endpoints                                 |
| `src/services/openai-response.ts`                                       | Shared safe raw REST text parser                                            |
| `src/demo-engine/live-provider.test.ts`                                 | Parser, prompts, tool boundaries, adapters, UI and test-DB guard unit tests |
| `src/demo-engine/live.integration.test.ts`                              | Database/route/voice-sideband/isolation tests                               |
| `src/demo-engine/test-database.ts`                                      | Destructive-test DB scope guard                                             |
| `scripts/test-demo-experience.ts`                                       | Repeatable local headless-browser checks with no paid providers             |
| `prisma/migrations/20260907190000_add_live_demo_sessions/migration.sql` | Additive session table/index/FK migration                                   |
| `docs/LIVE_DEMO_EXPERIENCE.md`                                          | Functionality, limits, routes, setup and staging acceptance guidance        |
| `docs/LIVE_DEMO_VERIFICATION.md`                                        | This results/file-inventory report                                          |
| `docs/testing/live-demo/desktop-chat.png`                               | Desktop chat and simulated-booking screenshot                               |
| `docs/testing/live-demo/desktop-voice-controls.png`                     | Voice-control/transcript screenshot using test doubles                      |
| `docs/testing/live-demo/mobile-chat.png`                                | Mobile layout and failure/validation-state screenshot                       |

### Modified

| File                                         | Change                                                                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `.env.example`                               | Disabled-by-default live AI/voice flags and demo model/key settings                                                          |
| `package.json`                               | `ws` runtime dependency; `@types/ws` and `playwright-core` dev dependencies; expanded demo test commands                     |
| `package-lock.json`                          | Matching dependency lock entries; no framework upgrades                                                                      |
| `prisma/schema.prisma`                       | `SalesDemoSession` and inverse `SalesDemo.sessions` relation                                                                 |
| `src/db/client.ts`                           | Redact demo-specific Prisma error/warning details                                                                            |
| `src/demo-engine/core.ts`                    | Live voice/chat module labels                                                                                                |
| `src/demo-engine/core.test.ts`               | Updated assertions for external, safe browser script                                                                         |
| `src/demo-engine/routes.integration.test.ts` | Require an explicitly scoped disposable database before fixture deletion                                                     |
| `src/demo-engine/routes.ts`                  | Runtime mounts, static assets, page credentials/readiness, microphone/CSP policy, setup explanation and private 404 handling |
| `src/demo-engine/views.ts`                   | Replace old public scripted presentation with new experience renderer; update form explanation                               |
| `src/server.ts`                              | Voice watchdog startup and graceful cleanup before DB disconnection                                                          |
| `src/services/chatbot-llm.ts`                | Correct REST response text extraction and reject empty responses                                                             |
| `docs/STEEL_SCALE_DEMO_ENGINE.md`            | Point historical spec to current implementation                                                                              |
| `docs/DEMO_ENGINE_ROLLOUT.md`                | Distinguish original package checklist from current validation                                                               |
| `memory.md`                                  | Record the interactive sales-demo priority and safe runtime boundaries                                                       |

## Still incomplete before a real sales call

Real account/audio acceptance testing and any separately authorized deployment remain outstanding. The site preview is a personalized template, not a clone; the browser voice uses OpenAI Realtime, not the customer's exact production Vapi agent. Booking/SMS/CRM actions remain intentionally simulated. No automatic retention job, hard currency budget, production onboarding, verified GBP/review enrichment or portal was added. The two unrelated regression failures and historical schema drift above remain visible rather than being represented as fixed.
