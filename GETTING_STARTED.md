# Steel Scale System: Complete Setup and Launch Guide

This guide takes the system from a fresh checkout to a working production installation. Complete the sections in order. Do not connect real phone numbers or accept real leads until every smoke test passes.

## 1. What this system does

Steel Scale is a multi-tenant lead-response and appointment-booking backend for home-service businesses. It provides:

- Missed-call SMS follow-up through Twilio.
- Live AI phone handling through Vapi.
- An embeddable website chatbot using OpenAI or Anthropic.
- A shared booking endpoint used by voice and chat.
- Primary booking delivery to Zapier or GHL.
- A GHL safety-net calendar when primary delivery fails.
- Slack alerts for booking failures.
- A protected internal admin panel.
- A protected daily operations summary.

The application is an Express and TypeScript service backed by PostgreSQL through Prisma.

## 2. Accounts and access you need

Create or obtain access to the following before starting production setup:

- GitHub account and a private repository for this project.
- Railway account with billing enabled.
- Twilio account with a message-capable phone number.
- Vapi account and production assistant.
- OpenAI or Anthropic API account.
- GoHighLevel account, location, and safety-net calendar.
- Slack workspace where you can add an incoming webhook.
- Zapier account for each client who will use Zapier routing.

Keep production credentials in Railway. Never put them in source files, committed `.env` files, screenshots, tickets, or client-facing documents.

## 3. Local prerequisites

Install:

- Node.js 20 or newer.
- npm.
- PostgreSQL 16 or a compatible supported version.
- Git.

Confirm the tools:

```bash
node --version
npm --version
git --version
psql --version
```

## 4. Install the project locally

From the project directory:

```bash
npm install
cp .env.example .env
```

The committed `.env.example` contains placeholders only. `.env` is ignored by Git and is where local credentials belong.

## 5. Create the local PostgreSQL database

Create an empty PostgreSQL database named `steel_scale`, or use the existing local development database. Set its connection in `.env`:

```text
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/steel_scale?schema=public
```

Replace the username, password, host, port, and database name when your PostgreSQL installation differs.

Generate the Prisma client, apply migrations, and seed the fake client:

```bash
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed
```

The seed provides a non-production client for local testing. Never point the seeded Zapier or provider IDs at real services.

## 6. Configure local environment variables

Start with safe local settings:

```text
NODE_ENV=development
LOG_LEVEL=info
PORT=3000

DATABASE_URL=postgresql://postgres:postgres@localhost:5432/steel_scale?schema=public

TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_SMS_DRY_RUN=true

VAPI_WEBHOOK_SECRET=your_local_vapi_webhook_secret

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
CRON_SECRET=replace_with_a_long_random_cron_secret
```

Dry-run flags must remain `true` until you intentionally test real SMS and booking delivery.

## 7. Start and verify the local application

Start the development server:

```bash
npm run dev
```

In a second terminal:

```bash
curl --fail http://localhost:3000/health
```

Expected result:

```json
{ "status": "ok" }
```

Open `http://localhost:3000/admin` and enter `ADMIN_USERNAME` and `ADMIN_PASSWORD`. Confirm that the seeded client appears.

## 8. Run the complete local test suite

Run each workflow separately so a failure is easy to identify:

```bash
npm run test:missed-call
npm run test:vapi-booking
npm run test:chatbot
npm run test:booking-routing
npm run test:admin
npm run test:daily-summary
```

Then run project quality checks:

```bash
npm run format:check
npm run typecheck
npm run lint
npm run build
```

Do not proceed if any command fails.

## 9. Configure the chatbot provider

Choose one provider for production.

### OpenAI

```text
LLM_PROVIDER=openai
LLM_MODEL=gpt-5.4-nano
OPENAI_API_KEY=your_production_key
```

### Anthropic

```text
LLM_PROVIDER=anthropic
LLM_MODEL=your_supported_claude_model
ANTHROPIC_API_KEY=your_production_key
```

Remove unused provider keys from Railway. Do not use `LLM_PROVIDER=mock` in production.

## 10. Configure GHL as the safety net

In GoHighLevel:

1. Open the agency sub-account/location that will receive safety-net bookings.
2. Create a calendar dedicated to unplaced Steel Scale leads.
3. Copy its calendar ID.
4. Obtain an API credential with access to contacts and calendars for the location.
5. Copy the location ID.
6. Configure:

   ```text
   GHL_API_KEY=...
   GHL_LOCATION_ID=...
   GHL_FALLBACK_CALENDAR_ID=...
   GHL_API_BASE_URL=https://services.leadconnectorhq.com
   ```

Use a clearly named calendar such as `Steel Scale — Manual Follow-up`. Give an operator responsibility for monitoring it.

## 11. Configure Slack alerting

1. In Slack, open **Tools & settings → Manage apps**.
2. Find **Incoming WebHooks**.
3. Add a webhook to a private operations channel.
4. Store the generated URL as `SLACK_WEBHOOK_URL`.
5. Generate a strong random `CRON_SECRET`.

This channel receives:

- Immediate alerts when the primary destination and GHL safety net both fail.
- The daily 24-hour operations summary.

## 12. Prepare the GitHub repository

Before pushing, verify that `.env` is not tracked:

```bash
git status --short
git check-ignore .env
```

Commit and push the project to a private GitHub repository using your normal Git workflow. Do not commit production secrets.

## 13. Create the Railway production environment

The complete dashboard walkthrough is in [DEPLOYMENT.md](./DEPLOYMENT.md). The essential sequence is:

1. Railway → **New Project** → **Deploy from GitHub repo**.
2. Select the repository.
3. On the project canvas, choose **Create → Database → Add PostgreSQL**.
4. On the application service, add:

   ```text
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   ```

5. Add all production environment variables from the checklist below.
6. Configure:

   ```text
   Build command: npm run build
   Pre-deploy command: npm run prisma:deploy
   Start command: npm run start
   Healthcheck path: /health
   Healthcheck timeout: 120 seconds
   ```

7. Apply the staged changes.
8. Open **Settings → Networking → Generate Domain**.
9. Record the HTTPS origin as `APP_URL`.

Railway injects `PORT`. Do not manually set it in Railway.

## 14. Production environment checklist

Configure these on the Railway application service:

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
```

Use the Anthropic variables instead when applicable.

## 15. Verify the Railway release

Confirm:

1. The build completed.
2. The pre-deploy log reports that Prisma migrations were applied or that none were pending.
3. The application log reports that the HTTP server is listening.
4. `APP_URL/health` returns HTTP 200.
5. `APP_URL/admin` prompts for credentials.
6. The client list loads after authentication.

Commands:

```bash
curl --fail "$APP_URL/health"
curl --fail --user "$ADMIN_USERNAME:$ADMIN_PASSWORD" "$APP_URL/admin"
```

## 16. Connect the production Vapi assistant

1. Open Vapi → **Assistants**.
2. Select the production assistant.
3. Open **Advanced → Webhook Server**.
4. Enter:

   ```text
   APP_URL/webhooks/vapi
   ```

5. Use a request timeout of at least 30 seconds.
6. Enable `status-update`, `end-of-call-report`, and `tool-calls` server messages.
7. Create a custom Bearer credential whose token equals `VAPI_WEBHOOK_SECRET`.
8. Attach that credential to the webhook server.
9. Save and publish the assistant.
10. Assign the assistant to the intended Vapi phone number.
11. Copy the assistant ID and phone-number ID into the client's admin configuration.

Test a complete call. Confirm that it creates a `CallLog` and that a spoken booking produces a `BookingAttempt`.

## 17. Connect the production Twilio number

`/webhooks/twilio/voice-status` receives call status. It does not return TwiML and must not replace the handler under **A call comes in**.

1. Open Twilio → **Phone Numbers → Manage → Active numbers**.
2. Select the production number.
3. Keep incoming-call routing pointed at the system that answers or forwards the call.
4. Set the call flow's status callback to:

   ```text
   APP_URL/webhooks/twilio/voice-status
   ```

5. Use HTTP `POST`.
6. Ensure the callback is attached to the dialed leg that can return `busy`, `canceled`, `failed`, or `no-answer`.
7. Match the client's admin phone number exactly to the Twilio E.164 number.
8. Ensure `TWILIO_SMS_DRY_RUN=false` in Railway.

Place a controlled unanswered call. Confirm the caller receives the configured SMS and the admin panel records a sent SMS attempt.

## 18. Configure the daily summary

Use Railway cron, GitHub Actions, cron-job.org, or another scheduler to send one daily request:

```text
POST APP_URL/internal/cron/daily-summary
Authorization: Bearer <CRON_SECRET>
```

Manual check:

```bash
curl --fail --request POST \
  --header "Authorization: Bearer $CRON_SECRET" \
  "$APP_URL/internal/cron/daily-summary"
```

Confirm the Slack channel receives the report.

## 19. Add the website chatbot

After creating the real client in `/admin`, copy its UUID and add this to the client's website:

```html
<script
  src="APP_URL/widget/chatbot-widget.js"
  data-api-base="APP_URL"
  data-client-id="CLIENT_UUID"
></script>
```

Replace all three placeholders. Test on desktop and mobile and complete a real controlled booking before publishing the site change.

## 20. Production launch checklist

- [ ] Railway health check passes.
- [ ] PostgreSQL migrations completed.
- [ ] Admin credentials work.
- [ ] Dry-run flags are `false`.
- [ ] The production LLM provider is enabled.
- [ ] The GHL safety-net calendar is correct.
- [ ] Slack immediate alerts and daily summary work.
- [ ] Vapi webhook authentication works.
- [ ] A Vapi test call creates a call log.
- [ ] A voice booking reaches its destination.
- [ ] An unanswered call triggers exactly one SMS.
- [ ] A chatbot booking reaches the same booking endpoint.
- [ ] The client confirms calendar data is correct.
- [ ] Someone owns manual follow-up alerts.

## 21. Routine operations

Daily:

- Read the Slack summary.
- Resolve failed `BookingAttempt` alerts immediately.
- Check the safety-net GHL calendar.

Weekly:

- Review recent calls and bookings by client in `/admin`.
- Confirm provider balances and API quotas.
- Review Railway application errors and PostgreSQL health.

Before every release:

```bash
npm run format:check
npm run typecheck
npm run lint
npm run build
```

After every release, repeat the health, admin, Vapi, Twilio, chatbot, and Slack smoke tests appropriate to the changed code.

## 22. Troubleshooting order

When a workflow fails, check in this order:

1. Railway deployment and application logs.
2. `/health` and `/admin` availability.
3. Client configuration in `/admin`.
4. The relevant `CallLog` or `BookingAttempt` error.
5. Railway environment-variable spelling.
6. Provider delivery/request logs.
7. GHL safety-net calendar and Slack alerts.

Do not repeatedly submit a real lead while debugging. Use a controlled test phone number and clearly named test customer.
