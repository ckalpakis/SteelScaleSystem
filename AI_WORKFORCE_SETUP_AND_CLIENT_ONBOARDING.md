# Steel Scale AI Workforce: Setup and Client Onboarding

Owner/operator runbook · checked against this repository on September 8, 2026.

Use this guide to deploy the AI workforce platform, configure its separate services,
and onboard each new service-business client. This is separate from the existing
voice-booking and availability Zaps. GoHighLevel is optional.

**Reading this guide does not deploy anything.** The local implementation and tests
are not evidence that your Railway account, production database, Zaps, model
credentials or messaging provider have been configured.

## Contents

- [Start here: what is ready and what still needs setup](#start-here-what-is-ready-and-what-still-needs-setup)
- [Part A: One-time platform setup](#part-a-one-time-platform-setup)
- [Part B: Onboard a new client](#part-b-onboard-a-new-client)
- [Part C: Live messaging and pilot approval](#part-c-live-messaging-and-pilot-approval)
- [Part D: Daily operations, changes and offboarding](#part-d-daily-operations-changes-and-offboarding)
- [Troubleshooting](#troubleshooting)
- [Copyable client launch checklist](#copyable-client-launch-checklist)
- [Technical references](#technical-references)

## Start here: what is ready and what still needs setup

| Capability                              | What you must do                                                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Organization workspace and built-in CRM | Deploy code/migrations, enable the feature flags, provision an organization.                                         |
| Business Knowledge                      | Create, review and approve the client's factual information and message templates.                                   |
| CRM imports through Zapier              | Create a connection and configure/test the client's actual Zap.                                                      |
| Outbound events to Zapier               | Configure a destination and receiving workflow, then enable webhook delivery deliberately.                           |
| Agent Builder                           | Configure an allowed model and AI credential for generation; manual drafts and tests are separate.                   |
| Revenue Recovery                        | Review program rules, approved knowledge, consent, assignment and simulations.                                       |
| Live Recovery customer messages         | **A trusted delivery adapter must be installed and certified. A connection or API key alone is insufficient.**       |
| Employee login/invitations              | Normal signup, invitations and browser sessions are not implemented. Member credentials remain the access mechanism. |

Every AI-proposed Recovery message currently requires exact-action human approval,
including in AUTOPILOT. An inbound customer reply pauses autonomous follow-up and
enters the human workflow. Do not sell or configure this release as unattended,
freeform customer messaging.

You can complete platform setup, import data, approve knowledge and run offline
simulations without enabling customer delivery. Keep agents disabled until their
pilot is reviewed. Global feature flags apply to the deployment, not just one client.

### Who does what

- **You, the platform owner:** control Railway, releases, backups, provider accounts,
  organization provisioning, incident response and pilot approval.
- **Client owner/admin:** approves business facts, consent evidence, agent rules,
  message drafts and financial attribution.
- **Client salesperson:** works assigned handoffs once individual access is provisioned.
- **Developer/deployment operator:** verifies migration safety, Redis persistence,
  effective worker configuration and the delivery adapter. Some steps below are
  explicitly technical; do not guess around a failed prerequisite.

### Placeholder rules

- `YOUR_APP_HOST`: your public HTTPS web hostname, without a trailing path.
- `YOUR_ADMIN_USERNAME`: the existing platform-operator username.
- `YOUR_TESTED_MODEL_ID`: a model accessible to your AI account and tested with this app.
- `CONTACT_UUID`, `OPPORTUNITY_UUID`, `PIPELINE_UUID`, `STAGE_UUID`: internal Steel Scale IDs.
- `CONNECTION_UUID`: the integration connection ID, not its credential ID.
- `KNOWLEDGE_VERSION_UUID`: an approved knowledge **version** ID, not an entry ID.

Replace placeholders before submitting forms or commands. Never copy real client
secrets into this file, Git, screenshots, support tickets or chat transcripts.

## Part A: One-time platform setup

Do this once per environment. Do **not** create a separate web/worker/database/Redis
stack for every client: organizations provide tenant isolation inside the shared
platform. Staging and production, however, need separate resources and credentials.

### Step 1: Inventory and protect the current production app

1. Open your existing Railway project and confirm you are viewing **production**.
2. Record the existing web service, database service, public domain, deployed commit,
   start/build commands, environment settings and any external cron schedules.
3. Record which legacy features are live: Twilio SMS, Vapi, chatbot, GHL booking,
   lead intelligence, daily reports and booking/availability Zaps.
4. Store configuration secrets in your secret manager, not this checklist.
5. Take a production database backup using your approved backup mechanism. Record
   its timestamp and location. Have the deployment operator restore it into an
   isolated database and verify representative records.
6. Keep the existing database and its volume. Do not point production at a new
   empty database just to make migrations pass.
7. Reserve a controlled deployment window. Pause automatic production deployment
   while preparing the initial release, including independent worker autodeploy.

**Done when:** you can identify the current release, recover its database, and
explain which existing workflows must remain operational.

### Step 2: Prepare the complete release in Git

1. Review `git status` and the changes with your developer. The platform increments
   include new files; untracked files do not reach Railway unless committed.
2. Include the reviewed application files, `prisma/schema.prisma`, all new migration
   directories, `package.json`, `package-lock.json`, and both Railway config files.
3. Never include `.env`, backup files, API keys or customer exports.
4. Run lint, typecheck and build locally. Run the regression suite only against a
   disposable local test database, as described in the verification docs.

   From the repository root, the non-database checks are:

   ```bash
   npm ci
   npm run lint
   npm run typecheck
   npm run build
   ```

   `npm ci` installs the locked dependencies and generates the Prisma client; it
   does not apply migrations. For database-backed tests, follow the guarded test
   setup in [deployment verification](docs/DEPLOYMENT_VERIFICATION.md) and
   [workspace verification](docs/PRODUCT_WORKSPACE_VERIFICATION.md). Do not reuse
   production credentials just to run `npm run test:regressions`.

5. Commit the complete reviewed release and deploy it to staging first. Do not
   blindly stage all unrelated working-tree changes.
6. Record the commit SHA. Both web and worker must use that same revision.

Do not upgrade the Node major version as an incidental part of this release.
Use the same supported Node version that you validate in staging. The package's
minimum engine declaration is not a production runtime certification.

### Step 3: Create a safe staging environment

1. In Railway's environment selector, choose **New Environment**, or open
   **Settings → Environments**.
2. Create `staging`. An empty environment is the clearest option for avoiding
   accidentally copied live provider credentials.
3. If you duplicate an environment instead, review every staged service and variable
   before deploying it. Duplication can copy configuration and secrets; it is not
   permission to contact production customers.
4. Create a separate staging PostgreSQL service and Redis service.
5. Add staging web and worker services from the release branch/commit.
6. Give staging web its own HTTPS hostname. Do not change production DNS.
7. Remove or replace live provider credentials, live destination URLs and external
   cron targets. In staging set legacy `TWILIO_SMS_DRY_RUN=true` and
   `BOOKING_DELIVERY_DRY_RUN=true`; leave paid demo features off.
8. Verify staging `DATABASE_URL` and `REDIS_URL` do not reference production.

Railway environments isolate service configuration, but you must verify any
references you supply. See [Railway environments](https://docs.railway.com/environments).

### Step 4: Configure PostgreSQL

For staging, add PostgreSQL through Railway's database/service creation flow.
For production, retain the existing PostgreSQL service.

1. Confirm the database service is running with persistent storage.
2. In the web service's Variables tab, add `DATABASE_URL` as a reference to the
   database service's private connection variable:

   ```dotenv
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   ```

3. Add the same reference to the worker. Replace `Postgres` with the actual
   service name, using Railway's reference-variable picker if convenient.
4. Verify the resolved host is the intended private database in the same environment.
5. Start with `DB_CONNECTION_LIMIT=5` on each app service and one replica each.
   Allow extra connections for overlapping deployments and migrations.
6. Keep automatic backups enabled according to your retention requirements and
   schedule restore drills. Do not add an untested connection pooler during cutover.

Railway references use `${{SERVICE_NAME.VARIABLE}}`; creating/editing variables
stages changes that must be deployed. See [Railway variables](https://docs.railway.com/variables).

**Done when:** web and worker reference the same intended database, staging does
not reference production, and backups have an owner.

### Step 5: Add and configure Redis

1. In the correct Railway environment, use **+ New → database → Redis**, or the
   Redis template. Name it clearly, for example `Redis`.
2. Keep it private. Do not add Public Access/a TCP proxy for application traffic.
3. Verify a persistent volume is attached and the Redis data directory is inside it.
4. Preserve the template's authentication and password configuration.
5. Have your deployment operator inspect the existing Redis startup command/config.
   At the `redis-server` level, retain its existing options and configure:

   ```text
   --appendonly yes
   --appendfsync everysec
   --maxmemory-policy noeviction
   ```

   These are Redis server options, **not application environment variables**. Do
   not replace the entire startup command and accidentally remove authentication
   or the persistent data directory. The exact command depends on the deployed
   Redis image/template; this repository does not manage it.

6. Deploy the Redis change. Through an authenticated private Redis session, inspect
   `CONFIG GET appendonly`, `CONFIG GET appendfsync`, `CONFIG GET maxmemory-policy`
   and `CONFIG GET dir`. Expected values are `yes`, `everysec`, `noeviction`, and
   the directory on the volume. Do not print the connection password in logs.
7. Add this reference to the worker:

   ```dotenv
   REDIS_URL=${{Redis.REDIS_URL}}
   ```

8. In staging, restart Redis and verify persistence/settings survive. Configure
   memory, disk and write-error alerts; `noeviction` does not mean unlimited capacity.

Redis service creation/private connection details are in
[Railway Redis](https://docs.railway.com/databases/redis). Persistence and no-eviction
are required operational choices for this queue deployment; see
[BullMQ production guidance](https://docs.bullmq.io/guide/going-to-production).

**Done when:** private authenticated Redis survives restart with its data/settings
and the worker has the correct connection reference.

### Step 6: Configure the Web/API service

Use the existing production web service; create its counterpart in staging.

1. Confirm the GitHub repository, release revision and repository root.
2. Use Railpack with dependencies installed from the committed lockfile. Do not
   omit build dependencies: Prisma CLI and TypeScript are needed during release.
3. Set/verify the effective settings below.

   | Setting                    | Web value                                  |
   | -------------------------- | ------------------------------------------ |
   | Build                      | `npm run build`                            |
   | Start                      | `npm start`                                |
   | Pre-deploy                 | `npm run prisma:deploy`                    |
   | Health check               | `/ready`                                   |
   | Health-check timeout       | 120 seconds                                |
   | Restart policy             | On failure; repository limit is 10 retries |
   | Intended repository config | `/railway.json`                            |

4. Keep the existing production HTTPS domain. For staging, use its separate hostname.
5. Set `APP_URL` to that environment's exact public HTTPS **web** origin, with no
   trailing route, for example `https://app.example.com`.
6. Let Railway supply `PORT`. Do not paste the worker's port into the web service.
7. Add the variables in Step 8 before deploying.

**Railway configuration warning, checked September 8, 2026:** the current official
reference marks legacy config-as-code deprecated and says existing legacy-service
files work until December 1, 2026. It also says code configuration overrides the
dashboard. Verify the configuration source in deployment details; do not assume a
dashboard edit wins. If your service requires Railway's newer IaC workflow, have
the deployment operator translate these exact settings through the supported path.
Do not delete the existing files or introduce an unreviewed infrastructure migration
just to dismiss a warning. This dated note supersedes conflicting deprecation
wording in older repository guides. See
[Railway configuration reference](https://docs.railway.com/config-as-code/reference).

### Step 7: Create the separate Worker service

1. Add a repository-backed service in the same environment and region as web/DB/Redis.
2. Select the same repository, root and commit as the web service.
3. Name it `steel-scale-worker` or similarly clearly.
4. Configure these **effective** settings:

   | Setting                    | Worker value                     |
   | -------------------------- | -------------------------------- |
   | Build                      | `npm run build`                  |
   | Start                      | `npm run start:workforce-worker` |
   | Pre-deploy                 | None                             |
   | Health check               | `/ready`                         |
   | Health-check timeout       | 120 seconds                      |
   | Public domain              | None                             |
   | Intended repository config | `/railway.workforce.json`        |

5. Where supported, select `/railway.workforce.json` as the service's Config File
   Path. Otherwise use the supported configuration workflow described in Step 6.
6. Inspect deployment details to confirm the worker did **not** inherit root
   `railway.json`'s web start command or migration command.
7. Keep it continuously running; do not configure it as a periodic Railway cron
   service or an HTTP-traffic-dependent sleeping service.
8. Add worker variables below. Let Railway supply its own `PORT`: the worker uses
   HTTP only for internal health/readiness, not customer requests.
9. Do not deploy it against an old schema. The web/migration owner goes first.

**Done when:** it is a genuinely separate background process, not a second web
server, and it has no public domain or migration pre-deploy command.

### Step 8: Set application variables

Add variables through each service's **Variables** tab/Raw Editor. Review before
deploying. The following is a safe initial configuration for the **new platform**;
it is not a replacement for your existing legacy production variables.

Shared on web and worker:

```dotenv
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
APP_URL=https://YOUR_APP_HOST
LOG_LEVEL=info
DB_CONNECTION_LIMIT=5
SHUTDOWN_TIMEOUT_MS=25000
RAILWAY_DEPLOYMENT_DRAINING_SECONDS=35

WORKFORCE_ENABLED=true
CRM_ENABLED=true
AGENT_RUNTIME_ENABLED=true
AGENT_BUILDER_ENABLED=true
REVENUE_RECOVERY_ENABLED=true
BUSINESS_KNOWLEDGE_ENABLED=true
COMMUNICATIONS_ENABLED=true

AGENT_MODEL_ENABLED=false
AGENT_BUILDER_AI_ENABLED=false
REVENUE_RECOVERY_DELIVERY_ENABLED=false
COMMUNICATION_DELIVERY_ENABLED=false
WEBHOOK_DELIVERY_ENABLED=false

DURABLE_BACKGROUND_ENABLED=false
```

Web-specific:

```dotenv
SERVICE_ROLE=web
WORKFORCE_WORKER_ENABLED=false
```

Worker-specific:

```dotenv
SERVICE_ROLE=worker
WORKFORCE_WORKER_ENABLED=true
REDIS_URL=${{Redis.REDIS_URL}}
QUEUE_PREFIX=steel-scale-production
WORKER_BATCH_SIZE=10
```

For staging use `QUEUE_PREFIX=steel-scale-staging`, a different `APP_URL`, and
staging-only database/Redis references. Flags are literal `true`/`false` strings.

Set these secret/configuration values separately; do not deploy the placeholders:

| Variable                           | Where                                     | Instructions                                                                                       |
| ---------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Web                                       | Preserve strong platform-operator credentials. Never distribute them to clients.                   |
| `INTEGRATION_ENCRYPTION_KEY`       | Both                                      | Same stable 64-character random hex key within an environment; separate across staging/production. |
| `AGENT_ALLOWED_MODELS`             | Both                                      | Comma-separated tested model IDs. Required before saving a Recovery configuration using one.       |
| `OPENAI_API_KEY`                   | Web for AI drafting; worker for execution | Server-side credential for the approved AI account/project; see Step 9.                            |
| `AGENT_BUILDER_MODEL`              | Web                                       | A tested ID also in `AGENT_ALLOWED_MODELS`; required for AI generation, not empty drafts.          |
| `CRON_SECRET`                      | Web                                       | Preserve if external authenticated cron routes are used.                                           |

If no encryption key exists, generate one locally and store it in your secret manager:

```bash
openssl rand -hex 32
```

Do not replace an existing key without a reviewed re-encryption migration. Losing
it makes stored encrypted destinations/credentials unreadable. Do not use the
encryption key as a client login password or an integration API key.

Retain working legacy credentials on web. Copy only those needed for delegated
work to the worker: for example Twilio credentials for legacy SMS, the configured
legacy AI provider key, Slack webhook for reports, or discovery-provider keys for
lead pipelines. GHL credentials remain required only for the existing flows that
actually use GHL. Variables on one service are not automatically inherited by another.

### Step 9: Set up AI access, without enabling execution yet

1. Open your OpenAI API dashboard using the account authorized for Steel Scale.
2. Create a dedicated application/project credential, ideally separating staging
   and production. Confirm API access/billing is operational for your account.
3. Save the key privately and configure `OPENAI_API_KEY` on the applicable service.
   Never put it in frontend code or give it to a client as their Steel Scale key.
4. With your developer, select an accessible model and test this application's
   Responses API strict-schema behavior in staging. Do not assume a model is
   compatible just because its ID was added to an allowlist.
5. Set `AGENT_ALLOWED_MODELS` on both services and `AGENT_BUILDER_MODEL` on web.
   The Recovery JSON uses its own `model` field, which must match the allowlist.
6. Keep `AGENT_MODEL_ENABLED=false` and `AGENT_BUILDER_AI_ENABLED=false` initially.
7. Agree a pilot spending limit and usage-review owner. A usage alert is not proof
   of a hard spending cap; verify your provider account controls.

Official OpenAI documentation describes API-key creation and environment-variable
setup in the [developer quickstart](https://developers.openai.com/api/docs/quickstart).
This guide does not prescribe a model name or claim account-specific access/pricing.

### Step 10: Apply migrations and deploy staging

1. Reconfirm staging references, paused sends and sanitized provider settings.
2. Deploy web first. Its pre-deploy runs `npm run prisma:deploy`.
3. Check the logs for successful application of all pending migrations. There are
   30 migration directories in this checked repository; production may already have
   some of them. Do not assume only the most recent migration is needed.
4. If migration fails, stop. Inspect schema state and the migration record with
   your developer. Do not mark it applied merely to get a green deployment.
5. After web starts, check:

   ```bash
   curl --fail-with-body https://YOUR_APP_HOST/health
   curl --fail-with-body https://YOUR_APP_HOST/ready
   ```

6. Deploy worker at the same commit and confirm its readiness check passes.
7. From a private shell **inside the running worker**, you can check readiness
   without adding a public domain:

   ```bash
   node -e 'fetch("http://127.0.0.1:" + process.env.PORT + "/ready").then(async r => { console.log(r.status, await r.text()); if (!r.ok) process.exitCode = 1; }).catch(() => { console.error("Readiness request failed"); process.exitCode = 1; })'
   ```

8. Open `/admin/operations` with platform credentials and inspect queue state.
   `npm run ops:queues` from the private worker shell inspects Redis wake-up queues.
9. Create a staging test organization using Part B. Verify record creation,
   duplicate webhook intake, knowledge review, simulations and tenant isolation.
10. Test worker restart with deliberately scheduled test work. Do not use actual
    customers or live-provider messages to prove restart behavior.

Railway pre-deploy commands run before the application and stop the deployment
when they fail. See [pre-deploy commands](https://docs.railway.com/deployments/pre-deploy-command).

Never run `migrate dev`, `db push`, `migrate reset`, seeds or test suites against
production. Automated regression scripts intentionally require a disposable
**loopback** database; they should not be pointed at Railway production or an
ordinary Railway staging URL to bypass their guard.

### Step 11: Cut over production background work

Only proceed after staging, backup/restore rehearsal and your maintenance approval.

1. Keep new agents disabled and new customer-delivery flags off.
2. Deploy production web/migrations with `DURABLE_BACKGROUND_ENABLED=false`.
3. Wait for migration success and web readiness.
4. Deploy the same-commit worker and confirm DB/Redis/readiness.
5. Pause relevant external cron triggers and coordinate incoming legacy work for
   a maintenance window. Drain existing long-running legacy executions; reconcile
   interrupted/running PipelineRuns and uncertain SMS/report operations.
6. Set `DURABLE_BACKGROUND_ENABLED=true` on worker and web, then deploy both in the
   controlled window. Ensure old web instances have drained before resuming traffic.
7. Resume approved external cron triggers. They now receive durable `202` job
   acknowledgments for delegated routes, not synchronous completion.
8. Smoke-test existing booking, availability, inbound SMS/STOP and relevant admin flows.
9. Recheck queue progress and error visibility.

Do not flip durable mode back to false with pending delegated work or old instances
still running it. The flag changes execution ownership, not just UI visibility.
Recovery schedules are handled by the worker; do not add per-client Railway cron
services or browser timers. Existing external daily-report scheduling remains separate.

### Step 12: Establish monitoring before selling a live pilot

1. Add continuous monitoring for public web `/ready`, not just Railway deploy checks.
2. Use a private monitor or infrastructure alert for worker readiness and restarts.
3. Alert on DB availability/storage, Redis memory/write failures, overdue queue age,
   dead jobs, unknown delivery and repeated failures.
4. Assign an operator to `/admin/operations`, private `ops:queues`, and structured logs.
5. Agree backup retention, restore-test frequency, incident contact and log access.
6. Record where encryption/provider keys are backed up and who may rotate them.
7. Establish reminders well before 90-day member/integration credential expiry.

`/ready` validates application dependencies, not your provider's credentials,
customer consent, legal compliance or successful message delivery. The workspace
shows web-service settings, not a live worker/provider certification.

## Part B: Onboard a new client

Repeat this part for each business after the shared platform is verified.
For a first pilot, use one business, one currency and a narrowly selected pipeline/stage.

### Step 13: Collect the client's setup information

Make a private onboarding record with these fields, excluding actual passwords:

| Information    | What to record                                                               |
| -------------- | ---------------------------------------------------------------------------- |
| Business       | Legal/display name, services, service areas, timezone and currency.          |
| Owner          | Verified owner/admin contact and secure access-delivery method.              |
| CRM choice     | Steel Scale CRM or existing CRM; source account and integration owner.       |
| Sales process  | Pipelines, stage meanings, win/loss/decline rules and source of truth.       |
| Opportunities  | Sample records, values, original activity dates, contact links.              |
| Communication  | SMS/email choice, authorized sender/account, inbound-reply route.            |
| Consent        | Actual evidence/source/scope for each channel and existing opt-outs.         |
| Recovery rules | Minimum value, first delay, cadence, attempts and hours.                     |
| Human workflow | Assigned salesperson, fallback admin, approval reviewer and coverage.        |
| Knowledge      | Approved facts, exact initial/follow-up messages, prohibited promises.       |
| Results        | Baseline pipeline, outcome/payment evidence owner and reporting currency.    |
| Pilot          | Limited audience/stage, acceptance criteria, start date and stop conditions. |

Confirm which system owns stage/value/assignment updates. Bidirectional sync is not
a license for both systems to overwrite each other. Do not import a full client
database until sample mappings and identity behavior have been approved.

### Step 14: Provision exactly one organization

Use platform-operator credentials from a trusted terminal/API client, not from
browser JavaScript. The JSON machine API rejects browser Origin requests.

For a new standalone business:

```bash
curl --fail-with-body \
  --user "YOUR_ADMIN_USERNAME" \
  --request POST \
  "https://YOUR_APP_HOST/api/workforce/organizations" \
  --header "Content-Type: application/json" \
  --data '{
    "name": "Northline Service Group",
    "ownerSubject": "operator-provisioned:northline-owner"
  }'
```

1. Replace the host, username, business name and stable owner identity label.
2. Curl prompts for your platform-admin password; do not put it in the command.
3. Save the returned `organization.id`, `token`, `credentialId` and `expiresAt`
   directly in the correct private client record/secret manager.
4. The token is returned at issuance and expires after 90 days. Never paste the
   response into a public ticket or repository file.
5. If the request's outcome is uncertain, inspect the operator organization's list
   before retrying. This provisioning endpoint is not an idempotent create-by-name
   operation; blind retries can create duplicate businesses.
6. If linking an existing legacy `Client`, have the operator verify its exact UUID
   and supply optional `legacyClientId`. Omit it for standalone clients. Do not infer
   this link from name, email or GHL account, and do not copy legacy records blindly.

An ownerSubject label is not an identity-provider login; the operator must verify
the real person before handing over the resulting authority.

### Step 15: Give the owner access and establish team assignments

1. Send the owner this URL separately from the secret:

   ```text
   https://YOUR_APP_HOST/workspace
   ```

2. Deliver the member token through your approved secure channel.
3. At the browser Basic-auth prompt, use username `organization` and the member
   token as password. Feature modules may prompt again because their realms differ.
4. Confirm the displayed organization is the client's business and the CRM shows
   only its records. Integration keys must not open member pages.
5. Explain that there is no normal invitation/password-reset/logout flow yet.
   Use a dedicated browser profile/private session and close it when finished;
   browser credential clearing behavior varies. Do not use shared public computers.
6. Never share `ADMIN_PASSWORD`, the platform encryption key or provider credentials.

For salesperson assignment records, an owner/admin can use the authenticated CRM API:

```http
POST /api/workforce/crm/members
Authorization: Bearer OWNER_MEMBER_TOKEN
Content-Type: application/json
```

```json
{ "name": "Sam Bennett", "email": "sam@example.test", "role": "member" }
```

Use a trusted API client with secrets stored locally, not synced into a public
collection. Replace the fictional email with the verified employee's address.
The API supports `member` or `viewer` at creation; employee records appear in CRM
assignment selectors. `GET /api/workforce/crm/members` returns their IDs.

**Important:** creating an employee assignment record does not issue a login token
or send an invitation. Individual employee credential provisioning still needs an
audited operator/developer workflow. Do not manufacture hashes in SQL or share the
owner token with every salesperson. Until individual access is provided, the
verified owner/admin handles the pilot handoffs.

### Step 16: Load business records using one of two paths

#### Path A: The client uses Steel Scale CRM

1. Open `/workspace/crm/contacts` and add a contact with a real name and intended
   destination. Enter phone numbers in international format.
2. Open **Pipeline settings** and create the business's pipeline.
3. Open the pipeline and add stages in the desired order. For example:
   New lead → Qualified → Appointment set → Proposal sent → Won → Lost.
   These names are examples, not mandatory industry stages.
4. Set appropriate stage outcomes: normal stages `open`, closing stages `won` or `lost`.
5. Open **Opportunities**, add one, link the contact and choose its pipeline/stage.
6. Enter explicit currency and value. The current CRM form uses minor units:
   USD `250000` = $2,500; JPY uses no fractional minor-unit conversion.
7. Assign the responsible employee, save a note and confirm the activity timeline.
8. Verify movement through the pipeline and closure behavior on a fictional record.
9. If custom fields are needed, an owner/admin can configure them via
   `/api/workforce/crm/custom-fields`; see [CRM API](docs/CRM_API.md). There is no
   general CSV upload wizard to assume exists.

Keep the internal UUIDs visible in record URLs/API responses for configuration.
Do not paste an external CRM record ID into a Steel Scale UUID field.

#### Path B: The client keeps its existing CRM and uses Zapier

1. Open `/integrations` with that client's owner/admin token.
2. Under **Connect your CRM**, create one connection for that source CRM account.
   Use a descriptive name and provider `zapier` or `generic_webhook`.
3. Prefer the canonical payload first. If the CRM sends different field names,
   configure field-path mapping when creating the connection. Mapping is not an
   arbitrary script and changing established mappings needs a deliberate plan.
4. Copy the generated connection API key immediately into your secret manager and
   Zapier's authorized configuration. Save the connection ID and expiry separately.
5. Copy the displayed URL, shaped like:

   ```text
   https://YOUR_APP_HOST/api/integrations/webhooks/CONNECTION_UUID/events
   ```

6. In the client's Zapier account, create a Zap using the CRM's estimate/opportunity
   trigger. Add **Webhooks by Zapier → POST/Custom Request** and send JSON.
7. Configure headers:

   ```text
   Content-Type: application/json
   Authorization: Bearer CONNECTION_API_KEY
   ```

8. Map a first fictional notification using this complete example. Replace the
   timestamp with the source's actual observation time and the record IDs with
   stable IDs from that CRM. Do not set the timestamp to now on each retry.

   ```json
   {
     "version": 1,
     "event": "estimate.sent",
     "external_id": "source-notification-1001",
     "occurred_at": "2026-09-08T12:00:00Z",
     "contact": {
       "external_id": "customer-101",
       "name": "Alex Example",
       "email": "alex@example.test"
     },
     "pipeline": { "external_id": "pipeline-1", "name": "Service proposals" },
     "stage": { "external_id": "stage-4", "name": "Proposal sent", "outcome": "open" },
     "opportunity": {
       "external_id": "opportunity-201",
       "title": "Annual maintenance agreement",
       "amount_minor": 480000,
       "currency": "USD"
     },
     "estimate": {
       "external_id": "estimate-301",
       "number": "EST-301",
       "title": "Annual maintenance agreement",
       "amount_minor": 480000,
       "currency": "USD"
     }
   }
   ```

9. Confirm HTTP `202`, review **Recent inbound activity**, and inspect the created
   contact/opportunity in CRM. Save returned `records` UUIDs if needed.
10. Replay the exact same notification: expect duplicate handling (`200`), not
    another record. A new business update needs a new notification ID and its
    real timestamp, while nested customer/opportunity IDs stay stable.
11. Add source triggers for the lifecycle facts Recovery must see: updates,
    won/lost, estimate acceptance/decline, appointments, inbound messages and
    opt-outs. Test both positive and negative changes before enabling the Zap.
12. Import a small reviewed batch, then expand only after counts, values, contacts
    and stages match. Preserve original last-activity dates during historical imports.

The top-level `external_id` identifies the notification; nested external IDs
identify records. The key/connection establishes organization scope. Do not send
an organization ID to choose another tenant. A `202` confirms durable intake, not
that the agent ran or a message was delivered.

Do not simultaneously feed the same source through old `/api/workforce` intake
and this new endpoint. Different integrations are not automatically merged by
email/phone. Existing booking/availability Zaps are a separate workflow.
For exact field mappings and request formats use
[universal Zapier integration](docs/ZAPIER_INTEGRATION.md).

### Step 17: Wire inbound customer replies and opt-outs

Recovery cannot safely work a conversation whose replies it never receives.

1. Identify which system actually receives customer replies and STOP requests.
2. Configure its authenticated path into canonical Steel Scale inbound messages.
3. For a generic CRM/Zapier bridge, after the contact is mapped, use this shape:

   ```json
   {
     "version": 1,
     "event": "customer.message_received",
     "external_id": "source-delivery-2001",
     "occurred_at": "2026-09-08T13:00:00Z",
     "contact": { "external_id": "customer-101" },
     "conversation": {
       "external_id": "conversation-401",
       "subject": "Service proposal",
       "channel": "sms"
     },
     "message": { "external_id": "message-501", "body": "Please call me tomorrow." }
   }
   ```

4. Preserve the external message ID on retry even if the source changes its
   notification/delivery ID. Do not create a new conversation ID for every reply.
5. Test a normal reply, STOP, wrong person and a repeated message on fictional
   contacts. Confirm the case pauses and suppression/handoff state is correct.
6. Verify the provider also applies its own opt-out controls. CRM record existence
   or a populated phone number is not consent.

Existing native/legacy communication bridges depend on explicit account/client
configuration; do not infer they are attached to a newly provisioned organization.
See [communications](docs/COMMUNICATIONS.md).

### Step 18: Optionally configure Steel Scale → Zapier → CRM

Skip this if the client has no need to sync changes back yet.

1. Create a separate Zap with **Webhooks by Zapier → Catch Hook**; use Catch Raw
   Hook when the receiver needs the original body/headers for signature validation.
2. Copy its HTTPS receiving URL. Treat the URL itself as a secret.
3. In Steel Scale `/integrations`, configure **Send updates to Zapier** with that URL.
4. Subscribe only to required events, such as `agent.handoff_created`,
   `contact.updated`, `opportunity.updated`, or recovery outcomes you have verified.
5. Leave **Include imported events** off to avoid immediate CRM feedback loops.
   Leave contact details off unless the destination actually needs them.
6. Save the one-time signing secret securely. Configure the receiver to verify
   Steel Scale signatures over the original body according to the integration
   specification; if your Zap cannot do that reliably, use a trusted verification
   step/receiver and have your implementer validate it. Do not describe an
   unverified Catch Hook as authenticated merely because a signature is sent.
7. Keep downstream customer-message/CRM mutations disabled while testing.
8. Review pending outbound deliveries across **all tenants** before changing the
   global `WEBHOOK_DELIVERY_ENABLED=true` worker flag. That switch can release
   previously queued work; it is not per-client.
9. Deploy the approved flag change, use **Send test event**, and verify it reaches
   Zapier and is recorded successful. Filter out `integration.test` before live actions.
10. Add the intended CRM action and durably deduplicate event/delivery IDs. Use the
    correct `external_records` mapping to update an existing CRM record.

HTTP acceptance by Zapier is not proof that the destination CRM action or a
customer message completed. Never wire both an outbound-event subscriber and the
Recovery delivery adapter to independently send the same message.

### Step 19: Add and approve Business Knowledge

1. Open `/business-knowledge` as the client's owner/admin.
2. Add a source, such as **Client-approved company handbook**.
3. Add company, service, service-area and FAQ entries. FAQ entries require a question.
4. Add financing, warranty, pricing, scheduling and policy references only when
   supplied and verified by the client. Approval of a fact does not authorize a
   discount, guaranteed outcome or customer-specific financial/legal promise.
5. Select **Approved for customer reference** only for information that may be
   disclosed. Internal is the default audience.
6. Save each draft, open its detail, review the exact latest content/audience, and
   choose **Approve and activate version**.
7. Add two general-risk `communication_template` entries for Recovery: initial and
   follow-up. Use exact client-approved wording, within Recovery's 1,000-character
   limit. Example wording for review, not automatic business/compliance approval:

   ```text
   Initial: Would you like to discuss your proposal with our team? Reply STOP to opt out.
   Follow-up: Checking whether you would still like to discuss your proposal. Reply STOP to opt out.
   ```

8. Approve those templates and copy their **Version IDs** from the detail pages.
9. Test a supported FAQ and a question the library cannot answer. Unsupported
   questions must not produce invented business facts.
10. If uploading references, use `.txt` or `.md` up to 40 KB. Documents alone are
    not agent knowledge: create and approve exact excerpt entries. PDF/OCR,
    website crawling and automatic full-document approval are not implemented.

Editing an entry withdraws approval until the new version is reviewed. Update
Recovery's pinned version/text together; old references must not be silently reused.
Restricted facts can remain reference-only even after approval. See
[Business Knowledge](docs/BUSINESS_KNOWLEDGE.md).

### Step 20: Configure the client's Revenue Recovery program

1. Open `/revenue-recovery` and expand **Recovery configuration and consent**.
2. Confirm the client has approved value thresholds, target stages, hours, timezone,
   cadence, maximum attempts, restricted topics and human responsibility.
3. Use **COPILOT** for the reviewed pilot. One specialization program is configured
   per organization in this release; do not create duplicate programs through
   the older foundation agent API or assume Agent Builder replaces this setup.
4. In **Structured recovery rules**, use the following shape, replacing every
   model/UUID placeholder and confirming the example business choices.

   ```json
   {
     "version": 1,
     "name": "Unsold proposal recovery",
     "model": "YOUR_TESTED_MODEL_ID",
     "mode": "COPILOT",
     "minimumValueMinor": 250000,
     "currency": "USD",
     "pipelineIds": ["PIPELINE_UUID"],
     "stageIds": ["STAGE_UUID"],
     "delayMinutes": 2880,
     "cadenceMinutes": [2880, 4320],
     "maximumAttempts": 3,
     "channels": ["sms"],
     "workingHours": {
       "timezone": "America/New_York",
       "days": [1, 2, 3, 4, 5],
       "startHour": 9,
       "endHour": 17
     },
     "employeeQuietMinutes": 1440,
     "attributionDays": 30,
     "allowedObjections": ["timing", "information_request"],
     "restrictedTopics": ["financing_question", "legal_or_compliance"],
     "handoffConditions": [
       "pricing_negotiation",
       "angry_customer",
       "legal_or_compliance",
       "wrong_person",
       "unknown"
     ],
     "knowledge": [
       {
         "key": "initial",
         "topic": "initial",
         "text": "Would you like to discuss your proposal with our team? Reply STOP to opt out.",
         "approved": true,
         "versionId": "INITIAL_KNOWLEDGE_VERSION_UUID"
       },
       {
         "key": "followup",
         "topic": "followup",
         "text": "Checking whether you would still like to discuss your proposal. Reply STOP to opt out.",
         "approved": true,
         "versionId": "FOLLOWUP_KNOWLEDGE_VERSION_UUID"
       }
     ]
   }
   ```

5. Use internal pipeline/stage UUIDs from CRM URLs/API responses. Selected stages
   must be open and belong to the permitted pipeline. Empty arrays mean **any**
   otherwise eligible pipeline/stage, not none. Keep the pilot narrowly scoped.
6. Confirm that the amount example means **at least** $2,500 USD. The specialized
   program's minimum is inclusive, not a strict greater-than comparison.
7. The delay is minutes from relevant opportunity activity/event time. `2880` is
   two days; `4320` is three days. Cadence intervals begin from confirmed delivery,
   not from when a draft was generated. The cadence array must have attempts minus
   one entries. Days use Sunday `0` through Saturday `6`.
8. The first enabled channel is the automatic follow-up channel; there is no
   automatic fallback between SMS/email. Choose hours/timezone deliberately;
   recipient-timezone inference, holiday calendars and overnight windows are absent.
9. Leave **Optional delivery connection ID** blank while the adapter is not ready.
   When certified, use its dedicated connection UUID, not the inbound CRM key.
10. Check the review acknowledgment and save. **Saving disables the agent** and
    creates a new configuration version. Existing work may pause for human review.
11. Leave the agent disabled until simulations and pilot approval are complete.

For API setup, the route is `PUT /api/recovery/program`, with an envelope containing
`config`, `reviewed: true`, `expectedVersion: 0` for first setup, and
`connectionId: null` or the certified connection UUID. The UI's rules textarea
expects only the inner configuration shown above. See [Recovery](docs/REVENUE_RECOVERY.md).

### Step 21: Record consent and run offline simulations

1. In Recovery's consent form, enter the **Steel Scale contact UUID**, channel,
   and actual consent evidence (source, scope and relevant timing).
2. Choose **Record permission** only when that permission genuinely exists.
   Recording permission does not clear DND or address suppression.
3. Do not use consent actions as a workaround for tests. Use fictional records
   with documented test authorization and never real uninvolved recipients.
4. In **Simulation lab**, run seeded cases including interested, declined, pricing
   negotiation, angry customer, wrong person, opt-out, unknown and scheduling.
5. Test safety-state scenarios for outside hours, already closed opportunities,
   recent employee action, duplicates and exhausted attempts.
6. Review the structured intent, handoff/stop action, blocking reasons and any
   approved-text recommendation. These offline tests send nothing and create no
   real agent run. They do not certify live model quality or provider delivery.
7. Open `/workspace` and check the launch checklist. Simulation credit requires
   the exact saved configuration and a test after that version was created.
8. After changing configuration or knowledge, review and test again.

The checklist is advisory. A green connection item means a connection is stored,
not that a provider/worker is healthy or that every customer is eligible.

### Step 22: Optional natural-language Agent Builder

This is optional for the first specialized Recovery pilot.

1. Open `/agent-builder`. With drafting disabled, **Start empty draft** still works.
2. To generate from text, configure `OPENAI_API_KEY`, an allowed
   `AGENT_BUILDER_MODEL`, and deliberately enable `AGENT_BUILDER_AI_ENABLED=true`
   on web after an approved staging model test.
3. Describe the process and boundaries. Review the generated blueprint; generation
   is a proposal, not execution or permission.
4. Resolve missing currency, channels, hours, knowledge and unsupported actions.
5. Use **Save Draft**, then **Test Agent** on fictional data.
6. Activate only a reviewed saved version and only when its permitted tools are
   actually implemented/certified. Saving a new draft does not update an existing
   active agent by itself.

Do not create a second general agent to duplicate the specialized Recovery
program's follow-ups. Not every requested natural-language workflow is supported;
unsupported behavior must remain blocked. See [Agent Builder](docs/AGENT_BUILDER.md).

## Part C: Live messaging and pilot approval

### Step 23: Install and certify the delivery adapter

**Stop here if no adapter has been installed. This is a developer/integration task,
not a switch you can turn on to finish messaging.**

The generic communication layer and existing Twilio/legacy sends do not automatically
connect new Recovery dispatches to a provider. A CRM Catch Hook alone also does not.

1. Choose the actual provider/account and authorized sender with the client.
   Complete the provider's required sender/domain verification and applicable
   messaging approvals with its official process. Do not guess these requirements.
2. Create a dedicated organization connection and integration credential for the
   trusted Recovery delivery implementation; keep it separate from inbound CRM sync.
3. Give the developer the exact [Recovery delivery protocol](docs/REVENUE_RECOVERY.md#delivery-adapter-protocol-v1).
4. The implementation must durably poll/list, claim, deduplicate, send and report
   receipts using these endpoints:

   ```text
   GET  /api/recovery/delivery
   POST /api/recovery/delivery/DISPATCH_UUID/claim
   POST /api/recovery/delivery/DISPATCH_UUID/receipt
   ```

5. A successful claim includes sensitive destination/message content and a one-time
   token with a 30-second lease. The adapter must not send an expired/blocked claim
   or leak its body/token into workflow logs. Delayed Zaps may not meet this contract.
6. Deduplicate durably on the supplied idempotency key. Losing an HTTP response is
   not permission to send again.
7. Report `delivered` only from provider-confirmed delivery, with its message ID;
   a successful HTTP send/acceptance response alone is insufficient. Retain the
   claim token securely for later receipts/reconciliation, including asynchronous
   provider delivery callbacks. Report definitive `not_sent` or `unknown` honestly.
8. Verify unknown outcomes freeze for review, inbound replies/STOP arrive, human
   takeover cancels unclaimed work, and tenant credentials cannot claim foreign work.
9. If deployed as a separate adapter service, its own start command, persistence,
   credentials, health checks and receipt callbacks must be documented by its
   implementer. **There is no adapter executable/start command supplied here to
   invent.** A compliant trusted external workflow is another possible host.
10. In staging, certify the complete path with authorized test recipients, including
    actual provider receipts. Then set the program's delivery connection ID,
    review/save the new version and rerun simulations.

Already-claimed messages may be in flight when opt-out/takeover arrives. Test and
document that boundary; do not promise cancellation of provider-accepted messages.

### Step 24: Approve and activate a limited live pilot

1. Get client approval of recipients, consent, business facts, exact messages,
   operating hours, eligible stages, human coverage and stop criteria.
2. Record baseline opportunity counts/value and the payment-evidence reviewer.
3. Verify the same tested code/model/configuration is deployed to web and worker.
4. Audit enabled agents and pending approvals/dispatches across tenants before
   changing any global model/delivery switch. Do not release unrelated queued work.
5. Enable `AGENT_MODEL_ENABLED=true` on the services that execute the reviewed
   model path. Confirm the allowed model/key are present; this permits paid calls.
6. With the adapter certified, enable `REVENUE_RECOVERY_DELIVERY_ENABLED=true` on
   the relevant web/worker configuration. The claim API runs on web, so setting
   this only on the worker is not enough.
7. Leave `COMMUNICATION_DELIVERY_ENABLED` off unless separately certified native
   communication sends are intended. It is not the Recovery adapter switch.
8. Enable `WEBHOOK_DELIVERY_ENABLED` only for reviewed outbound integration traffic.
   Keep ingestion/ledger feature gates on when pausing delivery.
9. In the client's Recovery screen, explicitly choose **Enable recovery**.
10. Remember the scanner can now enroll every eligible opportunity in the configured
    scope. It is not limited to records you manually enroll. Ensure that scope is
    restricted before enabling. Never reuse a real contact as a fake test recipient.
11. If appropriate, manually monitor one eligible opportunity using its UUID.
    Record consent first. Actual evaluation still respects delay and operating hours.
12. Review the exact pending draft before approval. Follow it through dispatch,
    provider receipt, inbound response and human handoff.
13. Repeat with the acceptance checks below before increasing the pilot's scope.

### Step 25: Verify pilot acceptance and train the client

Run these with controlled test records/recipients, not an uncontrolled bulk send:

| Check                    | Expected evidence                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------ |
| Duplicate webhook        | One set of canonical records/effects; original receipt reused.                       |
| Duplicate send attempt   | No second provider message for the same idempotency key.                             |
| Opt-out before execution | No new allowed send; suppression and paused/stopped state visible.                   |
| Opportunity won/lost     | Further follow-up becomes ineligible.                                                |
| Outside working hours    | Message remains blocked/deferred, not sent early.                                    |
| Human takeover           | AI pauses; unclaimed pending work is cancelled/reviewed.                             |
| Worker restart           | Due work persists and resumes without duplicate effects.                             |
| Unknown provider outcome | Visible exception; no blind automatic resend.                                        |
| Foreign organization/key | Access fails; no cross-client records or delivery claim.                             |
| Revenue attribution      | Evidence review required; monitoring or a won event alone earns no recovered credit. |

Train the owner/salesperson to:

1. Open `/workspace` daily and check unknown delivery, approval backlog and handoffs.
2. Use **Assigned to me**, **Unassigned**, or all open handoffs. Aging reflects the
   last handoff update, not an automatically enforced service-level agreement.
3. Open a case, read the conversation and choose **Take Over** before responding.
4. **Respond** queues an employee-written message; it does not prove delivery.
5. **Return to AI** is explicit and preserves attempt limits/quiet periods.
6. **Close Handoff** keeps AI paused. It does not restart the agent.
7. Update outcomes in the chosen source of truth, and have an owner/admin review
   attribution with real payment evidence. Assisted/uncertain is not recovered.

Owners/admins can take unassigned work. Ordinary employees require assignment and
their own provisioned credentials. Do not claim email/push notifications exist:
the current workspace requires checking it or a separately configured notification workflow.

## Part D: Daily operations, changes and offboarding

### Step 26: Review results and operate the platform

Daily: review readiness, queue age, unknown/failed delivery, unassigned handoffs,
expired approvals, provider errors and backup status. Investigate by organization,
event/run/correlation ID, then case and delivery evidence. Avoid customer bodies
and secrets in support logs.

Weekly with the client: review monitored pipeline, engagement, handoff response
time, outcomes and verified payments. The workspace's 7/30/90-day financial window
uses **outcome occurrence time in UTC**, not payment-receipt or review time.
Currencies are separate; later attribution reviews can restate earlier periods.
These figures are reviewed attribution, not profit or experimentally proven ROI.

Do not automatically count all won opportunities, invoice-paid events or revenue
on every opportunity the AI touched. Refund/partial-payment reconciliation and
accounting automation require additional work.

### Step 27: Rotate credentials and change configuration safely

1. Track the expiry of each owner/member and integration key; current issued keys
   expire after 90 days. Schedule reminders before expiration.
2. For integration keys, create a replacement in `/integrations`, update the Zap/
   adapter, verify intake/receipts, then revoke the old key. Respect active-key limits.
3. For member rotation, the authenticated foundation API supports
   `POST /api/workforce/credentials/CREDENTIAL_UUID/rotate` with `{}`. It immediately
   revokes the old credential and returns a replacement. Coordinate access and
   save the response securely; do not use this as an overlapping integration rotation.
4. A lost/expired only-owner credential needs an audited operator/developer recovery
   procedure. There is no password-reset button to rely on. Do not create a duplicate
   organization or hand out the platform-admin password as a workaround.
5. Knowledge edits require fresh approval and Recovery version binding. Recovery
   configuration changes disable the agent and pause existing work; review, test,
   handle affected cases and explicitly re-enable when appropriate.
6. Encryption-key rotation is separate from API-key rotation and requires a reviewed
   migration/re-encryption plan. Preserve the old key until that plan is complete.

### Step 28: Pause, troubleshoot or roll back

For one client, disable its Recovery program and review outstanding dispatches.
Do not turn off ingestion/opt-out processing simply to stop sends. An already
claimed/accepted message may still complete; coordinate with its adapter/provider.

For a platform incident, coordinate the appropriate global delivery pause, inspect
all pending/unknown work and keep evidence. Stop the external adapter too when
necessary. A flag change is effective only after the relevant service redeploys.

For release rollback, use the tested deployment runbook: pause/drain worker and
delivery paths, reconcile uncertain operations, then roll back compatible code.
Do not drop additive tables, reset PostgreSQL, flush Redis or force jobs back to
pending. Do not return to legacy in-process mode with delegated work outstanding.

### Step 29: Offboard a client

1. Confirm the client's authorization and agreed retention/export requirements.
2. Disable their agents; review pending approvals, handoffs and in-flight messages.
3. Stop their source Zaps and delivery adapter, and disable their outbound destinations.
4. Revoke their integration/member credentials through authorized workflows.
5. Arrange authorized data export/retention with the operator. A one-click full
   organization export/deletion workflow is not supplied by this guide.
6. Retain required audit/delivery evidence; do not delete shared services, databases
   or Redis because one client is leaving.

## Troubleshooting

| Symptom                              | Check first / safe next action                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `/workspace` returns 404             | Web has the new release and `WORKFORCE_ENABLED=true`.                                                                                 |
| CRM returns 404                      | `CRM_ENABLED=true` and the member route is `/workspace/crm/contacts`.                                                                 |
| Login returns 401                    | Correct member token, not integration key; expiry/revocation; module-specific browser credentials.                                    |
| Integrations returns 403             | Owner/admin role and `integrations:write`; staff/viewer keys cannot manage it.                                                        |
| Worker starts a website              | Wrong effective start/config file; ensure worker command and no web migration inheritance.                                            |
| Worker cannot connect                | Private DB/Redis reference, credentials, environment, port, Redis persistence/readiness.                                              |
| `/ready` returns 503                 | Failed/pending migrations, missing deployment table, dependency outage or worker progress; inspect private logs.                      |
| Migration failed                     | Stop rollout; inspect actual schema and migration record. Never reset or mark applied blindly.                                        |
| Zap has 400/409                      | Required first-import fields, internal/external IDs, amount units, stage relationships or conflicting replay.                         |
| Zap has 429                          | Respect Retry-After, reduce bursts, keep stable IDs/timestamps.                                                                       |
| Records exist but agent does nothing | Disabled program, stale version, eligibility/stage/value/currency, delay, hours, consent, worker/model configuration.                 |
| Recovery save rejects a model        | Config `model` must exactly match an allowed tested ID. Do not put a placeholder into production.                                     |
| Knowledge is unavailable             | Latest approved active version, public audience, active source/document, exact text and permissible risk.                             |
| Simulation checkmark disappeared     | New configuration version/draft differs; rerun against the saved version.                                                             |
| Approved message never sends         | Installed adapter, program connection, claim flag on web, fresh guards, lease and provider readiness. Approval alone is insufficient. |
| Message is unknown                   | Reconcile provider receipt using the original claim context. Never resend blindly.                                                    |
| Outbound event stays queued          | Worker/webhook delivery gate, destination enabled, encryption key and private error/attempt history.                                  |
| No recovered revenue                 | Outcome window, reviewed attribution, confirmed delivery/engagement, payment reference, amount and currency; don't bypass evidence.   |
| Employee exists but cannot sign in   | Assignment creation is not credential provisioning. Arrange individual audited access.                                                |

## Copyable client launch checklist

Copy this into a **private** client onboarding record. Store secret-manager references,
not actual tokens, connection URLs or provider passwords.

```markdown
# Client AI Workforce Launch

- Business:
- Organization UUID:
- Verified owner/admin:
- Human handoff owner / backup:
- CRM source of truth:
- Currency / timezone:
- Target pipeline / stage UUIDs:
- Model ID / program version:
- Approved template version IDs:
- Inbound connection UUID:
- Delivery connection UUID / adapter implementer:
- Secret-manager record references:
- Credential expiries / rotation reminder:
- Pilot audience and date:
- Incident contact:

## Data and access

- [ ] Organization provisioned once; correct member access verified.
- [ ] Individual staff access arranged, or owner explicitly covers the pilot.
- [ ] CRM sample records/stages/values/assignments verified.
- [ ] Source timestamps and duplicate handling verified.
- [ ] Inbound replies and opt-outs verified.
- [ ] Approved knowledge and exact message-version bindings verified.
- [ ] Channel consent evidence recorded; DND preserved.

## Safety and delivery

- [ ] Recovery scope, hours, attempts and handoff rules approved.
- [ ] Current configuration simulated; unsupported behavior remains blocked.
- [ ] Adapter installed and certified, not merely a connection created.
- [ ] Provider sender and receipt path approved.
- [ ] Unknown outcomes, STOP, takeover, closure and restart tests passed.
- [ ] Global flag change reviewed for other tenants' queued work.
- [ ] Exact-action approval and pilot coverage understood.

## Launch and follow-up

- [ ] Limited program explicitly enabled after approval.
- [ ] First approved send and provider-confirmed receipt verified.
- [ ] First inbound response and handoff verified.
- [ ] Client trained on Today, takeover/respond/return/close.
- [ ] Baseline and payment-evidence reporting agreed.
- [ ] Backups, monitoring and daily review owner assigned.
- [ ] Credential rotation and weekly pilot review scheduled.

Client approval / date:
Platform operator approval / date:
Outstanding limitations accepted:
```

## Technical references

- [Production deployment and rollback](docs/DEPLOYMENT.md)
- [Product workspace and reporting definitions](docs/PRODUCT_WORKSPACE.md)
- [Canonical CRM API and member/operator access](docs/CRM_API.md)
- [Universal Zapier integration contract](docs/ZAPIER_INTEGRATION.md)
- [Revenue Recovery and delivery protocol](docs/REVENUE_RECOVERY.md)
- [Business Knowledge](docs/BUSINESS_KNOWLEDGE.md)
- [Communication layer and provider limits](docs/COMMUNICATIONS.md)
- [Agent Builder](docs/AGENT_BUILDER.md)
- [Agent Runtime](docs/AGENT_RUNTIME.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Product verification](docs/PRODUCT_WORKSPACE_VERIFICATION.md)
- [Existing voice booking/availability onboarding](ZAPIER_CLIENT_ONBOARDING.md)

This guide was checked against local code and official documentation, not against
your live Railway dashboard or actual client integrations. No deployment, provider
call, credential issuance, client onboarding or production database mutation was
performed while writing it. Changes in Railway/provider interfaces should be
verified against their current official documentation before applying them.
