# Natural-language Agent Builder

Implemented September 8, 2026. This is an opt-in authoring layer over the existing
[Agent Runtime](AGENT_RUNTIME.md), not a second executor. It works with canonical Steel Scale
records and events across service industries; no GHL connection is required.

## Owner workflow

1. Open `/agent-builder` with an organization owner/admin member credential.
2. Describe the work and boundaries. **Generate blueprint** asks the configured model for a
   strict structured proposal. With AI drafting disabled, **Start empty draft** still works.
3. Review the original request alongside editable objective, trigger, eligibility, actions,
   prohibitions, escalation, cadence, channels, goals, stop conditions, hours and knowledge.
4. Resolve missing configuration. Use the empty rows to add conditions, escalation rules and
   knowledge; save to get another empty row. Remove checkboxes remove items in the next version.
5. **Save Draft** creates an immutable configuration snapshot. History shows changed fields
   and lets the owner inspect earlier snapshots read-only.
6. **Test Agent** evaluates a fictional record against the saved configuration's existing
   eligibility and policy functions. It stores a test report, not a real run.
7. Explicitly review the saved version and **Activate Agent**. Activation revalidates and
   creates/enables a version through the existing runtime service in one transaction.

Unsaved edits disable testing/activation in the browser. Server-side version/hash checks
remain authoritative when JavaScript is absent or requests are forged. Saving a new draft
does not change an already active agent. A second activation of the same snapshot returns
its existing activation; it does not re-enable an agent subsequently disabled elsewhere.
Create/review another draft version or use the runtime's existing enable control as appropriate.

## Contract and domain boundaries

`src/agent-builder/blueprint.ts` owns `AgentBlueprint` schema version 1, its closed JSON Schema,
and matching local validation. All properties are required; unknown information is explicitly
`null` or a missing-configuration question, not an inferred permission. Unknown properties,
unregistered values, oversized strings/lists, invalid timezones and malformed numbers fail.

| Structured item         | Representation                                                                  |
| ----------------------- | ------------------------------------------------------------------------------- |
| Objective/context/style | Reviewed bounded text, separate from original request                           |
| Trigger/entity types    | Canonical event name and internal entity types                                  |
| Conditions              | Typed field/operator/value; AND semantics, explicit status alternatives         |
| Delay/cadence           | Minutes, enabled choice, interval and maximum action proposals                  |
| Permissions             | Allowed, prohibited and explicitly automatic action sets                        |
| Escalation              | Condition, route, optional organization-member ID                               |
| Channels                | Explicit channel list                                                           |
| Goal/stops              | Typed criterion with description and explicit stop conditions                   |
| Hours                   | IANA timezone, weekdays and hour window                                         |
| Knowledge               | Named requirement, content and human verification flag                          |
| Readiness               | Missing questions and unmapped requests, plus independent compiler requirements |

Amounts use integer minor units in the API. The form displays major units with at most two
decimal places and converts exactly; currency must be confirmed separately. Multiple status
clauses are not silently converted into a broader OR condition.

- `extractor.ts`: provider abstraction and OpenAI drafting adapter; never executes tools.
- `compiler.ts`: deterministic, fail-closed mapping to `agents/contracts.ts` and policy preview.
- `service.ts`: scoped persistence, idempotent generation, tests and atomic reviewed activation.
- `http.ts`: JSON transport, authentication, limits and redacted errors.
- `form.ts` / `admin.ts`: server-rendered editable presentation using the existing admin shell.
- Runtime service transaction helpers: shared version creation/projections; the existing
  worker, context loader, policy, registered tools and approvals remain the only execution path.

## Example: faithful extraction, not unsafe activation

For “Follow up with any estimate over $2,500 that hasn't been accepted within two days…
Do not offer discounts…notify the assigned salesperson” the proposal can preserve:

```json
{
  "triggerEvent": "estimate.sent",
  "eligibleEntityTypes": ["estimate"],
  "triggerConditions": [
    { "field": "amount_minor", "operator": "gt", "number": 250000, "value": null, "values": [] },
    { "field": "status", "operator": "neq", "number": null, "value": "accepted", "values": [] }
  ],
  "delayMinutes": 2880,
  "prohibitedActions": ["offer_discount"],
  "escalationRules": [
    { "condition": "pricing_negotiation", "route": "assigned_salesperson", "memberId": null }
  ]
}
```

This is an illustrative **partial** blueprint, not a complete POST body. Currency, channels,
cadence, maximum attempts, hours, approval mode and approved knowledge still need confirmation.
Extraction is a proposal, not proof the model captured every sentence; review is mandatory.

**This particular workflow cannot yet be activated.** The existing runtime does not implement
amount eligibility, delayed event re-evaluation, fixed follow-up cadence, pricing-content
guards/detection, automatic salesperson routing or a recovered-estimate goal evaluator.
Message/calendar delivery adapters are also unavailable. These are visible capability
requirements; they are not approximated using a giant prompt, ignored, or mapped to a
different business process. “No discounts” cannot be treated as enforced merely because the
model saw those words. Deleting the model's missing-question list does not bypass independent
checks on the remaining structured requirements.

Activation currently supports immediate canonical triggers, internal entity selection, one
status equality/list predicate, opportunity inactivity in days, supported internal tools,
runtime goal types and existing review escalation conditions. Only the explicit action-budget
stop maps exactly; custom automatic stop semantics stay blocked. A complete internal intake
helper that proposes staff tasks in COPILOT is an example of a supported configuration.

Compiled defaults are conservative caps: 5 steps, at most 3 actions (or the lower requested
limit), 300 seconds, 20 runs/day, 1,024 output tokens, no repeated follow-ups, and no contact
details/message bodies in model context. Operating hours and permissions must be selected.
AUTOPILOT requires explicit automatic permissions; COPILOT and ADVISORY retain their existing
runtime semantics. The business cannot choose a model outside the deployment allowlist.

## Test Agent scope

Test Agent is a **configuration/eligibility/policy preview**, not an LLM conversation simulation,
deliverability check or promise of business results. It never calls a model, reads real customer
data, creates `AgentRun`s, executes tools, sends messages or books appointments. It writes only
the blueprint test receipt and audit record. Reports include eligibility, hypothetical tool
policy outcomes and compiler/configuration hashes. A compilable saved-version test is required
for activation; the fixture does not need to be eligible (testing exclusions is legitimate).
Human approval and real-context checks still happen for every live runtime action.

## Persistence, concurrency and tenant isolation

Additive migration `20260909010000_agent_blueprints` introduces:

- `AgentBlueprint`: organization-owned identity, current draft pointer and optional runtime agent.
- `AgentBlueprintVersion`: immutable specification/hash, original source text, model provenance,
  author/time, plus write-once activation metadata and exact runtime-version link.
- `AgentBlueprintTest`: exact version/hash/compiler-bound fictional scenario and report.
- `AgentBlueprintGeneration`: request-key/hash reservation and completed/failed receipt.

Composite organization foreign keys prevent cross-tenant identity/version/test/agent links.
Every service operation uses the existing organization-locked transaction and rechecks active
credential, membership and `agents:write` owner/admin authorization. Neither the request body
nor model output can select the organization. Generation performs network I/O outside the
transaction, then rechecks authorization and expected version before saving its result.

Generation keys are unique per organization. Concurrent duplicates reserve one attempt;
completed duplicates return the same version; changed payloads conflict. Failed/abandoned keys
are terminal and require a new request key. Network calls have a 30-second timeout and no
automatic retry. An abandoned reservation older than 60 seconds is marked failed on retry.
Limits: 20 attempted generations/rolling 24 hours/organization, 50 blueprints, 100 versions per
blueprint and 100 tests per version, in addition to shared peer and persistent organization
rate limits. These counts are serialized by the existing tenant lock.

Activation checks `reviewed: true`, current draft number, specification hash, expected current
runtime version and a matching compiler/definition-hash test. Draft and activation writes
are atomic with audit. Existing event idempotency and runtime action receipts remain in force.
No historical event replay or automatic run is created by saving, testing or activating.
After activation, the existing event worker can admit pending notifications that match the
agent's trigger. Inspect queued events before enabling workers; activation is not an event-time
cutoff or a replay fence.

## AI transport and privacy

The builder uses the existing Responses REST transport, extracted into a reusable bounded
helper. It uses `text.format` with strict JSON Schema, closed objects and required nullable
fields; refusals, incomplete responses and unexpected native tool calls fail closed.
See the official [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs).

The owner's description is user data in an extraction request, never the production system
prompt. Extraction has no tools or customer context. Local validation follows schema output;
the service clears model-proposed automatic permissions, knowledge approvals and runtime-model
selection. Only reviewed structured fields compile into the runtime definition. Approved
knowledge remains untrusted with respect to authorization: model text cannot override policy.

Original descriptions and reviewed knowledge are stored in tenant-protected version snapshots
because owners need to compare changes. Avoid entering secrets, customer identifiers or medical/
legal case details. Generation uses `store: false`; this is not a promise of zero provider
retention. Provider account/data controls still apply. Raw provider errors/responses and hidden
reasoning are not stored. Audit stores hashes/change field names, not source text. There is no
automatic retention/deletion job yet; define an organization data-retention policy before broad
rollout. Version immutability is enforced by the application, not a database superuser barrier.

## API and authentication

All JSON endpoints are under `/api/agent-blueprints`, with `Authorization: Bearer <member-key>`.
They reject browser Origin headers; writes require JSON (64 KiB maximum). Integration-only
credentials and ordinary/viewer memberships cannot author agents.

| Method/path          | Body                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| GET `/`              | List this organization's blueprints                                                                                             |
| POST `/`             | `{ "specification": <complete AgentBlueprint> }`                                                                                |
| POST `/generate`     | `{ "description": "…", "requestKey": "…", "blueprintId"?: "…", "expectedVersion"?: 1 }`                                         |
| GET `/:id?version=1` | Current draft or historical detail, requirements, tests and history                                                             |
| POST `/:id/versions` | `{ "specification": <complete AgentBlueprint>, "expectedVersion": 1 }`                                                          |
| POST `/:id/test`     | `{ "expectedVersion": 1, "scenario": { "entityType": "contact", "status": "active", "inactiveDays": 0, "suppressed": false } }` |
| POST `/:id/activate` | `{ "expectedVersion": 1, "specificationHash": "…", "expectedAgentVersion": 0, "reviewed": true }`                               |

The UI follows the existing Integrations member-credential authentication bridge: Basic username
`organization`, password the member API key, over HTTPS only. It does not grant access through
the global operator/admin password and does not store a key in browser localStorage. Forms use
action-bound signed CSRF tokens and restrictive CSP; responses are no-store. A proper member
session/SSO portal is still a separate platform increment.

Errors are safe codes: 400 invalid/review missing, 401/403 authentication/authorization,
404 out-of-tenant/not found, 409 stale revision/unresolved requirements/test required,
429 limits, and 502/503/504 provider failure/disabled/timeout. GET detail gives the actionable
requirements list after a 409; no provider secrets are returned.

## Rollout and next step

All flags remain disabled in `.env.example`; the real `.env` and Railway deployment were not changed.

```dotenv
WORKFORCE_ENABLED=true
AGENT_RUNTIME_ENABLED=true
AGENT_BUILDER_ENABLED=true
AGENT_BUILDER_AI_ENABLED=false
AGENT_BUILDER_MODEL=
AGENT_ALLOWED_MODELS=
AGENT_MODEL_ENABLED=false
```

First apply migrations to a backed-up staging database and enable manual authoring. To enable
paid drafting, an operator must explicitly set `AGENT_BUILDER_AI_ENABLED=true`, a tested
Structured-Outputs-compatible `AGENT_BUILDER_MODEL`, its `AGENT_ALLOWED_MODELS` entry and server
`OPENAI_API_KEY`. Paid runtime execution has its own `AGENT_MODEL_ENABLED` gate and worker
rollout. Do not mistake enabling drafting for authorizing live customer actions.

Next: add typed amount/currency eligibility and durable delayed-trigger re-evaluation in the
existing runtime, with boundary/tenant/deduplication tests, then extend this compiler's supported
mapping. Consent-aware delivery, pricing guards, escalation routing and cadence need their own
tested runtime capabilities before enabling the full recovery example.

See [verification and known failures](AGENT_BUILDER_VERIFICATION.md).
