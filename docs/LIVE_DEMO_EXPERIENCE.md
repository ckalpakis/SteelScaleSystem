# Live sales-demo experience

## What changed

The existing on-demand Demo Builder now renders an interactive presentation instead of scripted text panels. This is integrated into the existing Express/TypeScript/Prisma application—not another app inside the implementation package.

- Personalized business website preview with business name, services, location, hours, summary, service buttons and an expandable AI chat widget.
- Browser voice receptionist: start/end conversation, microphone permission handling, mute, remote audio playback, conversation transcript, connection state and a three-minute countdown.
- Actual OpenAI Responses chat and OpenAI Realtime WebRTC adapters, using the existing OpenAI account configuration or an optional separate demo project key. The voice adapter uses server-side SDP negotiation and a server WebSocket sideband for tools and call control. It does **not** call the production Vapi webhook or reproduce a client's exact Vapi voice configuration.
- Visible activity and simulated appointment cards generated from demo-only tool results. No real calendar, SMS, CRM, owner-transfer or production-booking tools are available.
- Fullscreen presentation control, responsive desktop/mobile layouts, keyboard-focus styling, reduced-motion support, editable ROI calculations and visually presented messaging examples.
- Separate persistent demo conversations, authorization and usage limits. Manual/prospect creation, review, publishing, expiration and archiving are preserved. Scraping, importing, enriching and scoring do not create demos.
- Fixed the shared production chatbot's raw OpenAI REST text extraction (`output[].content[].text`); production booking behavior is otherwise unchanged. Demo-specific Prisma error details are redacted to avoid leaking inputs or transcripts through validation errors.

The frontend-design guidance influenced the navy receptionist console, customer-facing website preview, expandable widget and screen-sharing-oriented hierarchy. The website is a personalized template, **not a clone of the company's current website**. Existing public presentation snapshots can use it without regenerating their business facts.

## Functional vs. simulated

| Area                  | Boundary                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Chat                  | Real AI calls when enabled and configured; stored demo-only conversation history                                  |
| Voice                 | Real browser microphone/WebRTC/audio implementation; live paid-provider audio not exercised during implementation |
| Website               | Working personalized presentation and chat UI; not a production website deployment or exact clone                 |
| Booking               | Simulated slots and confirmations persisted only in `SalesDemoSession.booking`                                    |
| Missed-call / nurture | Visual examples only; no SMS, emails, workflow enrollment or phone calls                                          |
| ROI                   | Real calculations from editable assumptions; no forecast or measured customer revenue                             |
| Website observations  | Existing bounded homepage research; not a measured SEO/performance audit                                          |
| GBP                   | Reference URL only; profile/review data is not fetched                                                            |

The UI never substitutes a canned response when a live AI request fails. It shows a setup or connection error. Automated test doubles exist only in test code, not as a production fallback.

## Configuration and limits

Committed defaults remain:

```dotenv
DEMO_ENGINE_ENABLED=false
DEMO_AI_ENABLED=false
DEMO_VOICE_ENABLED=false
DEMO_OPENAI_API_KEY=""
DEMO_CHAT_MODEL="gpt-4.1-mini"
DEMO_VOICE_MODEL="gpt-realtime-mini"
```

`DEMO_OPENAI_API_KEY` optionally overrides `OPENAI_API_KEY`. Keys stay on the server. Enable chat with the engine and AI flags; voice additionally requires the voice flag. `ADMIN_USERNAME` and a strong `ADMIN_PASSWORD` are required. Use `APP_URL` matching the external origin behind an HTTPS proxy. The readiness indicators check configuration presence, **not account credit, model permission or a successful provider connection**.

Server limits are intentionally conservative and currently defined in `src/demo-engine/live-runtime.ts`: 40 new conversations total per UTC day, 10 per demo per UTC day, 10 voice sessions per UTC day, four concurrent sessions across all demos/replicas, 10-minute chat sessions, three-minute voice sessions, and 20 turns per session (voice includes setup/response accounting). Chat inputs are at most 1,500 characters; provider output configuration is capped at 512 tokens. Failed/abandoned starts consume quota. These are usage limits, **not a guaranteed dollar-denominated budget**; model pricing and provider failure modes still require operator spend monitoring.

Session creation uses a PostgreSQL advisory transaction lock so concurrent replicas cannot bypass quotas. Conversation credentials are random, demo/channel/preview scoped, hashed in the DB and held only in browser memory. Signed page credentials expire after one hour and are tied to the current demo version. Public links are bearer access: anyone with an active link can use its allowed AI quota.

The server watchdog retries pending provider hangups, ends expired/revoked calls and checks persisted call IDs after restart. A healthy replica does not kill another replica's active call. Ending a call or leaving the page stops local microphone tracks. Graceful shutdown attempts to end locally controlled voice calls before DB disconnection. A hard server/provider/network outage can delay provider-side termination; browser WebRTC cleanup and the recovered watchdog are safeguards, not a provider-independent billing guarantee. Before disabling/restarting the entire demo engine, end active calls and verify cleanup; keep at least one healthy instance running through that process.

Only approved public business fields enter model prompts. Private sales notes and business phone references do not. Chat messages and demo booking data persist; voice transcripts are displayed in the browser but are not stored by this application. Conversations/audio are sent to OpenAI under the operator's provider account terms. No automated data-retention/deletion schedule is included; decide retention before broad sharing. Use fictional customer details.

## Database change

Migration: `prisma/migrations/20260907190000_add_live_demo_sessions/migration.sql`.

Adds only `SalesDemoSession` and its foreign key to `SalesDemo` (`ON DELETE CASCADE`). Fields include demo/version, channel/preview scope, hashed credential, expiry/end/busy timestamps, turn count, JSON messages/booking, provider call ID and creation time. Unique indexes cover credential hash and provider call ID; query indexes cover demo/time, channel/active expiry and creation time. Adds the inverse `SalesDemo.sessions` relation. No production client, booking, prospect or messaging table is changed.

All migrations were applied to a disposable local PostgreSQL database. Prisma's baseline-to-current schema diff generates exactly this new table/index/FK change. Comparing the entire historical migration chain with the current schema also reveals existing, unrelated drift: three truncated index names (`LeadContactPermission`, `RealEstateListingSourceRecord`, `RealEstateListingSourceVersion`) and the `RealEstateListing.lead_id` foreign-key behavior. Those were not silently changed by this implementation.

## Routes

Both authenticated private previews and published public demos use the same runtime. Their bases are `/admin/demos/:id/live` and `/demo/:token/live` respectively:

| Method | Suffix                         | Purpose                                  |
| ------ | ------------------------------ | ---------------------------------------- |
| POST   | `/sessions`                    | Explicitly start a chat or voice session |
| POST   | `/sessions/:sessionId/message` | Send a chat turn                         |
| POST   | `/sessions/:sessionId/voice`   | Exchange SDP for one voice connection    |
| GET    | `/sessions/:sessionId`         | Read ended state and demo booking        |
| POST   | `/sessions/:sessionId/end`     | End the conversation / hang up           |

Assets: `GET /demo/assets/experience.css` and `GET /demo/assets/experience.js`. Existing `/admin/demos/:id/preview` and `/demo/:token` render the new experience. Existing creation/edit/review/publish/archive/event routes remain in place. No production chatbot or voice endpoint is exposed through the demo UI.

## Exact local test steps

Never point these commands at Railway or a customer database. The integration/browser suites require `NODE_ENV=test`, a loopback database host and a database named `steel_scale_demo_*test`. They can delete demo fixtures. Run suites sequentially on a shared test database.

1. Install dependencies and start a separate database:

   ```bash
   npm ci
   docker run -d --name steel-scale-demo-local \
     -e POSTGRES_PASSWORD=demo_local_only \
     -e POSTGRES_DB=steel_scale_demo_local_test \
     -p 127.0.0.1:54330:5432 postgres:16-alpine
   export DATABASE_URL='postgresql://postgres:demo_local_only@127.0.0.1:54330/steel_scale_demo_local_test'
   npm run prisma:deploy
   npm run prisma:generate
   ```

2. Run automated tests without live provider spending:

   ```bash
   npm run typecheck
   npm run lint
   npm run format:check
   npm run build
   npm run test:demos
   NODE_ENV=test npm run test:demos:integration
   npx playwright-core install chromium --only-shell
   NODE_ENV=test npm run test:demos:browser
   ```

   Browser screenshots are written to `docs/testing/live-demo/` (or `DEMO_SCREENSHOT_DIR`). Set `CHROME_PATH` to use a compatible installed browser instead. The browser suite uses real application routes and PostgreSQL for chat, fake AI responses, and fake microphone/WebRTC transports. Separate integration tests exercise real local WebSocket sideband connections. **These are not proof of a successful paid OpenAI audio call.**

3. For your own real conversation, configure a valid OpenAI key privately in your local environment or untracked `.env`, and explicitly enable the flags below. This step incurs provider usage. The exported `DATABASE_URL` above must still point to the separate local database.

   ```bash
   export ADMIN_USERNAME='demo-admin'
   export ADMIN_PASSWORD='replace-with-a-strong-local-password'
   export DEMO_ENGINE_ENABLED=true
   export DEMO_AI_ENABLED=true
   export DEMO_VOICE_ENABLED=true
   export APP_URL='http://localhost:3000'
   npm run dev
   ```

4. Open `http://localhost:3000/admin/demos`. Log in, click **Create demo**, enter the company facts, and select voice and chatbot (or use a recommendation including both). Create the draft and open **Preview privately**. Enter accurate services, hours and a useful public summary before a sales call. Private preview supports real AI but does not track public engagement.

5. Click **Start conversation**, allow the microphone and talk to the receptionist. Test interrupting, mute/unmute, end-call and the transcript. Ask about a supplied service, then try booking an illustrative time. No real appointment should be created. Confirm the app's voice session ends when the call ends; check provider usage separately.

6. Open the website chat, ask a free-form question and confirm a demo appointment. Check the activity/appointment card. Try reset and a second conversation. If setup is unavailable, check flags/key/model access; if voice fails, check microphone permission, HTTPS/localhost, audio permission, account credit, outbound access to `api.openai.com`, and server-side WebSocket connectivity.

7. Review the page, explicitly publish it, then open the share link in another browser. Confirm public interaction, expiry and archive behavior. Do not share fictional test data as a real customer deployment.

## Railway “Not found”

The existing source deliberately returns 404 for all demo routes when `DEMO_ENGINE_ENABLED` is not exactly `true`. Draft, expired and archived public links also return 404. A Railway service still running an older build can also lack these routes. This work does not change Railway: check its deployed revision, migration status and feature flag before scheduling a sales call. Enabling live AI requires the additional flags/key above. Do not enable the feature against an unmigrated database. No deployment or production configuration was performed here.

## Remaining work / validation limits

- Real paid OpenAI chat and audible microphone-to-receptionist acceptance testing with the operator's account is still required. Safari, mobile audio policies, real network interruption and multi-replica deployment need staging acceptance tests.
- This is not an exact clone of each prospect's website or production Vapi agent. Logos, imagery, exact production agent identity and deeper custom branding are not automatically imported.
- Real booking, SMS, transfers, reviews/GBP enrichment, client onboarding/portal and automatic sales prioritization are intentionally outside this live-demo milestone.
- No automatic retention cleanup, bot-proof identity verification or hard currency spend budget is implemented.
- The broader product-spec roadmap remains a roadmap; these UI changes do not mark those milestones complete.

Provider implementation references: [OpenAI WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc), [server-side controls](https://developers.openai.com/api/docs/guides/realtime-server-controls), [hangup API](https://developers.openai.com/api/reference/resources/realtime/subresources/calls/methods/hangup), and [Responses text output](https://developers.openai.com/api/docs/guides/text).

See `LIVE_DEMO_VERIFICATION.md` for the exact file inventory and final verification outcomes. No commit, push, merge, PR or deployment was made.
