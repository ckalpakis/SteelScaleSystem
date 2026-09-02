# Steel Scale System

A lightweight, multi-tenant missed-call and booking automation service for home-service businesses. This repository currently contains application scaffolding only.

Start with the [complete setup and launch guide](./GETTING_STARTED.md). For deployment-only instructions, see the [Railway deployment guide](./DEPLOYMENT.md). For repeatable onboarding and delivery, use the [client fulfillment SOP](./CLIENT_FULFILLMENT.md).

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

For real messages, leave `TWILIO_SMS_DRY_RUN=false`, configure valid Twilio credentials, and point Twilio's status callback to:

```text
POST https://your-public-host/webhooks/twilio/voice-status
```

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
