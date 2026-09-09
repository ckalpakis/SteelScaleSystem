# Canonical Steel Scale CRM

Implemented September 8, 2026. This document describes the current CRM increment;
the earlier foundation is described in [ARCHITECTURE.md](ARCHITECTURE.md).

## Ownership and boundaries

Steel Scale owns UUID identities, contacts, companies, opportunities, estimates and
workflows. No industry, CRM provider, phone number, or legacy Client is required to
create an organization. Pipelines and custom fields express each business's terminology.
There are no roofing-specific fields, stages or business rules.

The existing Express 5 / strict TypeScript / Prisma 6 / PostgreSQL application is reused.
The UI is server-rendered HTML using the existing `adminLayout`, not a new SPA or framework.
The existing booking, prospecting, SMS and demo domains remain separate and operational.

```text
Bearer credential -> organization principal -> CRM service -> tenant-scoped repository
Operator Basic auth + signed form -> same CRM service       -> PostgreSQL transaction
                                                            ├─ domain + metadata changes
                                                            ├─ BusinessEvent + record links
                                                            ├─ durable WorkforceJob
                                                            └─ AuditLog
Optional webhook -> validated adapter -> ExternalRecordMapping -> same Contact/Opportunity
```

- `src/crm/validation.ts`: explicit resource/field allowlists and type validation.
- `repository.ts`: scoped entity persistence; controllers cannot provide Prisma query objects.
- `service.ts`: permissions, current credential checks, relationships, lifecycle and transactions.
- `custom-fields.ts`: typed values and required-field checks within the parent transaction.
- `events.ts`: audit, timeline links and transactional outbox; no network calls.
- `http.ts`: thin JSON transport; `admin.ts` / `views.ts`: operator forms and rendering.
- `src/workforce/crm/projector.ts`: compatibility adapter for the existing v1 import envelope.
  It is not a second CRM and does not own provider-neutral business rules.

## Models and relationships

Every organization-owned model has a required `organizationId`. `User` is the deliberate
exception: a global identity joins organizations through `OrganizationMember` and is exposed
only through the caller's memberships. Shared users cannot be edited globally through CRM.

| Model                             | Canonical purpose and relationships                                                                                                                                                                                               |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Organization                      | Tenant root; name, IANA timezone and default currency. Optional unique `legacyClientId` is a bridge, not required identity.                                                                                                       |
| User                              | Global identity with unique opaque `externalSubject`, optional profile name/email. No password, signup or login flow is implied.                                                                                                  |
| OrganizationMember                | User's role (`owner`, `admin`, `member`, `viewer`), active state and tenant-specific display name. Assignment target; `(organizationId,userId)` is unique. Legacy nullable `userId` remains temporarily compatible.               |
| CrmRecord                         | Same UUID as its concrete record; fixed entity type, organization, optimistic version, optional assigned member, archive and timestamps. Provides a constrained target for polymorphic attachments.                               |
| Contact                           | A person: display/first/last name, optional email/phone/company and sticky `doNotContact`. Multiple contacts can share a company. No provider ID required; no unsafe automatic email/phone merges.                                |
| Company                           | Optional customer business/account: name, domain, email and phone. Has many contacts and opportunities. Not the tenant itself.                                                                                                    |
| Opportunity                       | Commercial process: title, primary contact, optional company, pipeline/stage, amount/currency and last activity. `customerId` is the retained compatibility field name for the Contact UUID. Has many estimates and appointments. |
| Pipeline                          | Organization-defined name/description; many stages. No built-in required pipeline or industry template.                                                                                                                           |
| PipelineStage                     | Custom name, integer position and semantic outcome (`open`, `won`, `lost`). Unique position within a tenant's pipeline. Opportunity's composite FK verifies organization **and pipeline** match its stage.                        |
| Estimate                          | Number unique per organization, title, opportunity, status, amount/currency, issued/expiry/accepted timestamps. Multiple estimates per opportunity; acceptance is not payment evidence.                                           |
| Appointment                       | Contact, optional opportunity, title, start/end, timezone, location and status. Internal calendar record only; it does not claim external availability or make a legacy booking.                                                  |
| Task                              | Title/description, status, priority, due/completed times, optional related record; employee assignment lives on CrmRecord.                                                                                                        |
| Note                              | Body attached to a real tenant-owned CrmRecord. Updates create activity; no loose entity IDs.                                                                                                                                     |
| Conversation                      | Contact, subject, channel and open/closed state; contains messages. Separate from legacy SMS and demo sessions.                                                                                                                   |
| Message                           | Conversation, direction, body, occurrence time and recording/delivery state. CRUD records history or drafts; it never sends. Recorded messages are immutable through this API.                                                    |
| Tag / RecordTag                   | Organization-unique tag name/color; composite tenant FK join attaches tags to any supported concrete CRM record.                                                                                                                  |
| CustomFieldDefinition             | Entity type, stable key, label, typed value contract, required flag, selection options and archive state.                                                                                                                         |
| CustomFieldValue                  | One JSON value per definition/record; composite FKs enforce matching tenant, entity type and declared field type.                                                                                                                 |
| ExternalConnection                | Optional integration instance, provider slug, name and enabled state. Can have intake credentials and many record mappings. Provider slug is not a native identity.                                                               |
| ExternalRecordMapping             | Provider + connection + external record type/ID -> a real typed, tenant-owned CrmRecord. Multiple connections/CRMs may map to the same internal record.                                                                           |
| BusinessEvent / BusinessEventLink | Immutable-at-application-level business ledger and scoped links to affected records. Native mutations now generate canonical v2 facts plus jobs atomically; historical v1 rows remain unchanged.                                  |
| AuditLog                          | Actor, operation, subject, time and event reference. Application append-only; no CRUD edit/delete endpoints. Existing AI runs/actions/approvals/revenue remain linked to canonical opportunities.                                 |

Supported CrmRecord entity types: contact, company, opportunity, pipeline, pipeline_stage,
estimate, appointment, task, note, conversation, message, tag. SQL checks fix each concrete
table's type; insert/update triggers create its registry identity and maintain versions.
Registry-only records are not created by application services. All supported attachment
relationships point to this typed registry, not arbitrary UUID strings.

### Lifecycle and business rules

- Native opportunity creation requires a valid contact, pipeline and stage. Stage outcome
  derives opportunity status. Renaming a stage is safe; changing the outcome of an in-use
  stage is rejected. Moving an opportunity can select any same-tenant pipeline/stage pair.
- Imported legacy opportunities retain their original status and nullable pipeline/stage.
  A native update of such an opportunity must choose a pipeline/stage. `estimate_sent`
  remains a compatibility status, not an organization-defined stage name.
- Stage order changes require the complete active stage ID set and pipeline version.
  The transaction uses temporary positions to avoid unique-index collisions. Maximum
  100 total stages per pipeline, including archived stages, in this initial implementation.
- Money is a nonnegative 32-bit integer in currency minor units plus a three-letter
  currency. Currency is immutable on existing opportunities/estimates; estimates must
  match their opportunity. Never sum unlike currencies or treat an estimate as revenue.
- Appointment times must be valid timezone-qualified timestamps with end after start.
  Its optional opportunity must belong to its contact. Booking delivery is not triggered.
- Contact suppression cannot be cleared by CRUD or imports; a consent workflow is deferred.
- DELETE of a concrete CRM record means **archive**, not physical deletion. Reads exclude
  archived records. Active business dependents prevent parent archival. History, mappings,
  notes and field values remain stored. Recovery evaluation and approvals reject archives.
- Recorded messages cannot be edited/archived; draft messages can. The API does not permit
  callers to claim `sent`/`delivered` status. Delivery receipts need a future trusted adapter.
- Employee profiles are assignment records, not invitations. Creating one does not issue
  login credentials or send email. Owners/admins manage profiles; only owners grant elevated
  roles, and the last active owner cannot be demoted/deactivated.

## Tenant isolation and security

1. Machine requests derive tenant and actor from a hashed bearer credential, never an
   `organizationId` body/query/header. Unknown body fields are rejected. Active membership,
   expiration/revocation, role and scopes are checked; credentials are rechecked under the
   tenant lock to prevent queued requests from using revoked access.
2. `CrmRepository` requires organization context at construction. Every read/update/archive
   and reference lookup includes that organization. The dynamic Prisma delegate is a
   fixed resource allowlist; arbitrary filters/includes are not accepted.
3. PostgreSQL composite foreign keys include organization on all tenant relationships,
   including assignment, stage membership, tags, custom values, mappings and event links.
   Tests deliberately bypass the service to verify the database rejects foreign-tenant FKs.
4. Mutations and supporting lookups execute within the existing tenant transaction/row lock.
   Optimistic `expectedVersion` prevents lost UI/API updates. Domain, metadata, event, job
   and audit writes commit or roll back together. No providers are called inside transactions.
5. Operator UI is intentionally platform-wide Basic-auth administration. Organization
   selection is authorized by that platform privilege, then all record operations use the
   scoped service. It is **not** a customer login portal. Mutations require expiring,
   authorization- and path-bound signed CSRF tokens. HTML is escaped; CSP and no-store apply.
6. CRM routes precede generic request logging; private Prisma failures are redacted. Audit
   and event payloads still contain business data and require restricted database access.

PostgreSQL RLS is not enabled in this shared legacy deployment. Composite FKs protect
relationships, not arbitrary unscoped SELECTs by privileged SQL users. The service/repository
boundary and integration tests enforce request isolation; direct database credentials remain
privileged. Do not expose raw Prisma to controllers or treat frontend filtering as security.
Separate least-privilege DB roles/RLS are a follow-on hardening step, not a claimed feature.

## External identity and synchronization

Unique external identity is `(organizationId, connectionId, externalRecordType, externalId)`.
`provider` is constrained to the connection's provider by a composite FK; the target's
`internalEntityType` is constrained to the actual internal record type. A second Jobber
account can reuse the same external ID without a collision. Repeating an identical mapping
is idempotent; silently remapping an identity to another internal record is rejected (409).
Mappings are immutable; an explicit audited unlink followed by mapping is required.

Examples: `ghl/opportunity/123 -> Opportunity UUID`, `jobber/estimate/456 -> Estimate UUID`,
`zapier/record/789 -> Opportunity UUID`. Storing these mappings does not install a provider
adapter. Existing Zapier/generic intake still accepts only the documented v1 contact and
opportunity events. The subsequent [universal event increment](EVENT_ARCHITECTURE.md) adds
normalized estimate/message/lifecycle intake and an authenticated GHL opportunity relay.
Native public vendor signature receivers and OAuth setup are not implemented.

V1 `customer.upserted` uses external record type `customer`, internal type `contact`.
`opportunity.upserted` uses `opportunity`. Create the contact mapping first within the same
connection. Its `customerExternalId` resolves that mapping, not a native primary key.
Webhooks update the mapped canonical row; they do not create a parallel CRM record.
Watermarks reject stale source observations; native contact/opportunity changes advance
the local barrier. Same-opportunity contact/currency changes are rejected. Pipeline-backed
imports reconcile won/lost/open to a matching active stage or return a conflict if none exists.

Legacy `source`, `externalId`, `sourceOccurredAt` columns are nullable provenance retained
for older API responses and uniqueness protection. They are not accepted by native CRUD.
Unlinking a legacy-import mapping does not erase that provenance; reimporting its old identity
may conflict rather than silently duplicate it. Explicit merge/reconciliation is future work.
Multiple-source deduplication and field-level conflict resolution are deliberately not inferred.

## Custom fields

Types: text, finite number, boolean, actual calendar date (`YYYY-MM-DD`), single_select and
multi_select. Selection values must be in a definition's options; duplicates are rejected.
API values are keyed by **definition UUID**, not by arbitrary JSON keys. Basic JSON type is
also checked in SQL; option/date/required validation is the service's responsibility.

Definitions are unique per organization/entity/key. Key, type, options and required behavior
are immutable once created; label and archived status are editable. Changing a contract needs
an explicit future conversion workflow. Archival hides definitions but preserves historical
values. Required fields are enforced on new native records and cannot be explicitly cleared.
Adding a required definition does not retroactively invalidate existing/imported records.
Optional `null` removes a value. Maximum 100 active definitions per type / 100 supplied values.
Imports currently do not populate custom fields or enforce newly-required native fields.

## Safe migration and rollout

`20260908150000_canonical_crm` adds 17 tables and supporting enums/indexes/constraints, expands
the existing workforce schema and backfills identities. No legacy table is deleted or renamed.
Prisma names are canonical while SQL names are retained with `@@map`:

| Prisma model       | Existing SQL table     |
| ------------------ | ---------------------- |
| OrganizationMember | OrganizationMembership |
| Contact            | WorkforceCustomer      |
| Opportunity        | WorkforceOpportunity   |
| ExternalConnection | WorkforceIntegration   |
| BusinessEvent      | WorkforceEvent         |
| AuditLog           | WorkforceAudit         |

Existing contact/opportunity IDs, timestamps, amounts, suppression and statuses remain intact.
Users are backfilled by membership subject; registry rows use the original entity IDs.
Mappings reuse real integration IDs or deterministic synthetic legacy-source connections.
Existing events receive scoped timeline links. Provider enum values are cast to text **in
place**, not dropped/re-added. All existing foundation action/approval/revenue FKs still work.
Legacy Client, booking, prospecting, telephony and demo records are not imported or rewritten.

Before Railway rollout:

1. Back up and verify restore on a staging clone; rehearse migration and compare counts,
   identities, mappings and legacy workflows. Review existing migration drift separately.
2. Keep `CRM_ENABLED=false`; disable workforce intake and stop/drain workforce workers while
   upgrading that domain. Leave legacy booking routes operational. This is not a promise of
   zero-downtime DDL: indexes, enum conversion and backfills can lock tables. The migration is
   transactional with a 5-second lock acquisition timeout; schedule an appropriate window.
3. Apply committed migrations with `npm run prisma:deploy`, generate/build the matching code,
   then verify API/admin smoke tests before enabling `WORKFORCE_ENABLED=true` and `CRM_ENABLED=true`.
4. Enable a separate workforce worker only when ready to process the queued business events.
   Nothing in CRM directly sends a message or requires GHL. Both flags remain false by default.
5. Roll back exposure by disabling the flags; preserve the additive schema and data. Do not
   run a destructive down migration or blindly roll back to an old Prisma binary after native
   records exist: old clients assume non-null external IDs and the old provider enum.

Use migrations, **not `prisma db push`**, to provision databases: Prisma schema alone cannot
express the identity/version triggers and CHECK constraints. The upgrade test refuses a
nonempty target and never resets a database. See [CRM_VERIFICATION.md](CRM_VERIFICATION.md).

## Scope and next increment

The initial operator UI supports Contacts, Opportunities, Pipeline, pipeline/stage settings,
contact/opportunity details, notes, assignments and existing custom-field inputs. Other models
have validated APIs; dedicated calendar/inbox/task/settings pages are not built. List endpoints
page in batches of 100; the initial board, detail activity and selection lists are bounded at
100, not complete analytics or an unlimited customer-picker experience.

Next: add verified customer identity and organization-aware sessions/invitations, then expose
this CRM through a customer portal with approval/handoff review and scalable searchable pickers.
Subsequent increments can add estimate line items, actual delivery/receipts, calendar conflict
handling, consent/retention workflows and reviewed CRM-to-CRM synchronization. This foundation
does not claim healthcare/legal compliance or authorize storing regulated secrets/PHI.
