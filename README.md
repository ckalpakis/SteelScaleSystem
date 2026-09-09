# Steel Scale System

For step-by-step Railway service setup and repeatable client onboarding, start with
[AI Workforce Setup and Client Onboarding](AI_WORKFORCE_SETUP_AND_CLIENT_ONBOARDING.md).

Business members can start at `/workspace` for launch guidance, personal human
handoffs, delivery warnings and evidence-based recovery results, then open the
tenant-scoped built-in CRM. See [the product workspace review and guide](docs/PRODUCT_WORKSPACE.md).

The opt-in [Agent Builder](docs/AGENT_BUILDER.md) converts natural-language requests into editable,
versioned blueprints with missing-configuration checks, safe previews and review-gated runtime
activation. Unsupported runtime behavior stays blocked; drafting and paid AI are disabled by
default. See [builder verification](docs/AGENT_BUILDER_VERIFICATION.md).

The opt-in universal [AI agent runtime](docs/AGENT_RUNTIME.md) supports versioned definitions,
Autopilot/Copilot/Advisory modes, server-enforced tools, approvals and bounded execution.
Existing recovery agents remain unchanged; real model calls and external executors are
disabled by default. See [runtime verification](docs/AGENT_RUNTIME_VERIFICATION.md).

Zapier/generic inbound and outbound integration is now available as an opt-in increment.
See [customer setup and API contract](docs/ZAPIER_INTEGRATION.md) and
[verification](docs/ZAPIER_VERIFICATION.md). Organization admins use `/integrations`;
platform operators use `/admin/integrations`. Outbound sending remains disabled by default.

A multi-tenant missed-call and booking automation service for home-service businesses, with lead intelligence and on-demand sales demos.

The additive AI workforce foundation is disabled by default. See [architecture and migration decisions](docs/ARCHITECTURE.md), [workforce API examples](docs/WORKFORCE_API.md), and [verification results](docs/WORKFORCE_VERIFICATION.md).

The canonical CRM increment supports service businesses across industries without requiring GHL. See [canonical data model](docs/CANONICAL_DATA_MODEL.md), [CRM API and admin UI](docs/CRM_API.md), and [CRM verification](docs/CRM_VERIFICATION.md). It is separately gated by `CRM_ENABLED=false`; existing production workflows remain in place.

The universal event layer normalizes CRM changes and authenticated external relays into canonical, tenant-scoped facts with durable idempotency and handler receipts. See [event architecture and examples](docs/EVENT_ARCHITECTURE.md) and [event verification](docs/EVENT_VERIFICATION.md). Existing v1 imports and GHL booking support are preserved.

Start with the [complete setup and launch guide](./GETTING_STARTED.md). For deployment-only instructions, see the [Railway deployment guide](./docs/DEPLOYMENT.md). For repeatable onboarding and delivery, use the [client fulfillment SOP](./CLIENT_FULFILLMENT.md).

## Prerequisites

- Node.js 20 or newer
- npm
- PostgreSQL

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy the environment template and update the values for your environment:

   ```bash
   cp .env.example .env
   ```

3. Generate the Prisma client:

   ```bash
   npm run prisma:generate
   ```

4. Create the database tables and seed the test client:

   ```bash
   npm run prisma:migrate -- --name initial_client_config
   npm run prisma:seed
   ```

5. Start the development server:

   ```bash
   npm run dev
   ```

The API listens on `http://localhost:3000` by default. The current health endpoint does not require an active database connection.

## Test the missed-call text-back flow

After migrating and seeding the database, run the local simulator:

```bash
npm run test:missed-call
```

The simulator posts a Twilio-style `no-answer` callback for the seeded client, forces SMS dry-run mode, and prints the resulting `CallLog`. A successful row has `smsAttemptStatus: "sent"` and an `outboundSmsSid` beginning with `dry-run-`.

When an owner notification number is configured, the same simulation also verifies a separate, idempotent owner missed-call alert. Successful bookings, failed bookings requiring follow-up, failed owner transfers, and the daily summary can likewise notify the owner according to the per-client controls in `/admin`.

For real messages, leave `TWILIO_SMS_DRY_RUN=false`, configure valid Twilio credentials, and point Twilio's status callback to:

```text
POST https://your-public-host/webhooks/twilio/voice-status
```

Two-way SMS booking is opt-in per client in `/admin`. Configure the Twilio number's **A message comes in** webhook as `POST https://your-public-host/webhooks/twilio/sms`. An answered call without a booking then sends one customer follow-up; replies are stored, deduplicated, checked against live availability, and delivered through the shared booking workflow. `STOP` opts the number out and `START` resumes it.

## Test the Vapi booking flow

After migrating and seeding the database, run:

```bash
npm run test:vapi-booking
```

The simulator sends Vapi-style `status-update`, `tool-calls`, and `end-of-call-report` messages to `/webhooks/vapi`. It verifies that the `create_booking` tool produced a successful `BookingAttempt` through the same booking service used by `POST /internal/bookings`, and that the final `CallLog` outcome is `booked`.

Configure Vapi's server URL as `https://your-public-host/webhooks/vapi` and enable `status-update`, `end-of-call-report`, and `tool-calls` server messages. For inbound dynamic assistant selection, configure the Vapi phone number without a fixed assistant so Vapi sends `assistant-request` to this server URL.

For production, create a Vapi custom Bearer credential using `VAPI_WEBHOOK_SECRET` and attach it to the server URL. The webhook also accepts Vapi's legacy `X-Vapi-Secret` header.

## Test the website chatbot

PostgreSQL stores chatbot sessions and messages so conversation state survives application restarts and works across multiple app instances without adding Redis infrastructure.

The marketing site loads the chatbot on every public page. Set `WEBSITE_CHATBOT_CLIENT_ID` to
the database client whose services, timezone, booking destination, and assistant context the site
should use. Local development falls back to the deterministic seeded client ID.

For a no-cost local tool-call test, set these values in `.env`:

```text
LLM_PROVIDER=mock
LLM_MODEL=mock
```

Then migrate, seed, and run the simulator:

```bash
npm run prisma:migrate
npm run prisma:seed
npm run test:chatbot
```

The output prints `fakeClientId`, the persisted conversation, the successful chatbot `BookingAttempt`, and a ready-to-paste widget script tag. On a fresh database, the seeded client ID is `00000000-0000-4000-8000-000000000001`.

To test the visual widget, start the server with `npm run dev`, create any local HTML page, and paste:

```html
<script
  src="http://localhost:3000/widget/chatbot-widget.js"
  data-api-base="http://localhost:3000"
  data-client-id="00000000-0000-4000-8000-000000000001"
></script>
```

Open the page, click the floating bubble, and send `/test-booking`. For a database that was seeded before the deterministic test ID was added, use the `fakeClientId` printed by `npm run test:chatbot` instead.

For a real LLM, use either:

```text
LLM_PROVIDER=openai
LLM_MODEL=gpt-5.4-nano
OPENAI_API_KEY=...
```

or:

```text
LLM_PROVIDER=anthropic
LLM_MODEL=claude-sonnet-4-5
ANTHROPIC_API_KEY=...
```

## Test booking destination routing

The routing simulator makes a local Zapier endpoint fail twice, then verifies that the booking is created through the safety-net GHL contact and appointment endpoints:

```bash
npm run test:booking-routing
```

Expected log message: `Booking primary and GHL safety-net simulations succeeded`. It verifies a first-attempt Zapier success, a booking where Zapier fails twice before GHL succeeds, and a complete failure that returns HTTP 502 and remains flagged for manual follow-up.

## Verify the health endpoint

With the development server running, use a second terminal:

```bash
curl --fail --silent --show-error http://localhost:3000/health
```

Expected response:

```json
{ "status": "ok" }
```

## Use the internal admin panel

Set private credentials in `.env` (the admin route fails closed when either value is missing):

```text
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-a-long-random-password
```

Start the server with `npm run dev`, then open `http://localhost:3000/admin`. Your browser will prompt for the Basic Auth credentials. From there you can create and edit clients and inspect their 25 most recent call logs and booking attempts.

After migrating and seeding the database, run the admin route smoke test with:

```bash
npm run test:admin
```

## Failure alerts and daily operations summary

Slack is used for operational alerting. A booking that fails both its primary destination and the GHL safety-net delivery immediately posts a lead-recovery alert. A protected scheduled endpoint posts a cross-client report for the preceding 24 hours with total calls, missed calls, successful bookings, and failed booking attempts.

1. In Slack, open **Tools & settings → Manage apps**, search for **Incoming WebHooks**, and add it to your workspace. Choose the private channel that should receive alerts, then copy the generated URL.
2. Add these values to `.env`:

   ```text
   SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
   CRON_SECRET=generate-a-long-random-secret
   ```

3. Restart the application. No Slack API token or SDK is required; the incoming webhook URL is the credential and must be kept private.
4. Configure an external scheduler (GitHub Actions, cron-job.org, Render Cron Jobs, or your host's scheduler) to make this request once per day:

   ```text
   POST https://your-public-host/internal/cron/daily-summary
   Authorization: Bearer your-CRON_SECRET-value
   ```

   `X-Cron-Secret: your-CRON_SECRET-value` is also accepted when a scheduler cannot set an Authorization header. Do not put the secret in the URL query string.

Test the summary integration locally after starting PostgreSQL and seeding the database:

```bash
npm run test:daily-summary
```

The test uses a local mock Slack receiver and does not send a real message. To manually send the real summary, run:

```bash
curl --fail --request POST \
  --header "Authorization: Bearer $CRON_SECRET" \
  http://localhost:3000/internal/cron/daily-summary
```

External request timeouts are currently 10 seconds for Twilio SMS, 20 seconds for OpenAI/Anthropic, and 5 seconds for Zapier, GHL, and Slack. Vapi is inbound-only in this application, so there is no Vapi API request to time out; protect its inbound webhook with `VAPI_WEBHOOK_SECRET` and use `POST https://your-public-host/webhooks/vapi`. Twilio voice status callbacks should target `POST https://your-public-host/webhooks/twilio/voice-status`.

## Quality checks

[Provider-independent communication](docs/COMMUNICATIONS.md) adds a canonical delivery ledger,
hard opt-out enforcement, encrypted organization accounts and a native Twilio SMS adapter.
Email interfaces are ready for a future provider; Recovery retains its approval/claim protocol.
COMMUNICATIONS_ENABLED and COMMUNICATION_DELIVERY_ENABLED default off. Existing legacy send
controls remain independent; review the rollout guide before enabling production traffic.

Organization-specific [Business Knowledge](docs/BUSINESS_KNOWLEDGE.md) adds reviewed facts,
FAQs, policies, source documents, immutable versions, cited retrieval and an admin portal.
It defaults off via BUSINESS_KNOWLEDGE_ENABLED; knowledge never grants agent permissions.
See its rollout guide before requiring existing recovery templates to bind approved versions.

Revenue Recovery is available as a default-off specialization of the generic Agent Runtime.
It includes a scoped dashboard, reviewed follow-ups, human handoffs, evidence-based attribution
and 37 no-send simulation scenarios. See [the recovery guide](docs/REVENUE_RECOVERY.md) and
[verification report](docs/REVENUE_RECOVERY_VERIFICATION.md). Live communication still requires
a certified delivery adapter and explicit deployment/organization enablement.

```bash
npm run typecheck
npm run lint
npm run format:check
npm run build
```

## Project structure

```text
prisma/          Prisma schema and future migrations
src/
  config/        Environment and application configuration
  db/            Database client and database helpers
  routes/        Express routers
  services/      External-service wrappers and domain services
  types/         Shared TypeScript types
  utils/         Shared utilities, including logging
```
