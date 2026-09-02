# Steel Scale Internal Setup Guide

This is the internal, end-to-end setup and operations guide for the complete Steel Scale system. It covers local development, PostgreSQL, Railway deployment, client configuration, booking infrastructure, Lead Intelligence, pipeline scheduling, qualified-lead delivery, the prospecting call queue, tests, and production verification.

Use [DEPLOYMENT.md](./DEPLOYMENT.md) as the shorter Railway-only reference. This document is the detailed operator runbook.

> **Safety rule:** start with dry-run settings and test accounts. Do not connect production phone numbers, enable real text messages, import prospects into live workflows, or accept customer traffic until the relevant verification checklist passes.

## 1. System overview

Steel Scale is an Express and TypeScript application backed by PostgreSQL through Prisma. It currently provides:

- Multi-client configuration and protected internal administration.
- Twilio missed-call SMS follow-up.
- Vapi call-event and booking handling.
- OpenAI, Anthropic, or mock-powered website chatbot conversations.
- Zapier and GHL booking delivery with GHL safety-net fallback.
- Slack booking alerts and daily operational summaries.
- Outscraper Google Maps ingestion.
- Website Intelligence enrichment.
- Deterministic Voice AI and Real Estate Video scoring.
- Offer recommendations and prospect filtering.
- Real-estate listing ingestion and agent intelligence.
- Scheduled Lead Intelligence pipeline orchestration.
- Qualified-lead delivery to GHL, Zapier, CSV, or a human call queue.
- A ranked prospecting call queue with notes, outcomes, follow-ups, and conversion reporting.

The application intentionally does **not**:

- Automatically cold-call prospects.
- Treat a scraped phone number as permission to text.
- Automatically send unsolicited SMS from GHL lead delivery.
- Use an LLM for numeric lead scoring or primary-offer selection.

## 2. Architecture at a glance

```text
Twilio status callback ─┐
Vapi webhook ──────────┼──> Express application ──> PostgreSQL
Website chatbot ───────┘            │
                                    ├──> Zapier/GHL booking delivery
                                    ├──> Slack operational alerts
                                    └──> Protected internal admin

Lead discovery/file import
  -> canonical ingestion and deduplication
  -> website/listing enrichment
  -> deterministic scoring
  -> offer recommendation
  -> qualified-lead delivery
  -> human prospecting call queue
```

Important route groups:

| Route                                   | Purpose                             | Authentication                  |
| --------------------------------------- | ----------------------------------- | ------------------------------- |
| `GET /health`                           | Basic process health                | Public                          |
| `/admin`                                | Client operations                   | Admin Basic Auth                |
| `/admin/leads`                          | Lead Intelligence dashboard         | Same admin Basic Auth           |
| `/admin/call-queue`                     | Human prospecting call desk         | Same admin Basic Auth           |
| `POST /internal/cron/daily-summary`     | Daily Slack report                  | `CRON_SECRET`                   |
| `POST /internal/cron/lead-intelligence` | Scheduled lead pipelines            | `CRON_SECRET`                   |
| `POST /webhooks/twilio/voice-status`    | Twilio call status                  | Twilio validation/configuration |
| `POST /webhooks/vapi`                   | Vapi server events and tool calls   | `VAPI_WEBHOOK_SECRET`           |
| `POST /internal/bookings`               | Shared internal booking entry point | Internal application workflow   |
| `/chatbot`                              | Chatbot API                         | Client-scoped request data      |
| `/widget/chatbot-widget.js`             | Embeddable client widget            | Public static asset             |

## 3. Accounts and credentials

For the full production system, obtain access to:

- A private GitHub repository.
- Railway with billing enabled.
- Railway PostgreSQL or another supported PostgreSQL installation.
- Twilio with a message-capable number.
- Vapi with an assistant and phone number.
- OpenAI or Anthropic for production chatbot conversations.
- GoHighLevel with a location and safety-net calendar.
- Zapier when a client uses Zapier delivery.
- Slack with an incoming webhook for a private operations channel.
- Outscraper for Google Maps discovery or exported results.
- Apify or another listing provider for automated real-estate discovery.

Keep secrets in `.env` locally and in Railway Variables for production. Never place secrets in source files, commits, screenshots, tickets, or client-facing documents.

## 4. Local prerequisites

Install:

- Node.js 20 or newer.
- npm.
- PostgreSQL 16 or a compatible supported release.
- Git.

Verify them:

```bash
node --version
npm --version
git --version
psql --version
```

## 5. Install the repository

From the repository root:

```bash
npm install
cp .env.example .env
```

Confirm `.env` is ignored:

```bash
git check-ignore .env
```

If that command prints `.env`, it is ignored correctly.

## 6. Configure local PostgreSQL

Create a local database called `steel_scale`. One common command is:

```bash
createdb steel_scale
```

Set the matching URL in `.env`:

```text
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/steel_scale?schema=public
```

Change the username, password, host, port, or database name to match your installation.

Some integration scripts default to port `54329` when `DATABASE_URL` is absent. Setting `DATABASE_URL` explicitly prevents that test fallback from being used.

Apply the schema and seed a safe test client:

```bash
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed
```

The seed creates:

- Client ID: `00000000-0000-4000-8000-000000000001`
- Business: `Acme Home Services`
- Phone: `+15550102030`
- Fake Zapier and Vapi configuration values.

Do not point seeded provider IDs or URLs at production services.

### Migration commands explained

- `npm run prisma:migrate` runs `prisma migrate dev`; use it locally when developing.
- `npm run prisma:deploy` runs `prisma migrate deploy`; use it in production and CI.
- `npm run prisma:generate` regenerates the TypeScript Prisma client.
- `npm run prisma:seed` inserts or updates the deterministic local test client.

Never run `prisma migrate dev` against production.

## 7. Local environment configuration

Begin with conservative settings:

```text
NODE_ENV=development
LOG_LEVEL=info
PORT=3000

DATABASE_URL=postgresql://postgres:postgres@localhost:5432/steel_scale?schema=public

TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_SMS_DRY_RUN=true

VAPI_WEBHOOK_SECRET=replace_with_a_long_random_local_secret

LLM_PROVIDER=mock
LLM_MODEL=mock

GHL_API_KEY=your_ghl_api_key
GHL_LOCATION_ID=your_ghl_location_id
GHL_FALLBACK_CALENDAR_ID=your_safety_net_calendar_id
GHL_API_BASE_URL=https://services.leadconnectorhq.com
BOOKING_DELIVERY_DRY_RUN=true

ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace_with_a_long_random_password

SLACK_WEBHOOK_URL=https://hooks.slack.com/services/your/incoming/webhook
CRON_SECRET=replace_with_a_different_long_random_secret

LEAD_PIPELINE_CAMPAIGNS_JSON=[]
```

Keep `TWILIO_SMS_DRY_RUN=true`, `BOOKING_DELIVERY_DRY_RUN=true`, and `LLM_PROVIDER=mock` during initial local setup.

### Environment-variable reference

| Variable                       | Required              | Purpose                                                                        |
| ------------------------------ | --------------------- | ------------------------------------------------------------------------------ |
| `DATABASE_URL`                 | Yes                   | PostgreSQL connection URL.                                                     |
| `NODE_ENV`                     | Production            | Use `production` on Railway.                                                   |
| `LOG_LEVEL`                    | No                    | Pino log level; normally `info`.                                               |
| `PORT`                         | Local only            | Local port. Railway injects this automatically.                                |
| `TWILIO_ACCOUNT_SID`           | For Twilio SMS        | Twilio project identity.                                                       |
| `TWILIO_AUTH_TOKEN`            | For Twilio SMS        | Twilio authentication and request validation credential.                       |
| `TWILIO_SMS_DRY_RUN`           | Recommended           | Prevents real texts while testing.                                             |
| `VAPI_WEBHOOK_SECRET`          | Strongly recommended  | Authenticates Vapi webhook calls.                                              |
| `VAPI_API_KEY`                 | No                    | Present as a reserved placeholder; outbound Vapi calls are not currently used. |
| `LLM_PROVIDER`                 | For chatbot           | `openai`, `anthropic`, or `mock`.                                              |
| `LLM_MODEL`                    | Optional              | Overrides the selected provider model.                                         |
| `OPENAI_API_KEY`               | Conditional           | Required for the OpenAI chatbot provider.                                      |
| `ANTHROPIC_API_KEY`            | Conditional           | Required for the Anthropic chatbot provider.                                   |
| `GHL_API_KEY`                  | For GHL               | GHL API credential.                                                            |
| `GHL_LOCATION_ID`              | For GHL               | GHL location receiving contacts and appointments.                              |
| `GHL_FALLBACK_CALENDAR_ID`     | For booking fallback  | Safety-net calendar after primary delivery failure.                            |
| `GHL_API_BASE_URL`             | No                    | Defaults to `https://services.leadconnectorhq.com`.                            |
| `BOOKING_DELIVERY_DRY_RUN`     | Recommended           | Prevents real booking delivery during setup.                                   |
| `ADMIN_USERNAME`               | Yes for admin         | Basic Auth username.                                                           |
| `ADMIN_PASSWORD`               | Yes for admin         | Strong Basic Auth password.                                                    |
| `SLACK_WEBHOOK_URL`            | Strongly recommended  | Booking and lead-pipeline alerts plus daily reporting.                         |
| `CRON_SECRET`                  | Yes for cron          | Protects both internal cron routes.                                            |
| `LEAD_PIPELINE_CAMPAIGNS_JSON` | For Phase 9 scheduler | JSON array of pipeline campaign definitions.                                   |

## 8. Start the application locally

```bash
npm run dev
```

In another terminal:

```bash
curl --fail http://localhost:3000/health
```

Expected response:

```json
{ "status": "ok" }
```

The health route confirms the HTTP process is running. It does not perform a database query, so also open the admin to verify database access:

```text
http://localhost:3000/admin
```

Sign in using `ADMIN_USERNAME` and `ADMIN_PASSWORD`. The admin fails closed when either value is missing.

Verify these pages:

- `/admin` — client configuration and booking operations.
- `/admin/leads` — Lead Intelligence prospect dashboard.
- `/admin/call-queue` — ranked human call queue.

## 9. Run local verification

Run the foundational flows:

```bash
npm run test:missed-call
npm run test:vapi-booking
npm run test:chatbot
npm run test:booking-routing
npm run test:admin
npm run test:daily-summary
```

Run the Lead Intelligence tests:

```bash
npm run test:lead-intelligence-phase-1
npm run test:lead-intelligence-phase-2
npm run test:lead-intelligence-phase-3
npm run test:lead-intelligence-phase-4
npm run test:lead-intelligence-phase-5
npm run test:lead-intelligence-phase-6
npm run test:lead-intelligence-phase-7
npm run test:lead-intelligence-phase-8
npm run test:lead-intelligence-phase-9
npm run test:lead-intelligence-phase-10
npm run test:lead-intelligence-phase-11
```

Then run all static checks:

```bash
npm run format:check
npm run typecheck
npm run lint
npm run build
```

Tests require the migrated PostgreSQL database. If a test reports that it cannot reach `localhost:54329`, either start the expected test database or set `DATABASE_URL` to your working local database before running it:

```bash
export DATABASE_URL='postgresql://postgres:postgres@localhost:5432/steel_scale?schema=public'
npm run test:lead-intelligence-phase-11
```

## 10. Create and configure clients

Open `/admin` and select **Add client**. Configure:

- Business name.
- Main phone in E.164 format, such as `+14125550123`.
- IANA timezone, such as `America/New_York`.
- Offered services.
- Missed-call SMS template.
- Primary booking destination.
- Vapi assistant and phone-number IDs.
- Client-specific voice system prompt.

The phone must exactly match the number appearing in provider callbacks. This is how the application resolves the correct client.

## 11. Chatbot provider setup

Use mock mode for safe local tests:

```text
LLM_PROVIDER=mock
LLM_MODEL=mock
```

For OpenAI production use:

```text
LLM_PROVIDER=openai
LLM_MODEL=gpt-5.4-nano
OPENAI_API_KEY=...
```

For Anthropic production use:

```text
LLM_PROVIDER=anthropic
LLM_MODEL=your_supported_model
ANTHROPIC_API_KEY=...
```

Remove unused provider keys from production variables.

Embed the widget on a client website:

```html
<script
  src="https://YOUR_APP_DOMAIN/widget/chatbot-widget.js"
  data-api-base="https://YOUR_APP_DOMAIN"
  data-client-id="CLIENT_UUID"
></script>
```

Test desktop, mobile, conversation persistence, and one controlled booking before publishing the client website.

## 12. Configure GHL and Zapier booking delivery

### GHL safety net

In the appropriate GHL location:

1. Create a dedicated calendar such as `Steel Scale — Manual Follow-up`.
2. Obtain an API credential with contact and calendar access.
3. Copy the location and calendar IDs.
4. Set `GHL_API_KEY`, `GHL_LOCATION_ID`, and `GHL_FALLBACK_CALENDAR_ID`.
5. Assign an operator to monitor the safety-net calendar.

### Zapier primary destination

For clients using Zapier:

1. Create a Catch Hook trigger.
2. Build the downstream calendar or CRM action.
3. Test with non-production contact data.
4. Paste the HTTPS hook URL into the client's admin configuration.

When primary booking delivery fails, Steel Scale retries and then uses the configured GHL fallback. If both fail, the booking remains flagged and Slack receives an operational alert.

## 13. Configure Slack

1. In Slack, open **Tools & settings → Manage apps**.
2. Add **Incoming WebHooks** to a private operations channel.
3. Save the webhook URL as `SLACK_WEBHOOK_URL`.
4. Generate a separate strong `CRON_SECRET`.

Slack receives material operational events, including:

- Booking delivery failure after fallback.
- Daily operational summaries.
- Complete Lead Intelligence pipeline failures.
- Discovery or ingestion failures.
- Aggregate website-enrichment failure rates over the alert threshold.
- Stale real-estate discovery sources.
- Scoring runs that unexpectedly yield no qualified leads.

Individual harmless website failures do not generate one Slack message each.

## 14. Configure Vapi

1. Open Vapi → **Assistants** and select the production assistant.
2. Open **Advanced → Webhook Server**.
3. Set the server URL to:

   ```text
   https://YOUR_APP_DOMAIN/webhooks/vapi
   ```

4. Use a request timeout of at least 30 seconds.
5. Enable `status-update`, `end-of-call-report`, and `tool-calls` messages.
6. Create a custom Bearer credential whose token exactly matches `VAPI_WEBHOOK_SECRET`.
7. Attach it to the server configuration.
8. Save and publish changes.
9. Assign the assistant to the correct Vapi phone number.
10. Store that assistant ID and phone-number ID in the client's admin configuration.

Make a controlled call and confirm the client's admin detail shows the resulting `CallLog`. Complete a controlled booking and verify its `BookingAttempt`.

## 15. Configure Twilio

`POST /webhooks/twilio/voice-status` is a **status callback**, not an incoming-call TwiML endpoint. Do not put it in Twilio's **A call comes in** field.

1. Keep incoming-call routing pointed at Vapi, Studio, a TwiML Bin, or the system that answers the call.
2. Set the call flow or dialed leg's status callback to:

   ```text
   https://YOUR_APP_DOMAIN/webhooks/twilio/voice-status
   ```

3. Use HTTP `POST`.
4. Ensure final statuses such as `busy`, `canceled`, `failed`, and `no-answer` are delivered.
5. Use Twilio credentials from the same project as the phone number.
6. Match the client's configured E.164 phone exactly.
7. Keep `TWILIO_SMS_DRY_RUN=true` until a controlled test is ready.

If the Vapi number was imported from Twilio, preserve Vapi's incoming routing and add callbacks only in a supported location in that call flow.

## 16. Lead Intelligence: manual Outscraper import

Export Google Maps results from Outscraper as JSON or CSV. Then run:

Use [`LEAD_SOURCE_TEMPLATES.md`](./LEAD_SOURCE_TEMPLATES.md) for the ready-to-copy Outscraper search plan, Apify Zillow Search → Detail templates, recommended limits, and the accepted real-estate output contract.

### Recommended: protected admin import wizard

Open `/admin/leads`, select **Import Outscraper file**, and:

1. Select the client that owns the prospects.
2. Choose the downloaded Outscraper JSON or CSV file. JSON is preferred because it preserves nested evidence.
3. Select **Preview and map fields**.
4. Review the automatically suggested mappings and correct any provider-specific column names.
5. Select **Import mapped records** and keep the page open until the ingestion report appears.

The wizard uses the existing protected admin authentication, accepts files up to 25 MB and 25,000 records, retains original source fields, and uses a stable generated idempotency key so retrying the same file does not create a duplicate batch.

### Command-line alternative

```bash
npm run import:outscraper -- \
  --client-id CLIENT_UUID \
  --file ./path/to/outscraper-results.json \
  --idempotency-key restoration-pa-2026-09-02 \
  --country-code 1
```

The idempotency key identifies that import. Reusing it intentionally returns the existing ingestion run instead of duplicating the operation. Use a meaningful stable key for the same source batch; use a new key for a genuinely new export.

The command reports received, created, updated, duplicate, rejected, and signal counts. Raw provider evidence is retained separately from canonical business data.

### AI-assisted lead analysis

After importing, enriching, and scoring leads:

1. Open `/admin/leads`.
2. Apply filters if you want the analysis limited to a client, offer, state, niche, or score range.
3. Select **Analyze top leads with AI**.
4. Wait for the report. The system sends at most 25 scored prospects and displays up to 10 ranked recommendations.
5. Open a prospect to review the underlying deterministic score and source evidence before outreach.

The analyst uses the existing `OPENAI_API_KEY`. Optionally set `LEAD_ANALYST_MODEL`; otherwise it uses `LLM_MODEL`, followed by the application's default model. The AI writes fit summaries, sales angles, notes, and evidence warnings. It does not change numeric scores or primary offers, contact prospects, or grant permission to text.

## 17. Website Intelligence enrichment

Audit websites for a client:

```bash
npm run audit:websites -- \
  --client-id CLIENT_UUID \
  --concurrency 3 \
  --limit 100 \
  --stale-hours 720
```

Operational guidance:

- Start at concurrency `2` or `3`.
- Increase only after reviewing host load and target failure rates.
- Use `--stale-hours 720` for a roughly 30-day refresh window.
- A website failure is recorded and does not stop other businesses.
- Audits remain bounded by timeout, retry, page-count, redirect, and same-domain rules.

The admin detail page explains successful evidence. A missing detection is not automatically treated as proof that a feature is absent unless the detector stored an evidence-backed result.

## 18. Scoring and recommendations

Voice AI and Real Estate Video scores are deterministic, versioned, and stored as immutable snapshots. The UI shows the factors that produced the current score.

The system currently supports offer identifiers:

- `VOICE_AI`
- `REAL_ESTATE_VIDEO`
- `WEBSITE`
- `SEO_RANKING`
- `REVIEWS`

Only offers with implemented scoring rules should be used for automated qualification. Re-scoring creates a new snapshot and does not erase the previous valid score.

Use `/admin/leads` to inspect:

- Current score and band.
- Primary recommended offer.
- Website and listing evidence.
- Source freshness.
- Outreach and suppression state.
- Qualification explanations.

## 19. Automated Lead Intelligence pipelines

The protected scheduler route is:

```text
POST /internal/cron/lead-intelligence
Authorization: Bearer <CRON_SECRET>
```

Pipeline campaigns are read from `LEAD_PIPELINE_CAMPAIGNS_JSON`. Example configuration:

```json
[
  {
    "key": "voice-ai-restoration-pa",
    "clientId": "CLIENT_UUID",
    "source": "outscraper_google_maps",
    "enabled": true,
    "enrichmentConcurrency": 3,
    "scoringConcurrency": 5,
    "reviewScoreThreshold": 75,
    "retry": {
      "attempts": 3,
      "initialDelayMs": 500,
      "maximumDelayMs": 5000
    },
    "discovery": {
      "kind": "outscraper_google_maps",
      "keywords": ["water damage restoration", "fire damage restoration", "mold remediation"],
      "locations": ["Pittsburgh PA", "Philadelphia PA", "Harrisburg PA", "Erie PA"],
      "maximumResults": 500,
      "minimumReviews": 10,
      "states": ["PA"]
    }
  }
]
```

### Required provider registration

`LEAD_PIPELINE_CAMPAIGNS_JSON` defines **what** to search. It does not contain or instantiate an Outscraper or Apify HTTP client. The application currently uses a provider-neutral discovery registry so canonical ingestion remains decoupled from vendors.

Before enabling the scheduled route, a programmatic provider implementation must be registered during application startup with `registerLeadDiscoveryProvider()` from:

```text
src/lead-intelligence/pipeline/scheduler.ts
```

Register `outscraper_google_maps`, `real_estate`, or both. The provider receives the campaign's discovery configuration and returns records plus an optional source reference. Until that startup wiring exists, leave `LEAD_PIPELINE_CAMPAIGNS_JSON=[]` and use file import; otherwise the pipeline will record a provider failure and alert Slack.

The pipeline stages are:

```text
DISCOVER
-> INGEST
-> DEDUPLICATE
-> ENRICH
-> SCORE
-> RECOMMEND
-> QUEUE_FOR_REVIEW
```

Every execution creates or reuses a durable `PipelineRun`. The hourly campaign key and ingestion keys make restarts safe. Provider, website, and individual scoring failures are isolated.

## 20. Qualified-lead delivery

Delivery is separate from scoring. A `DeliveryCampaign` defines:

- Explicit campaign ID and unique campaign key.
- Offer.
- Minimum score.
- Destination.
- Required phone or approved contact channel.
- Maximum listing age when applicable.
- Recent-contact cooldown.
- Payload version.
- Destination configuration.

Supported destinations:

- `GHL`
- `ZAPIER_WEBHOOK`
- `CSV_EXPORT`
- `CALL_QUEUE`

Each attempt creates a `DeliveryRecord`. The unique `(campaignId, leadId)` constraint prevents accidental duplicate delivery. Failed deliveries retain their error and have an explicit retry path.

### GHL safety behavior

Qualified-lead GHL delivery only upserts a contact tagged for Lead Intelligence and manual review. It does not create an appointment, initiate an SMS, or deliberately activate an unsolicited messaging workflow. Configure GHL automation so the imported tags do not trigger outbound SMS unless your approved workflow and consent rules allow it.

### Compliance and contact permission

The database tracks these separately:

- Contactable prospect.
- Manual-call candidate.
- SMS consent status.
- SMS eligibility.
- Do-not-contact status.
- Opt-out timestamp.
- Suppression.
- Consent source and recorded timestamp.

A scraped phone number does not grant SMS permission. `smsEligible` becomes true only when consent is explicitly recorded with a source and the lead is neither suppressed nor do-not-contact. Opt-out immediately removes SMS eligibility.

## 21. Prospecting call queue

Open:

```text
/admin/call-queue
```

The page ranks callable prospects using:

- Current primary-offer score.
- Signal freshness.
- Listing or opportunity recency.
- Previous attempt count.
- Cooldown status.
- Due follow-up dates.
- Manual priority.

It shows the salesperson:

- Who to call next.
- Phone and website.
- Offer score and band.
- Evidence-backed qualification reasons.
- Suggested pitch angle.
- Previous call state.
- A form for outcome, notes, and next follow-up.

Supported outcomes:

- Not called.
- No answer.
- Gatekeeper.
- Owner reached.
- Interested.
- Follow up.
- Demo booked.
- Not interested.
- Bad fit.
- Do not contact.

No call is placed automatically. Selecting do-not-contact updates both the queue/outreach state and contact-permission state.

Call history powers conversion reporting by niche, score band, and pitch angle. Preserve this data; it is intended to improve future deterministic scoring decisions based on real sales outcomes.

## 22. Deploy to Railway

### Create the project

1. Commit the repository and push it to a private GitHub repository.
2. Railway → **New Project** → **Deploy from GitHub repo**.
3. Select the repository.
4. Add a PostgreSQL service from **Create → Database → Add PostgreSQL**.
5. In the application service, set:

   ```text
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   ```

   Replace `Postgres` if your database service uses another name.

### Configure production variables

Use Railway's variable editor:

```text
NODE_ENV=production
LOG_LEVEL=info
DATABASE_URL=${{Postgres.DATABASE_URL}}

TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_SMS_DRY_RUN=false

VAPI_WEBHOOK_SECRET=...

LLM_PROVIDER=openai
LLM_MODEL=gpt-5.4-nano
OPENAI_API_KEY=...

GHL_API_KEY=...
GHL_LOCATION_ID=...
GHL_FALLBACK_CALENDAR_ID=...
GHL_API_BASE_URL=https://services.leadconnectorhq.com
BOOKING_DELIVERY_DRY_RUN=false

ADMIN_USERNAME=...
ADMIN_PASSWORD=...

SLACK_WEBHOOK_URL=...
CRON_SECRET=...

LEAD_PIPELINE_CAMPAIGNS_JSON=[]
```

Leave the pipeline array empty until programmatic discovery providers are registered and tested.

Railway injects `PORT`; do not set it manually.

### Configure build and deploy

In the application service settings use:

```text
Build command: npm run build
Pre-deploy command: npm run prisma:deploy
Start command: npm run start
Healthcheck path: /health
Healthcheck timeout: 120 seconds
Restart policy: On Failure
```

The checked-in `railway.json` contains the same basic configuration, but the Railway dashboard is the authoritative configuration for a new service.

Generate a public HTTPS domain under **Settings → Networking** and record it as `APP_URL`.

## 23. Configure schedulers

Use Railway Cron, GitHub Actions, cron-job.org, or another trusted scheduler.

Daily summary, once per day:

```bash
curl --fail --request POST \
  --header "Authorization: Bearer $CRON_SECRET" \
  "$APP_URL/internal/cron/daily-summary"
```

Lead Intelligence, at the interval appropriate for your provider quotas and campaigns:

```bash
curl --fail --request POST \
  --header "Authorization: Bearer $CRON_SECRET" \
  "$APP_URL/internal/cron/lead-intelligence"
```

`X-Cron-Secret` is also accepted when a scheduler cannot set an Authorization header. Never place `CRON_SECRET` in a query string.

Do not schedule the lead route until discovery providers are registered, campaign JSON is valid, and one manual invocation succeeds.

## 24. Production smoke test

Verify the release:

```bash
curl --fail "$APP_URL/health"
curl --fail --user "$ADMIN_USERNAME:$ADMIN_PASSWORD" "$APP_URL/admin"
curl --fail --user "$ADMIN_USERNAME:$ADMIN_PASSWORD" "$APP_URL/admin/leads"
curl --fail --user "$ADMIN_USERNAME:$ADMIN_PASSWORD" "$APP_URL/admin/call-queue"
```

Then verify each configured integration with controlled data:

1. One Vapi test call creates a call log.
2. One Vapi booking reaches the intended destination.
3. One intentionally unanswered Twilio test call produces exactly one dry-run or approved real SMS.
4. One chatbot booking reaches the shared booking workflow.
5. One daily-summary request reaches Slack.
6. One Outscraper fixture or small export imports successfully.
7. One website audit stores evidence without affecting production booking routes.
8. One scored prospect renders its explanation in `/admin/leads`.
9. One test qualified lead enters a non-production call queue.
10. One recorded call outcome updates queue metrics.

Do not use a real prospect for the first delivery or call-queue test.

## 25. Production launch checklist

- [ ] GitHub repository is private.
- [ ] `.env` is not tracked.
- [ ] Railway PostgreSQL is healthy.
- [ ] Every Prisma migration completed.
- [ ] `/health` returns HTTP 200.
- [ ] Admin authentication works.
- [ ] Strong unrelated admin, cron, and Vapi secrets are installed.
- [ ] Production LLM provider is configured.
- [ ] GHL location and safety-net calendar are correct.
- [ ] Slack alerts reach the private operations channel.
- [ ] Vapi webhook authentication succeeds.
- [ ] Vapi call and booking tests succeed.
- [ ] Twilio callback is a status callback, not the incoming TwiML URL.
- [ ] Missed-call SMS was tested deliberately.
- [ ] Chatbot was tested on desktop and mobile.
- [ ] Lead Intelligence file import works.
- [ ] Website auditing limits are appropriate.
- [ ] Pipeline campaigns remain disabled until providers are registered.
- [ ] GHL Lead Intelligence tags do not trigger unsolicited SMS.
- [ ] Call queue is used for human calls only.
- [ ] Do-not-contact and opt-out behavior was verified.
- [ ] An operator owns failed bookings and pipeline alerts.

## 26. Routine operations

### Daily

- Read the Slack summary.
- Resolve failed booking alerts immediately.
- Review pipeline error summaries.
- Work the due call queue.
- Record every call outcome and useful note.
- Respect do-not-contact and opt-out state.

### Weekly

- Review conversion by niche, score band, and pitch angle.
- Review website-enrichment failure rates.
- Confirm provider balances and quotas.
- Confirm Railway application and PostgreSQL health.
- Review suppressed leads and failed deliveries.
- Check the GHL safety-net calendar.

### Before every release

```bash
npm run format:check
npm run typecheck
npm run lint
npm run build
```

Apply migrations through the configured Railway pre-deploy command. After release, repeat smoke tests proportional to what changed.

## 27. Backups and recovery

- Enable PostgreSQL backups appropriate to your Railway plan.
- Test restoring a backup before relying on it.
- Retain source payloads, score snapshots, delivery records, pipeline runs, and call attempts; they provide auditability.
- Do not manually delete failed pipeline or delivery records to retry them. Use their idempotent restart/retry paths.
- Before a high-risk migration, take a fresh database backup and verify the pre-deploy command in a staging environment.

## 28. Troubleshooting

### The server works but admin pages fail

`/health` does not query PostgreSQL. Check:

1. `DATABASE_URL` spelling and reachability.
2. PostgreSQL is running.
3. Migrations were applied.
4. Railway private reference variable uses the correct database service name.
5. Application logs for Prisma errors.

### Integration tests try port 54329

The scripts use that as a fallback. Export your actual database URL before running them:

```bash
export DATABASE_URL='postgresql://postgres:postgres@localhost:5432/steel_scale?schema=public'
```

### Admin returns 503 or does not prompt correctly

Set both `ADMIN_USERNAME` and `ADMIN_PASSWORD`, then restart the application.

### Cron returns 401

Confirm the supplied Bearer token exactly matches `CRON_SECRET`. Do not include quotes copied from the variable editor.

### Cron returns 503

`CRON_SECRET` is not configured in the running process.

### Lead pipeline reports no registered provider

Campaign JSON does not create provider clients. Register the relevant discovery provider in application startup or disable the campaign and use manual file import.

### Website enrichment has many failures

- Lower concurrency.
- Inspect recorded status/error details.
- Confirm outbound HTTPS access.
- Check whether target sites block automated fetchers.
- Do not turn failures into negative qualification claims.

### A lead does not appear in the call queue

Check:

1. It was delivered through a `CALL_QUEUE` campaign.
2. It has a usable phone.
3. The current score exists for the campaign offer.
4. The cooldown has expired.
5. The status is not terminal.
6. Contactability, suppression, and do-not-contact flags allow a call.
7. Its follow-up date is due.

### A prospect was not delivered twice

This is expected. A unique `(campaignId, leadId)` constraint prevents accidental duplicate delivery. Use a distinct intentional campaign when a genuinely separate campaign should receive the same lead.

### GHL contact did not receive an SMS

Qualified-lead delivery intentionally does not send SMS. SMS eligibility requires separately recorded consent and an explicitly configured downstream workflow.

### Formatting or build fails

Run:

```bash
npm run format
npm run typecheck
npm run lint
npm run build
```

Review the first reported error before changing dependencies or generated files.

## 29. Recommended rollout order

Use this order for a new environment:

1. PostgreSQL and migrations.
2. Health route and protected admin.
3. One test client.
4. Mock chatbot.
5. Zapier/GHL dry-run booking delivery.
6. Slack alerts and daily summary.
7. Vapi controlled call and booking.
8. Twilio controlled missed-call flow.
9. Small Outscraper file import.
10. Limited website audit.
11. Verify deterministic scores and recommendations.
12. Test CSV qualified-lead delivery.
13. Test a non-production call queue and call outcome.
14. Register and test automated discovery providers.
15. Enable one small scheduled campaign.
16. Gradually raise result and concurrency limits after reviewing error rates.

This order keeps production booking and voice infrastructure isolated while Lead Intelligence is being validated.
