# Universal Steel Scale events

The subsequent [Zapier/generic integration increment](ZAPIER_INTEGRATION.md) adds flexible
bundled intake, signed outbound deliveries and integration management. Its outbox now
subscribes at canonical publication time. The earlier "future sender" scope below refers
to external SMS/email tool execution, not the new opt-in webhook transport.

Implemented September 8, 2026. This extends the existing Express/Prisma/PostgreSQL
application; it does not introduce a broker, replace booking, or require a vendor CRM.
The code contract is [`src/events/contracts.ts`](../src/events/contracts.ts).

## Boundaries and flow

```text
Authenticated external relay -> provider adapter -> canonical change intake
                                                    |
Internal CRM action ---------------------------> CRM service
                                                    |
                          one organization-locked PostgreSQL transaction
                          CRM mutation + BusinessEvent + links + outbox job
                                                    |
                          leased worker -> EventRouter -> EventHandler
                          DB effects + handler receipt + completed job
```

- `contracts.ts`: versioned types, event registry, bounded payload and timestamp validation.
- `publisher.ts`: scoped reference checks, immutable publication, correlation, audit and outbox.
- `intake.ts`: authenticated connection receipts, source ordering, mappings and CRM projection.
- `adapters/ghl.ts`: isolated GHL opportunity translation. Consumers never inspect GHL payloads.
- `src/crm/events.ts`: shared lifecycle detection for native CRM actions and imported changes.
- `router.ts`: explicit handler registry, historical v1 compatibility and transactional receipts.
- `handlers.ts`: current production consumer registry; reuses the existing recovery runtime.
- `src/workforce/jobs/`: existing durable queue, leases, fencing, retry and dead-letter state.

This is a transactional event ledger/outbox, not a complete event-sourced CRM. Current CRM
rows remain authoritative. Change payloads are validated patches/facts, not guaranteed full
snapshots; consumers needing current state must query scoped repositories.

## Canonical internal envelope (v2)

Example of a normalized, persisted stage-change fact delivered to a handler:

```json
{
  "version": 2,
  "id": "10000000-0000-4000-8000-000000000001",
  "organizationId": "20000000-0000-4000-8000-000000000001",
  "type": "opportunity.stage_changed",
  "entity": { "type": "opportunity", "id": "30000000-0000-4000-8000-000000000001" },
  "externalEntity": { "type": "opportunity", "id": "vendor-opportunity-42" },
  "source": {
    "system": "connection:40000000-0000-4000-8000-000000000001",
    "provider": "ghl",
    "connectionId": "40000000-0000-4000-8000-000000000001",
    "eventId": "delivery-42:opportunity.stage_changed"
  },
  "actor": "credential:example",
  "occurredAt": "2026-09-08T12:00:00.000Z",
  "receivedAt": "2026-09-08T12:00:03.000Z",
  "correlationId": "10000000-0000-4000-8000-000000000002",
  "causationId": "10000000-0000-4000-8000-000000000002",
  "relatedRecordIds": ["30000000-0000-4000-8000-000000000001"],
  "metadata": { "originEventType": "OpportunityStageUpdate", "schema": "external-change.v2" },
  "data": {
    "fromStageId": "50000000-0000-4000-8000-000000000001",
    "toStageId": "50000000-0000-4000-8000-000000000002",
    "fromPipelineId": "60000000-0000-4000-8000-000000000001",
    "toPipelineId": "60000000-0000-4000-8000-000000000001"
  }
}
```

Internal IDs are Steel Scale UUIDs, never vendor IDs. Source system and provider come
from trusted application context or the authenticated connection, not webhook fields.
The publisher generates the event ID, received timestamp, and default correlation ID.
An optional upstream correlation UUID groups related work but does not grant access or
provide idempotency. `causationId` is a same-organization event FK. Lifecycle children
share the base event's correlation ID and identify that base event as their cause.

`occurredAt` is the source observation time; `receivedAt` is server receipt time. Require
timezone-bearing ISO timestamps; normalize UTC; reject invalid calendar dates and source
times more than five minutes ahead. Generic event data is limited to 24 KiB, depth six,
100 array/object entries and 10,000 characters per string. Entity-specific CRM validation
also applies to imports. Unknown fields, event types and versions fail closed.

The Prisma `BusinessEvent` continues to map to the existing `WorkforceEvent` SQL table.
Metadata columns are nullable solely for historical v1 rows; new v2 publications require
context. `readCanonicalEvent` reconstructs and validates the internal envelope from the
stored columns and payload. HTTP event-list/CRM activity responses retain their existing
Prisma-row shape; use this reader in internal consumers rather than parsing storage JSON.

## Event vocabulary

| Events                                                                                                                                                            | Canonical `data` and behavior                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contact.created`, `contact.updated`; `opportunity.created`, `opportunity.updated`; `estimate.created`, `estimate.updated`; `appointment.created`, `task.created` | `{changes, recordVersion?}`. CRM writes publish their committed version.                                                                           |
| `opportunity.stage_changed`                                                                                                                                       | Previous/next stage and pipeline UUIDs, as above. Each stage must belong to its supplied pipeline and organization.                                |
| `opportunity.won`, `opportunity.lost`                                                                                                                             | `{previousStatus, status}`; stage outcome determines status, not a vendor's stage name.                                                            |
| `estimate.sent`, `estimate.accepted`, `estimate.declined`                                                                                                         | `{previousStatus, status}`.                                                                                                                        |
| `appointment.booked`, `appointment.cancelled`                                                                                                                     | `{previousStatus, status}`; booked corresponds to canonical appointment status `scheduled`.                                                        |
| `task.completed`                                                                                                                                                  | `{previousStatus, status}`.                                                                                                                        |
| `customer.message_received`                                                                                                                                       | `{messageId, conversationId, contactId, channel, body}`; the recorded inbound message and conversation must match.                                 |
| `invoice.created`, `invoice.overdue`, `invoice.paid`                                                                                                              | `{amountMinor, currency, dueAt?}`; overdue requires a due date no later than observation time.                                                     |
| `job.created`, `job.completed`                                                                                                                                    | `{title}`.                                                                                                                                         |
| Other canonical CRM resources                                                                                                                                     | `created`, `updated`, `archived` facts; registry also covers pipeline reorder, custom-field, connection, member, mapping and organization changes. |
| `recovery.scan.requested`                                                                                                                                         | Empty data; organization subject.                                                                                                                  |

For an opportunity move to a won stage, publish `opportunity.updated`,
`opportunity.stage_changed`, and `opportunity.won` atomically. A repeated status with no
transition does not produce another status fact. Initial records already in a lifecycle
state can produce a status fact with `previousStatus: null`. The recovery handler subscribes
only to base opportunity changes and explicit scans, avoiding multiple runs from this
fan-out. Future handlers should make an equally explicit subscription choice.

Invoice/job types are currently validated external observations with `entity.id: null`,
an external identity and at least one related existing canonical CRM record. There are no
invented Invoice/Job tables, payment processing or automatic revenue attribution here.
Adding native billing/job domains later requires an explicit versioned contract extension.

## Idempotency, retries and ordering

| Layer                 | Durable identity                                                                 | Protection                                                                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| External intake       | organization + source connection namespace + delivery ID                         | `EventIntake` checks a canonicalized raw-input SHA-256 before resolving mutable mappings. Identical retries return the original IDs; changed input with the same ID returns 409. |
| Canonical publication | organization + source system + idempotency key                                   | Existing `BusinessEvent` unique key and payload hash prevent duplicate facts/jobs. Child facts use deterministic `base-key:event-type` keys.                                     |
| Handler delivery      | organization + event ID + stable handler ID                                      | `EventDelivery` records success in the same transaction as all handler effects. Re-dispatch skips completed handlers.                                                            |
| Domain effects        | Existing agent/event and opportunity/action uniqueness; external record mappings | Additional protection for recovery runs/actions and inbound message identity across different delivery IDs.                                                                      |

The external receipt, CRM writes, external mapping, event facts, audit and jobs commit
together under the organization row lock. Concurrent retries serialize across replicas.
Handlers run under that same tenant lock. If any handler fails, all effects and receipts
from that dispatch roll back. The existing worker retries with backoff, lease-token fencing
and a five-attempt limit, then retains a dead job for operator inspection/retry.

Use stable delivery IDs and retain the exact same semantic body on retry, including
timestamps. JSON object key ordering is irrelevant. Do not generate a new timestamp for
each retry. Intake records acknowledged stale/archived/already-imported observations
without queueing agent work. HTTP 202 means recorded, not that a handler has completed;
200 indicates a duplicate. Inspect `ignored` and `reason`, not only the HTTP status.

For imports, `ExternalRecordMapping.sourceUpdatedAt` is the source watermark. Older/equal
observations are ignored. A delayed but newer source update can apply when this connection
published the exact current record version. Otherwise the local record's update timestamp
protects intervening native or other-connection edits. This conservative timestamp policy
does not implement arbitrary vendor sequence numbers or conflict resolution. Queue order
is not a guarantee of source-event order; agents evaluate current scoped CRM state.

Inbound message identity is also deduplicated by connection + external message type/ID.
A second delivery ID for the same message creates no second inbound message, received
fact or reply work. Conflicting content for that identity returns 409. This requires the
relay to preserve the provider's stable message ID, not substitute a delivery ID.

The guarantees cover committed database effects, **not exactly-once network delivery**.
Handlers must not send SMS/email, call providers, or spawn untracked asynchronous work.
Write a durable approved-action/outbox intent instead. A future sender needs provider
idempotency keys and delivery reconciliation before it can be enabled safely. No new
automatic message sender is included in this increment.

## Tenant boundary

All external endpoints require a hashed bearer credential bound to one organization and
one enabled connection with `events:write`. V2 intake rechecks revocation, expiry and scope
inside the mutation transaction. Organization/source/actor cannot be supplied in the body.
Mapping lookups and CRM mutations are scoped server-side; entity type mismatches fail.
Composite database FKs constrain event subject, related records, cause, connection, intake
and handler receipts to the same organization. The worker's cross-tenant job claim is
intentional infrastructure; processing always re-enters the claimed tenant boundary.

There is no PostgreSQL RLS retrofit in this increment. Application code with direct Prisma
access must still use explicit tenant predicates; handlers receive a transaction, not an
unscoped HTTP capability. No frontend filter is treated as authorization. Event payloads
can contain customer/message PII: use scoped access, avoid raw payload logging, and define
retention/redaction procedures before production onboarding.

## External relay API examples

Enable `WORKFORCE_ENABLED=true` after migrations. The separate native CRM API/UI also
requires `CRM_ENABLED=true`; event intake does not depend on that UI flag. Worker execution
requires `WORKFORCE_WORKER_ENABLED=true`. All flags remain false by default.

Provision a connection with an owner/admin credential via `POST /api/workforce/integrations`:

```json
{ "name": "Example estimate relay", "provider": "jobber" }
```

Supported connection labels are `zapier`, `generic_webhook`, `ghl`, `jobber`, `housecall_pro`.
This does not install native Jobber/Housecall Pro SDKs: their relays send the normalized
contract. Use the returned connection-scoped token as `Authorization: Bearer <token>` for
`POST /api/workforce/webhooks/<connection-id>/canonical`.

An existing mapped estimate sent by Jobber, Zapier or another relay:

```json
{
  "version": 2,
  "id": "estimate-notification-42",
  "type": "estimate.sent",
  "occurredAt": "2026-09-08T12:00:00Z",
  "entity": { "type": "estimate", "externalRecordType": "estimate", "externalId": "estimate-9" },
  "data": {}
}
```

For `contact.created`, use `entity.type: "contact"` and `data: {"changes":{"name":"Alex Example"}}`.
Created records receive canonical IDs and external mappings atomically. Other generic
created/updated inputs use `{changes: <native CRM fields>}` with the validation documented
in [CRM_API.md](CRM_API.md). Updates require an existing mapping; the service handles
optimistic version selection under its lock. Referenced internal UUIDs must belong to the
same tenant. Immutable fields (for example an estimate's currency on update) remain immutable.

For `opportunity.stage_changed`, `opportunity.won` or `opportunity.lost`, use:

```json
{ "stageExternalId": "stage-closed", "pipelineExternalId": "pipeline-services" }
```

This is the external `data`, not the internal fact. Configure `pipeline` and `pipeline_stage`
mappings first. The service derives before/after IDs and validates the stage outcome.
For other lifecycle transitions (`estimate.accepted`, `appointment.booked`, `task.completed`,
etc.), send empty data and an existing entity mapping.

Inbound customer message (requires a `conversation` mapping):

```json
{
  "version": 2,
  "id": "message-delivery-123",
  "type": "customer.message_received",
  "occurredAt": "2026-09-08T12:00:00Z",
  "entity": { "type": "message", "externalRecordType": "message", "externalId": "sms-456" },
  "data": { "conversationExternalId": "thread-789", "body": "Please call me tomorrow." }
}
```

Invoice/job observations additionally need
`relatedEntity: {externalRecordType: "opportunity", externalId: "mapped-opportunity-1"}`;
their `data` follows the vocabulary table. No arbitrary raw event publication endpoint
allows integration credentials to bypass CRM validation.

## Optional GHL adapter

Inspection found existing outbound GHL booking/lead delivery and availability support,
but no incoming GHL opportunity webhook to replace. Those production integrations are
unchanged. The new adapter is an **authenticated relay endpoint**, not an unauthenticated
native marketplace webhook receiver:
`POST /api/workforce/webhooks/<connection-id>/ghl`.

Create a `ghl` connection with `externalAccountId` set to its allowed GHL location ID.
Map its existing opportunity, contact (`externalRecordType: "customer"` for legacy
compatibility), pipeline and stages to Steel Scale IDs. Full snapshots are supported for
OpportunityUpdate, OpportunityStageUpdate, OpportunityStatusUpdate and
OpportunityMonetaryValueUpdate; unmapped records and partial snapshots fail closed.

```json
{
  "id": "stable-ghl-delivery-id",
  "occurredAt": "2026-09-08T12:00:00Z",
  "payload": {
    "type": "OpportunityStageUpdate",
    "locationId": "configured-location",
    "id": "mapped-opportunity-1",
    "contactId": "mapped-contact-1",
    "name": "Annual service agreement",
    "pipelineId": "mapped-pipeline-1",
    "pipelineStageId": "mapped-won-stage",
    "status": "won",
    "monetaryValue": 123.45
  }
}
```

The adapter checks the bound location, mapped contact and stage/pipeline pair; requires
status to agree with the canonical stage outcome; and converts monetary value using the
existing internal opportunity's currency precision. It never guesses a currency or maps
stages by display name. Original vendor event type is retained in metadata.

The full-snapshot field selection follows the official
[OpportunityUpdate](https://marketplace.gohighlevel.com/docs/webhook/OpportunityUpdate/index.html)
and [OpportunityStageUpdate](https://marketplace.gohighlevel.com/docs/webhook/OpportunityStageUpdate/index.html)
examples. Their `dateAdded` is not an update timestamp; the relay must supply a trustworthy
observation timestamp and stable delivery identity.

A trusted upstream receiver must authenticate the provider before relaying. Direct native
GHL signature verification, subscription registration and OAuth lifecycle are not implemented
here; follow GHL's [webhook integration guide](https://marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide/)
when building that separate boundary. Do not expose the relay token to browsers or accept
unverified public payloads upstream.

## Adding a handler

Implement `EventHandler` and register it explicitly in `src/events/handlers.ts`:

```ts
const handler: EventHandler = {
  id: 'estimate-review.v1',
  types: ['estimate.accepted'],
  async handle(tx, event, now) {
    // Query with event.organizationId and event.entity.id.
    // Persist a task, approval, or outbox intent using tx. No external I/O.
    await audit(
      tx,
      event.organizationId,
      'handler:estimate-review.v1',
      'estimate.review_requested',
      event.entity.id!,
      { eventId: event.id, at: now.toISOString() },
    );
  },
};
```

Use `EventPublisher.publishInTransaction` inside `tenantTransaction` for a domain mutation
plus event, or `new EventPublisher(db).publish(trustedSource, input)` for a standalone fact.
`input` is the canonical envelope's `version/type/entity/data/occurredAt` plus an
`idempotencyKey`, optional external/related references and correlation/causation/metadata;
it does not accept organization, actor, generated ID or source fields. Do not bypass the
CRM service to import customer changes.

Handler IDs are durable identities. Changing one can permit processing again on an
explicit replay; it does not automatically replay completed jobs. There is no bulk replay
endpoint in this increment. Known events without subscribers are retained and their jobs
complete without handler receipts. Unknown persisted event types fail for inspection.
`GET /api/workforce/event-deliveries?eventId=<uuid>` provides up to 100 tenant-scoped
receipts with `audit:read`; existing jobs/events/audit endpoints remain available.

## Compatibility and safe rollout

The existing v1 Zapier/generic endpoint and internal upsert endpoints remain supported.
New v1 imports now publish v2 canonical facts through a compatibility adapter; historical
payload hashes and duplicate IDs retain their previous meaning. Historical v1 rows are
not rewritten. At dispatch, `customer.upserted` becomes `contact.updated` and
`opportunity.upserted` becomes `opportunity.updated`, using the CRM migration's scoped
entity links. Provenance that was never recorded is labeled `legacy`, not invented.
Unresolvable historical subjects fail for inspection instead of being attributed to the
wrong entity. Legacy stale-input records remain unqueued and marked ignored in metadata.

V1 and v2 transport use different source namespaces. Move a relay to one endpoint at a
time; do not dual-feed the same business change through both protocols and expect their
delivery keys to deduplicate across namespaces.

Migration `20260908180000_universal_events` only adds metadata, two receipt tables,
indexes, constraints and a nullable connection account ID. It does not drop or rewrite
existing tables, events, credentials, CRM IDs or customer data. A transaction with a
five-second lock timeout fails rather than waiting indefinitely for production locks;
schedule index/FK creation appropriately for large ledgers.

Before deployment: take and verify a backup, rehearse on staging, pause workforce intake
and worker, deploy migrations and the matching generated Prisma client/application,
then enable intake and worker deliberately. Keep booking routes live. Do not run
`migrate reset`, `db push --accept-data-loss`, or test fixtures against production.
Roll back by disabling the new module/worker and retaining the additive schema; do not
drop the ledger. Older application code must not process already-created v2 jobs.

See [EVENT_VERIFICATION.md](EVENT_VERIFICATION.md) for local checks and remaining scope.
