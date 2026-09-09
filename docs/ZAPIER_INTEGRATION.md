# Zapier and generic webhook integration

Steel Scale owns its CRM and canonical events. Your CRM can remain the system your team
uses daily: Zapier maps its notifications into Steel Scale, and a separate Zap applies
selected Steel Scale updates back to that CRM. No native CRM SDK or GHL account is required.
This integration is separate from the existing booking/availability Zaps.

```text
CRM trigger -> Zapier webhook action -> authenticated Steel Scale intake
                                       -> CRM + canonical events + durable jobs

Steel Scale event -> durable outbound delivery -> Zapier Catch Hook -> CRM action
```

## Operator prerequisites

1. Back up the database and rehearse the migrations in staging. Apply
   `20260908210000_zapier_webhooks` with the preceding migrations, then generate the
   matching Prisma client and deploy the application. Do not reset a production database.
2. Set `WORKFORCE_ENABLED=true` and `APP_URL` to your public HTTPS origin, without a
   trailing path. `CRM_ENABLED=true` is only needed for the separate native CRM API/UI.
3. For outbound webhooks, configure `INTEGRATION_ENCRYPTION_KEY` as exactly 64 random hex
   characters (32 bytes), stored in Railway's secret configuration. Use the same key on
   API and worker replicas. Never commit or paste the actual key into these docs.
4. Run `npm run start:workforce-worker` with `WORKFORCE_ENABLED=true`,
   `WORKFORCE_WORKER_ENABLED=true` and, only when ready to send,
   `WEBHOOK_DELIVERY_ENABLED=true`. The last flag defaults false. Queuing works while
   sending is paused. The existing `railway.workforce.json` worker configuration is reused.

API keys expire after 90 days. Outbound URLs and HMAC signing secrets use AES-256-GCM
encryption, bound to the organization, endpoint and field. Preserve the encryption key:
changing it without re-encrypting stored data makes existing destinations unreadable.
There is no automated key-rotation migration in this increment. Back up the key securely;
plan rotation separately. An encryption/configuration failure retains and retries deliveries.

## Admin access and credentials

Organization owners/admins can open `/integrations`. The current repository has no customer
SSO/session login, so this page uses HTTP Basic authentication over HTTPS: use username
`organization` and your **member** API credential as the password. Every request rechecks
membership, expiry/revocation and `integrations:write`; ordinary members/viewers and
integration-only keys cannot manage integrations. Close the browser session when finished;
browser-managed Basic credentials are not an SSO/logout experience.

Platform operators use the existing operator login at `/admin/integrations` and explicitly
select an organization. Do not give customers the shared operator password. Both pages
reuse the Steel Scale admin design, signed CSRF forms, no-store responses and restrictive CSP.

In **Connect your CRM**, create a connection for one source CRM/account. Copy its generated
API key immediately into your secret manager/Zapier configuration. Only a SHA-256 hash is
stored; the key is not available on later page loads or API reads. The UI shows its expiry
and allows replacement-key creation and revocation. Create a replacement, update Zapier,
verify a test, then revoke the old key; at most five unexpired active keys per connection.
Credential creation and revocation are audited.

## CRM → Zapier → Steel Scale

1. Create a Zap with the relevant CRM trigger (for example an estimate update).
2. Add **Webhooks by Zapier**, using POST or Custom Request to send JSON. The official
   [webhook action guide](https://help.zapier.com/hc/en-us/articles/8496326446989-Send-webhooks-in-Zaps)
   describes those request options.
3. Copy the organization-specific URL from Steel Scale:
   `https://YOUR-STEEL-SCALE-HOST/api/integrations/webhooks/CONNECTION_ID/events`.
4. Set `Content-Type: application/json` and `Authorization: Bearer CONNECTION_API_KEY`.
   Keep the key in the header, never in a URL/query parameter or payload.
5. Map source fields into the example below, or configure field-path mapping when creating
   the connection. Preserve the source event ID and observation timestamp on retries.
6. Send fictional test data first. Check the response and **Recent inbound activity**,
   then verify the canonical contact/opportunity/estimate before turning on the Zap.

The shorter `POST /api/integrations/webhooks/events` is also supported. It is **not** an
unauthenticated global webhook: its connection and organization are resolved exclusively
from the connection-bound bearer key. A key cannot use another connection's URL. The body
cannot choose `organizationId`, `organization_id`, `source` or `provider`.

### Version 1 integration envelope

This is transport version 1; its resulting internal BusinessEvents use canonical version 2.
One source notification can atomically upsert several related records and publish several
correlated facts. External IDs are mapped to newly generated Steel Scale UUIDs, never used
as internal primary keys.

Example first estimate import:

```json
{
  "version": 1,
  "event": "estimate.sent",
  "external_id": "crm-notification-123",
  "occurred_at": "2026-09-08T12:00:00Z",
  "contact": { "external_id": "contact-7", "name": "Alex Example" },
  "pipeline": { "external_id": "pipeline-1", "name": "Service agreements" },
  "stage": { "external_id": "stage-2", "name": "Proposal sent", "outcome": "open" },
  "opportunity": {
    "external_id": "opportunity-42",
    "title": "Annual service agreement",
    "amount_minor": 125000,
    "currency": "USD"
  },
  "estimate": {
    "external_id": "estimate-9",
    "number": "EST-9",
    "title": "Annual service",
    "amount_minor": 125000,
    "currency": "USD"
  },
  "metadata": { "workflow": "Optional source metadata; not retained verbatim" }
}
```

For a later acceptance, mapped records need not be repeated:

```json
{
  "version": 1,
  "event": "estimate.accepted",
  "external_id": "crm-notification-124",
  "occurred_at": "2026-09-08T13:00:00Z",
  "estimate": { "external_id": "estimate-9" }
}
```

The top-level `external_id` identifies the **notification**, not the customer or estimate.
Each nested `external_id` identifies its stable **record**. You may use the
`Idempotency-Key` header instead of a top-level notification ID. If both are present they
must match. If neither exists, a deterministic body hash is used; identical bodies then
represent one observation. Explicit source notification IDs are preferable. Always include
a real source `occurred_at`, with timezone; do not substitute “now” on every retry.

### Optional fields and mapping

Only fields needed to create the canonical entity are required on first import. Updates
may be partial. A related object containing only its external ID refers to an already
mapped record without updating its watermark. Missing fields are preserved; permitted
explicit nulls clear optional values. Snake-case fields and their camelCase equivalents
are accepted; nested `id` is an alias for `external_id`. Integer strings from Zapier are
accepted for `amount_minor` and `position`. DNC accepts booleans or `"true"`/`"false"`.
Amounts are integer **minor units**: USD 125000 = $1,250.00. No currency or major/minor-unit
conversion is guessed. For first opportunities/estimates, supply explicit currency/value.

To keep a vendor-shaped payload, configure a mapping object at connection creation:

```json
{
  "event": "notification.kind",
  "external_id": "notification.id",
  "occurred_at": "notification.timestamp",
  "contact.external_id": "customer.id",
  "contact.name": "customer.display_name",
  "contact.email": "customer.primary_email"
}
```

Keys are supported Steel Scale target paths; values are simple dotted source paths, up to
six segments. There is no executable JavaScript/template evaluation, arbitrary internal
ID mapping or fuzzy email/name matching. Mapping is currently set when creating a connection;
changing an established mapping requires an intentional configuration migration/new
connection and mapping existing records, not blind duplicate imports. Unknown raw vendor
fields/metadata are ignored; native CRM fields still pass the existing domain validation.
This increment does not import arbitrary custom fields from vendor metadata.

### Supported information

Every provided object needs `external_id` (or nested `id`). On first import:

| Object         | Other creation requirements / selected optional fields                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `contact`      | `name`, or `first_name`/`last_name` sufficient to form a name. Optional email, international-format phone, `do_not_contact`.                |
| `pipeline`     | `name`. Organizations choose their own pipeline names.                                                                                      |
| `stage`        | `name` and related pipeline. Optional position; otherwise append. `outcome` is open/won/lost, default open. Display names are unrestricted. |
| `opportunity`  | `title`, contact, pipeline/stage, `amount_minor`, currency. Optional `last_activity_at`.                                                    |
| `estimate`     | `number`, title, opportunity, amount/currency. Optional status, issued/expires/accepted timestamps.                                         |
| `appointment`  | title, contact, `starts_at`, `ends_at`, timezone. Optional opportunity, location, status.                                                   |
| `conversation` | subject, contact, channel (sms/email/phone/web/other).                                                                                      |
| `message`      | body and related conversation; the message is recorded inbound, not sent.                                                                   |
| `invoice`      | amount/currency; overdue also needs `due_at`. Related contact or opportunity required.                                                      |
| `job`          | title and related contact or opportunity.                                                                                                   |

Events: `contact.created/updated`, `opportunity.created/updated/stage_changed/won/lost`,
`estimate.created/updated/sent/accepted/declined`, `appointment.created/booked/cancelled`,
`customer.message_received`, `invoice.created/overdue/paid`, `job.created/completed`.
Created/updated inputs are upserts; lifecycle facts are derived from actual committed state.
The primary object must match the event. Dependent pipeline/stage/conversation objects
can be included to establish relationships. Pipeline changes require mapped/new pipeline
and stage objects; won/lost must agree with the canonical stage outcome.

Inbound message example (after creating a contact):

```json
{
  "version": 1,
  "event": "customer.message_received",
  "external_id": "delivery-1",
  "occurred_at": "2026-09-08T13:05:00Z",
  "contact": { "external_id": "contact-7" },
  "conversation": { "external_id": "thread-8", "subject": "Service question", "channel": "sms" },
  "message": { "external_id": "sms-123", "body": "Please call me tomorrow." }
}
```

Preserve the external message ID even when the vendor gives each retry a new delivery ID.
It prevents a second Message/received event from being created for the same message.
Conflicting content for that message identity is rejected.

Invoice/job notifications remain canonical external observations linked to internal CRM
records, not native invoice/job tables or proof of earned revenue. `invoice.paid` does not
automatically record recovered revenue or mark an opportunity won. Sensitive actions
still require the existing approval/policy workflow.

### Results and retries

- 202: receipt committed. Response includes `records` (canonical UUIDs), `results` and
  `correlationId`. Nested `ignored/reason` identifies stale or duplicate-record observations.
  It does not mean agent processing or an external action has completed.
- 200: identical notification already received; returns the persisted original result.
- 400/409: invalid fields, missing relationships, identity conflicts or changed payload
  using an existing event ID. Correct the source data; do not retry unchanged indefinitely.
- 401/403: invalid/revoked/expired key, wrong connection or insufficient scope.
- 413: exceeds the 64 KiB JSON request limit. 429: respect `Retry-After: 60`.
- 5xx: retry with the same notification ID, timestamp and body. Transaction rollback
  prevents partial contact/opportunity/estimate imports.

Outer receipt deduplication, per-entity canonical intake, external record mappings and
handler receipts all operate within tenant boundaries. Source ordering uses the existing
watermark/local-edit protection documented in [EVENT_ARCHITECTURE.md](EVENT_ARCHITECTURE.md).
It is conservative timestamp ordering, not a full bidirectional conflict-resolution engine.
When an opportunity import omits `last_activity_at`, its source observation timestamp is
used; importing an old estimate does not make it look newly active.
Do not dual-feed a source through old `/api/workforce` webhooks and this new endpoint:
transport namespaces are distinct. Plan the cutover and reuse/map existing canonical IDs.

## Steel Scale → Zapier → CRM

1. Create a second Zap with **Webhooks by Zapier → Catch Hook** (or Catch Raw Hook if
   you need exact bytes/headers for signature verification). Zapier supplies a unique
   receiving URL, as described in its [webhook trigger guide](https://help.zapier.com/hc/en-us/articles/8496288690317-Trigger-Zaps-from-webhooks).
2. In Steel Scale **Send updates to Zapier**, paste that HTTPS URL and select events.
   Store the one-time signing secret securely. Subsequent reads show only the destination
   name/host, never its secret URL path/query or signing secret.
3. Leave **Include imported events** off to avoid feeding CRM imports straight back into
   the same CRM. Leave contact details off unless that Zap needs changed name/email/phone/title.
4. Choose **Send test event**. It queues a harmless `integration.test` through the same
   worker/retry path. Enable the worker deliberately; no synchronous untracked send occurs.
5. Verify the test in Zapier, then add a filter for the desired event and the CRM action.
   Ignore `integration.test` in production actions. Deduplicate by the stable payload `id`
   (and organization) before creating downstream tasks/messages. Where supported, pass
   the stable delivery ID as the receiving API's idempotency key.
6. Use `entity.id` for the Steel Scale UUID. `external_records` supplies up to 50 scoped
   primary-record mappings (connection/provider/type/external ID) for finding the existing
   CRM record. Select the mapping for the correct connection; never create another CRM
   customer solely because the webhook was retried.

### Available outbound events

| Event                                                      | Current producer                                                                                      |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `agent.handoff_created`                                    | Successful human approval creates the existing unsent recovery handoff.                               |
| `agent.action_completed`                                   | The same approved internal tool completes. It does **not** assert SMS/email delivery.                 |
| `opportunity.recovered`                                    | Validated, operator-reported assisted-revenue evidence; not inferred from a won stage alone.          |
| `contact.updated`, `opportunity.updated`                   | Canonical CRM updates, including UI/API changes.                                                      |
| `estimate.sent`, `estimate.accepted`, `appointment.booked` | Corresponding committed lifecycle facts.                                                              |
| `appointment.recovered`                                    | Contract/subscription reserved; no appointment attribution producer yet. Do not rely on receiving it. |

Payload example (fields depend on the event and privacy setting):

```json
{
  "version": 1,
  "id": "CANONICAL_EVENT_UUID",
  "event": "agent.handoff_created",
  "organization_id": "ORGANIZATION_UUID",
  "occurred_at": "2026-09-08T13:00:00.000Z",
  "correlation_id": "CORRELATION_UUID",
  "entity": { "type": "opportunity", "id": "OPPORTUNITY_UUID" },
  "external_entity": null,
  "external_records": [],
  "source": { "provider": "steel_scale", "connection_id": null },
  "data": { "actionId": "ACTION_UUID", "customerId": "CONTACT_UUID", "deliveryStatus": "not_sent" }
}
```

Payloads are event-time patches/identifiers, not full CRM exports. Arbitrary metadata,
custom fields, private notes, message bodies and proposed message text are not forwarded.
Status/amount/currency/stage/pipeline/action/revenue/customer IDs are allowlisted. Names,
email, phone and titles require explicit contact-detail opt-in. Destination subscriptions
and payloads are snapshotted transactionally with event publication; changing current CRM
data cannot alter a queued webhook. New endpoints do not backfill historical events.

### Signing, delivery and failure visibility

Every request includes `X-SteelScale-Delivery`, `Idempotency-Key`,
`X-SteelScale-Timestamp` (Unix seconds) and `X-SteelScale-Signature`:

```text
v1=hex(HMAC-SHA256(signing_secret, timestamp + "." + exact_request_body))
```

Generic receivers should verify the HMAC using a constant-time comparison, enforce an
appropriate timestamp tolerance (for example five minutes), and persist delivery/event
IDs for deduplication. Signatures are regenerated per attempt; the payload and delivery ID
remain stable. For a plain Zapier Catch Hook, protect its capability URL as a credential;
signature headers are supplied but Steel Scale does not assume Zapier verifies them.

Only public HTTPS destinations on the default port are accepted. No URL credentials,
fragments or literal IP addresses. Every attempt checks all DNS answers, rejects
private/reserved networks, pins the selected public address while retaining TLS hostname
verification, and follows no redirects. DNS/request time is bounded to ten seconds. No
response bodies or full destination URLs are logged.

Outbound delivery is **at least once**, not an exactly-once network guarantee. If the
receiver accepts a request and the worker crashes before recording success, the request
can be retried. Receivers must deduplicate. PostgreSQL claims use 60-second leases and
fencing tokens; network I/O occurs outside the transaction. An expired lease leaves an
`outcome_unknown` attempt record when reclaimed. Normal failures retry exponentially
(20, 40, 80 seconds, etc., capped at one hour), up to eight attempts. Non-2xx responses,
timeouts and configuration failures are retained, not silently discarded.

After exhaustion, the row is `dead`. Fix the receiver/configuration, enable its endpoint,
then use **Retry delivery** to allow eight further attempts while retaining the same ID,
payload and complete attempt history. Disabled endpoints do not send unstarted queued
requests; those deliveries become visible dead entries when claimed. Disabling cannot
recall an already in-flight request. Successful HTTP receipt only means the receiver
accepted the webhook, not that the Zap or downstream CRM action succeeded. Inspect Zapier's
run history for the second half of the workflow.

Endpoint URLs/subscriptions are immutable in this initial API; create a replacement and
disable the old endpoint deliberately. Never silently redirect old queued events to a new URL.
Setting the send flag false pauses delivery without deleting pending work.

## Management API

All management operations require an owner/admin **member** credential with
`integrations:write`; connection credentials have only `events:write`.

| Method/path (under `/api/integrations`)   | Body / result                                                                                                     |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET /`                                   | Scoped connections, credential metadata, redacted endpoints, recent inbound and outbound activity (50 rows each). |
| `POST /connections`                       | `{name, provider?: "zapier" or "generic_webhook", mapping?: {...}}`; returns connection ID and one-time token.    |
| `POST /connections/:id/credentials`       | `{}`; new one-time key for an enabled connection.                                                                 |
| `POST /credentials/:id/revoke`            | `{}`; revoke only a credential in this organization.                                                              |
| `POST /outbound`                          | `{name,url,events:[...],includeExternal?:false,includeContactData?:false}`; one-time signing secret.              |
| `POST /outbound/:id/test`                 | `{}`; queued synthetic test.                                                                                      |
| `POST /outbound/:id/enable` or `/disable` | `{}`; audited destination state change.                                                                           |
| `POST /deliveries/:id/retry`              | `{}`; requeue a dead delivery only when its endpoint is enabled.                                                  |

Responses exclude API key hashes, encrypted secrets, raw destination URLs and signing
secrets except at initial generation. Tenant-owned FKs protect endpoints, events,
deliveries, attempts and activity. Direct SQL credentials remain privileged; there is no
new PostgreSQL RLS layer. The authenticated API/UI enforce server-side tenant scoping.

Authenticated requests are limited to 120/minute per organization using a shared
PostgreSQL counter. An additional in-process 300/minute transport-peer limit protects
authentication. Forwarded IP headers are not trusted. Behind Railway/proxies this peer
guard may group multiple clients; configure appropriate trusted ingress/edge limits for
production traffic rather than trusting arbitrary `X-Forwarded-For`. Rate counters reset
each minute. JSON payloads are bounded to 64 KiB and depth eight. There is no unauthenticated
public endpoint or credential-in-query support.

## Diagnostics, data minimization and verification

Authenticated accepted/duplicate/domain-rejected intake is recorded with response code,
safe error code, payload hash, allowlisted section names and field count. Raw webhook
bodies, arbitrary vendor keys/metadata, auth headers and extra sensitive fields are not
retained. Necessary normalized CRM fields and canonical event facts remain in their usual
scoped stores. This deliberately favors data minimization over a raw-payload replay UI;
use the source/Zapier history to investigate with the payload hash. Malformed JSON,
pre-authentication failures, size/depth rejection and rate-limit rejection return safe
errors without storing attacker-controlled diagnostic bodies. No raw query/provider error
is returned to a caller. Define retention/backups and access policies for these stores;
the implementation does not automatically purge failed deliveries or audit records.

Tests: `test:integrations`, `test:integrations:integration`, `test:integrations:browser`.
Integration/browser/migration tests require `NODE_ENV=test` and an explicit disposable
loopback database accepted by the repository's test-database guard. Browser checks are
read-only; fixture setup happens through application services. Outbound test transports
are mocked, and the browser blocks external requests. No real Zapier account was contacted.

See [ZAPIER_VERIFICATION.md](ZAPIER_VERIFICATION.md) for this increment's verification and
[ARCHITECTURE.md](ARCHITECTURE.md) for domain boundaries and rollout context.
