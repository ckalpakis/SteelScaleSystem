# Railway deployment guide

Railway is the recommended host for this project. The application and PostgreSQL database can live in one project, `DATABASE_URL` can reference the database service directly, and Railway supports a migration command before each release.

No deployment is performed by this repository. Complete the following steps in your own accounts.

## 1. Before opening Railway

1. Commit this repository and push it to a GitHub repository.
2. Decide which chatbot provider to use: `openai`, `anthropic`, or `mock`. Never use `mock` for production leads.
3. Collect the production credentials listed in the environment variable table below.
4. Generate strong, unrelated values for `ADMIN_PASSWORD`, `CRON_SECRET`, and `VAPI_WEBHOOK_SECRET`.
5. Ensure `TWILIO_SMS_DRY_RUN=false` and `BOOKING_DELIVERY_DRY_RUN=false` for production.

## 2. Create the Railway project and PostgreSQL service

1. Sign in at Railway and click **New Project**.
2. Click **Deploy from GitHub repo**, authorize Railway if prompted, and select this repository.
3. If Railway stages an initial deployment before variables exist, let it fail; do not add placeholder secrets.
4. On the project canvas, click **Create** (or **+ New**) → **Database** → **Add PostgreSQL**.
5. Wait for the PostgreSQL service to show as deployed.
6. Open the Node application service → **Variables** → **New Variable**.
7. Set `DATABASE_URL` to the Railway reference variable `${{Postgres.DATABASE_URL}}`. If the database service has a different name, replace `Postgres` with its exact service name.

This is the production PostgreSQL connection. Do not copy the public database URL into the repository. The application service should use Railway's private reference variable.

## 3. Configure the application service

Open the application service and add the variables below in **Variables**. Use **Raw Editor** if you prefer to paste several at once. Do not include `PORT`; Railway injects it automatically.

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
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
CRON_SECRET=...
```

If using Anthropic, set `LLM_PROVIDER=anthropic`, set the desired `LLM_MODEL`, add `ANTHROPIC_API_KEY`, and omit `OPENAI_API_KEY`. `VAPI_API_KEY` is not currently consumed by the application because Vapi calls this application's inbound webhook; it does not need to be added to Railway.

Then open **Settings**:

1. Under **Build**, set the build command to `npm run build` if Railway has not already picked it up.
2. Under **Deploy**, set **Pre-deploy Command** to `npm run prisma:deploy`.
3. Set **Custom Start Command** to `npm run start`.
4. Set **Healthcheck Path** to `/health` and the timeout to `120` seconds.
5. Leave restart policy at **On Failure**.
6. Apply the staged changes and deploy.

The checked-in `railway.json` records the same settings for legacy Config-as-Code support. Railway is deprecating that file for new services, so the dashboard settings above are the authoritative setup for a new project.

## 4. Generate and verify the public URL

1. Open the application service → **Settings** → **Networking**.
2. Click **Generate Domain**.
3. Copy the resulting HTTPS origin, for example `https://steel-scale-production.up.railway.app`. This guide calls it `APP_URL`.
4. Visit `APP_URL/health`. It must return `{ "status": "ok" }`.
5. Open the latest deployment logs and confirm that `prisma migrate deploy` completed and the server is listening on Railway's assigned port.
6. Visit `APP_URL/admin` and sign in with the production admin credentials.

Do not configure Twilio or Vapi until the health check and admin login work over HTTPS.

## 5. Point Vapi at Railway

This project uses Vapi, not Retell.

1. In the Vapi dashboard, open **Assistants** and select the production assistant.
2. Open **Advanced** → **Webhook Server**.
3. Set **Server URL** to `APP_URL/webhooks/vapi`.
4. Set the request timeout high enough for booking delivery; use at least 30 seconds because a failed primary destination can make two five-second attempts before the GHL fallback.
5. Enable the server messages `status-update`, `end-of-call-report`, and `tool-calls`.
6. In Vapi credentials, create a custom Bearer credential whose token exactly matches `VAPI_WEBHOOK_SECRET`, and attach it to the server configuration. The application also accepts the legacy `X-Vapi-Secret` header.
7. Save and click **Publish** if Vapi shows unpublished changes.
8. Open **Phone Numbers**, select the production Vapi number, and confirm it uses this assistant. If using dynamic assistant selection, set the phone number's server URL to the same endpoint instead of assigning a fixed assistant.
9. Copy the Vapi assistant ID and phone-number ID into that client's `VoiceAgentConfig` through `APP_URL/admin`.

Make a test call and confirm that a `CallLog` appears in the client's admin detail page.

## 6. Point Twilio at Railway

The route `POST /webhooks/twilio/voice-status` is a call-status receiver; it is **not** an incoming-call TwiML route. Do not place it in **A call comes in**, because it returns no TwiML instructions.

1. In Twilio Console, open **Phone Numbers** → **Manage** → **Active numbers** and select the production number.
2. Open its voice configuration.
3. Keep **A call comes in** pointed at the system that actually answers or dials the call (for example Vapi, a TwiML Bin, Studio Flow, or your existing forwarding logic).
4. Configure that call flow's status callback to `APP_URL/webhooks/twilio/voice-status` using HTTP `POST`. If the Console exposes **Call status changes**, put the URL there. If your TwiML uses `<Dial>`, configure the callback on that dialed leg so `busy`, `failed`, `no-answer`, and answering-machine results reach this application.
5. Ensure the callback includes the final call status. The application treats `busy`, `canceled`, `failed`, `no-answer`, and machine/fax detection as missed calls.
6. In Railway, set `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` from the same Twilio project, and ensure `TWILIO_SMS_DRY_RUN=false`.
7. In `APP_URL/admin`, set the client's main phone number to the exact Twilio E.164 number, such as `+15551234567`.
8. Call the number, allow the configured call flow to produce a no-answer result, and verify the caller receives the text and the `CallLog` shows `smsAttemptStatus=sent`.

If the Vapi number was imported from Twilio, configure call ownership/routing in Vapi and avoid replacing Vapi's incoming voice URL in Twilio. Only attach the status callback in a way supported by that Vapi/Twilio call flow.

## 7. Configure the daily summary scheduler

Use an external scheduler to send this request once per day:

```text
POST APP_URL/internal/cron/daily-summary
Authorization: Bearer <CRON_SECRET>
```

The endpoint posts the report to `SLACK_WEBHOOK_URL`. A failed booking also posts an immediate alert through the same Slack webhook.

## Environment variables

| Variable                   | Required in production | Purpose                                                            |
| -------------------------- | ---------------------- | ------------------------------------------------------------------ |
| `DATABASE_URL`             | Yes                    | Railway PostgreSQL reference URL.                                  |
| `NODE_ENV`                 | Yes                    | Set to `production`.                                               |
| `LOG_LEVEL`                | No                     | Pino level; defaults to `info`.                                    |
| `PORT`                     | Injected by Railway    | HTTP listening port; do not set manually.                          |
| `TWILIO_ACCOUNT_SID`       | Yes for SMS            | Twilio project account SID.                                        |
| `TWILIO_AUTH_TOKEN`        | Yes for SMS            | Twilio project auth token.                                         |
| `TWILIO_SMS_DRY_RUN`       | Yes                    | Must be `false` to send real messages.                             |
| `VAPI_WEBHOOK_SECRET`      | Strongly recommended   | Authenticates inbound Vapi webhooks.                               |
| `VAPI_API_KEY`             | No                     | Reserved placeholder; no outbound Vapi API call currently uses it. |
| `LLM_PROVIDER`             | Yes                    | `openai` or `anthropic` in production.                             |
| `LLM_MODEL`                | No                     | Overrides the provider's default model.                            |
| `OPENAI_API_KEY`           | Conditional            | Required when `LLM_PROVIDER=openai`.                               |
| `ANTHROPIC_API_KEY`        | Conditional            | Required when `LLM_PROVIDER=anthropic`.                            |
| `GHL_API_KEY`              | Yes                    | GHL API credential for primary/fallback delivery.                  |
| `GHL_LOCATION_ID`          | Yes                    | GHL location used for contacts and appointments.                   |
| `GHL_FALLBACK_CALENDAR_ID` | Yes                    | Safety-net calendar used after primary failure.                    |
| `GHL_API_BASE_URL`         | No                     | Defaults to the official LeadConnector API URL.                    |
| `BOOKING_DELIVERY_DRY_RUN` | Yes                    | Must be `false` for real deliveries.                               |
| `ADMIN_USERNAME`           | Yes                    | Basic Auth username for `/admin`.                                  |
| `ADMIN_PASSWORD`           | Yes                    | Strong Basic Auth password for `/admin`.                           |
| `SLACK_WEBHOOK_URL`        | Strongly recommended   | Immediate alerts and daily reports.                                |
| `CRON_SECRET`              | Yes for summary route  | Protects the scheduled endpoint.                                   |

## Production smoke test

After configuring provider webhooks, verify:

```bash
curl --fail APP_URL/health
curl --fail --user "$ADMIN_USERNAME:$ADMIN_PASSWORD" APP_URL/admin
curl --fail --request POST \
  --header "Authorization: Bearer $CRON_SECRET" \
  APP_URL/internal/cron/daily-summary
```

Then place one Vapi test call, one intentionally unanswered Twilio test call, and one chatbot test booking. Check Railway logs, `/admin`, the destination calendar, and Slack.
