# CRM API and member/operator UI

Organization members can open `/workspace/crm/contacts` using their member API
credential as the Basic-auth password. The organization is resolved from that
credential, not a URL parameter. `/admin/crm` remains platform-operator-only. Both
interfaces reuse the same CRM service, validation and signed-form protections.
The member UI hides write actions for viewers and pipeline/stage administration
for non-admins; forged writes are still rejected server-side. See the
[business workspace guide](PRODUCT_WORKSPACE.md) for onboarding and reporting.

CRM mutations now publish canonical v2 events, including correlated stage/status/message
lifecycle facts. Activity timelines can contain both a base update and its specific fact.
See [event architecture](EVENT_ARCHITECTURE.md) for schemas and retry guarantees.

Base: `/api/workforce/crm`. Requires `WORKFORCE_ENABLED=true` **and** `CRM_ENABLED=true`.
Uses the existing workforce hashed bearer credential. Provision an organization through
the operator-only endpoint documented in [WORKFORCE_API.md](WORKFORCE_API.md).
Never put credentials in URLs; use HTTPS. No organization ID is accepted in CRUD bodies.
Browser Origin requests are rejected here; the signed-form operator UI is separate.

`crm:read` permits reads; `crm:write` permits changes for non-viewers. Pipeline, stage,
tag, custom-field, connection, mapping and employee management require owner/admin role.
Integration credentials remain event-intake-only. They do not gain CRM read access.

## Concrete resources

Resources: `contacts`, `companies`, `opportunities`, `pipelines`, `stages`, `estimates`,
`appointments`, `tasks`, `notes`, `conversations`, `messages`, `tags`.

| Method/path                   | Behavior                                                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /:resource`              | Up to 100 active records, ID ascending. Optional `after` UUID and `search` (100 chars). Stages/opportunities accept `pipelineId`; opportunities also accept `stageId`. |
| `POST /:resource`             | Validate and create; returns 201 with domain fields and `record` metadata.                                                                                             |
| `GET /:resource/:id`          | `{entity, customFields, tags, activity, opportunities}`. `opportunities` is populated for contact details. Up to 100 activity events / associated opportunities.       |
| `PATCH /:resource/:id`        | Partial update; required `expectedVersion` from `entity.record.version`. Returns updated entity with new version.                                                      |
| `DELETE /:resource/:id`       | Body `{expectedVersion}`; soft archive, returns 204. Active dependents can block archival.                                                                             |
| `POST /pipelines/:id/reorder` | `{expectedVersion, stageIds: [all active stage IDs in order]}`. Returns stage records; order by `position` to display.                                                 |

Common optional write fields: `assignedMemberId` (active membership UUID or null), `tagIds`
(replace attachments, max 30), `customFields` (definition UUID -> typed value, max 100).
On update omission preserves metadata; `tagIds: []` clears tags; `null` clears an optional
custom value or assignment. Every entity has `record.version`, `archivedAt`, assignment,
organization and fixed type. Do not pass `id`, `organizationId`, `source`, `externalId`,
`entityType` or raw Prisma input. Unknown fields are rejected.

### Create inputs

| Resource      | Required fields                                                           | Selected optional fields/defaults                                                                                   |
| ------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| contacts      | `name`                                                                    | firstName, lastName, email, phone (international + format), companyId, doNotContact                                 |
| companies     | `name`                                                                    | domain, email, phone                                                                                                |
| pipelines     | `name`                                                                    | description                                                                                                         |
| stages        | `name`, `pipelineId`, `position`                                          | outcome: open (default), won, lost                                                                                  |
| opportunities | `title`, `customerId`, `pipelineId`, `stageId`, `amountMinor`, `currency` | companyId, lastActivityAt; status derived from stage                                                                |
| estimates     | `number`, `title`, `opportunityId`, `amountMinor`, `currency`             | status: draft/sent/accepted/declined/expired; issuedAt, expiresAt, acceptedAt                                       |
| appointments  | `title`, `contactId`, `startsAt`, `endsAt`, `timezone`                    | opportunityId, location, status: scheduled/completed/cancelled/no_show                                              |
| tasks         | `title`                                                                   | description, status: open/in_progress/completed/cancelled, priority: low/normal/high/urgent, dueAt, relatedRecordId |
| notes         | `body`, `relatedRecordId`                                                 | common metadata                                                                                                     |
| conversations | `subject`, `contactId`, `channel`                                         | channel: email/sms/phone/web/other; status: open/closed                                                             |
| messages      | `conversationId`, `direction`, `body`, `occurredAt`                       | direction: inbound/outbound/internal; status: recorded (default) or draft; **no sends**                             |
| tags          | `name`                                                                    | color: six-digit hex, default #526174                                                                               |

Short fields max 250 chars; notes/messages/descriptions max 10,000. Timestamps must
include timezone; IANA timezone names are validated. Monetary values are nonnegative
integer minor units up to 2,147,483,647. See [CANONICAL_DATA_MODEL.md](CANONICAL_DATA_MODEL.md)
for immutable identities, suppression, stage, appointment and estimate rules.

### Example sequence

POST `/pipelines`:

```json
{ "name": "Service engagements" }
```

POST `/stages` using its returned UUID:

```json
{
  "name": "Consultation requested",
  "pipelineId": "<pipeline UUID>",
  "position": 0,
  "outcome": "open"
}
```

POST `/contacts`:

```json
{ "name": "Alex Example", "email": "alex@example.test" }
```

POST `/opportunities`:

```json
{
  "title": "Annual service agreement",
  "customerId": "<contact UUID>",
  "pipelineId": "<pipeline UUID>",
  "stageId": "<stage UUID>",
  "amountMinor": 240000,
  "currency": "USD"
}
```

PATCH `/opportunities/<UUID>` moves stages:

```json
{ "expectedVersion": 1, "stageId": "<another stage UUID in that pipeline>" }
```

Native events contain `{subjectId, changes}` with type such as `contact.created`,
`opportunity.updated`, `note.created`, `pipeline.reordered`; their source is `steel_scale_crm`.
These internal events differ from the v1 external import envelope's `{data: ...}` payload.
Both persist as BusinessEvent v1 with source-qualified deduplication and transactionally queued
jobs. Native opportunity create/update events are understood by the existing recovery runtime.

## Organization, assignment and configuration

| Method/path                     | Input / behavior                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /organization`             | Current organization only.                                                                                                                                    |
| `PATCH /organization`           | name, timezone, defaultCurrency; no identity/delete operations.                                                                                               |
| `GET /members`, `GET /users`    | Current organization's member/profile data, max 100. No global user search.                                                                                   |
| `POST /members`                 | `{name, email?, role?: "member" or "viewer"}`; assignment profile, **not login/invitation**.                                                                  |
| `PATCH /members/:id`            | displayName, active, role. Elevated grants require owner; last active owner is protected.                                                                     |
| `DELETE /members/:id`           | `{}`; deactivate while preserving history and assignments.                                                                                                    |
| `GET /custom-fields`            | Active definitions, max 1,000 across types.                                                                                                                   |
| `POST /custom-fields`           | entityType, key, label, fieldType, required?, options?.                                                                                                       |
| `PATCH /custom-fields/:id`      | label and/or archived boolean only.                                                                                                                           |
| `DELETE /custom-fields/:id`     | `{}`; archive definition, preserve values.                                                                                                                    |
| `GET /connections`              | Connection descriptors, max 100; no provider secrets.                                                                                                         |
| `POST /connections`             | `{name, provider}`; provider is lowercase slug such as jobber, ghl or zapier. Does not connect remotely or issue a token.                                     |
| `PATCH /connections/:id`        | name and/or enabled. Provider is immutable.                                                                                                                   |
| `DELETE /connections/:id`       | `{}`; disable, retain mappings/history.                                                                                                                       |
| `GET /external-mappings`        | Max 100, optional `after` UUID.                                                                                                                               |
| `POST /external-mappings`       | connectionId, externalRecordType, externalId, internalEntityType, internalEntityId. Provider derived from connection; repeat identical mapping is idempotent. |
| `DELETE /external-mappings/:id` | `{}`; explicit audited unlink, not deletion of the underlying record.                                                                                         |

Example custom definition and value (separate requests):

```json
{
  "entityType": "contact",
  "key": "service_segment",
  "label": "Service segment",
  "fieldType": "single_select",
  "required": true,
  "options": ["Residential", "Commercial"]
}
```

```json
{ "name": "Alex Example", "customFields": { "<definition UUID>": "Commercial" } }
```

To use the already supported Zapier/generic webhook adapters, provision through
`POST /api/workforce/integrations` (returns the connection and an intake credential),
then `POST /api/workforce/webhooks/:integrationId` using that credential. A native
ExternalConnection descriptor for another provider does not by itself implement its adapter.
V1 contact intake mappings use `externalRecordType: "customer"`, `internalEntityType: "contact"`.
Never replace internal IDs with external IDs.

`GET /api/workforce/events` and `/audit` remain the scoped history APIs. No edit/delete
endpoints exist for BusinessEvent or AuditLog. They are written by application operations.

## Errors and concurrency

Errors use `{error: "stable_code"}`: 400 invalid/unknown input, 401 missing/expired/changed
credential, 403 insufficient scope/role or rejected browser origin, 404 unavailable/foreign
record, 409 version/relation/identity conflict, 413 oversized body. Bodies are limited to 32 KB.
Conflict examples: `record_version_conflict`, `stage_pipeline_mismatch`,
`record_has_active_dependents`, `external_mapping_conflict`, `consent_workflow_required`.
Failed transactions do not leave partial records, values, events or jobs. On a version
conflict reload and review; do not blindly replay an edit with a newer version.

## Operator interface

`/admin/crm` uses existing `ADMIN_USERNAME` / `ADMIN_PASSWORD`. Choose an organization,
then Contacts, Opportunities, Pipeline or Pipeline settings. Create pipelines/stages before
native opportunities. Details support edit, assignment, existing custom values, notes,
associated records and a linked activity timeline. Stage moves use the opportunity form;
drag-and-drop is not implemented. All record forms include signed CSRF and optimistic versions.

This is privileged internal administration, not a customer-facing multi-tenant login UI.
Other models have API CRUD but not dedicated screens yet. The first UI has bounded
100-record selectors/boards and is intended for a small pilot; use paginated APIs for
larger workspaces until searchable relationship pickers and timeline pagination are added.
