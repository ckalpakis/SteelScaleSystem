# Universal AI agent runtime

Business Knowledge adds the explicitly permitted `get_business_knowledge` read tool
(`input.text` query, no target ID). Results cite organization-approved public versions and
grant no permissions. With BUSINESS_KNOWLEDGE_ENABLED, knowledgeRevision participates in
context fingerprinting so stale decisions/approvals fail closed after knowledge changes.
See [BUSINESS_KNOWLEDGE.md](BUSINESS_KNOWLEDGE.md) for retrieval and execution boundaries.

Steel Scale agents are versioned configurations evaluated by a bounded worker. A model
proposes one structured decision; it does not authorize actions, access Prisma, select an
application function, or call a CRM/SMS/calendar vendor. No existing recovery, booking,
GHL, CRM or Zapier workflow is replaced by this increment.

## Boundaries and migration

`src/agents/` contains the new runtime:

| Module                      | Responsibility                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| `contracts.ts`              | Closed definition, decision and tool-name contracts; local validation.                   |
| `service.ts`                | Organization-admin management, immutable version creation, run admission and scheduling. |
| `context.ts`                | Bounded, tenant-scoped CRM context and deterministic eligibility.                        |
| `provider.ts`               | Model interface and opt-in OpenAI Responses adapter; no application tool execution.      |
| `policy.ts`                 | Server-side permissions, execution modes, suppression, channels, hours and budgets.      |
| `tools.ts`                  | Explicit registry, action-specific arguments and native CRM operations.                  |
| `runtime.ts`                | Leased, resumable, bounded execution journal and transactional effects.                  |
| `approvals.ts`              | Exact-action approval, rejection, expiry and current-state revalidation.                 |
| `events.ts`, `scheduler.ts` | Canonical event subscriptions and durable scheduled run admission.                       |
| `facts.ts`                  | Canonical completion facts for committed internal actions.                               |
| `http.ts`                   | Thin authenticated API; safe errors and request limits.                                  |

The logical **Agent** reuses the existing Prisma `WorkforceAgent` identity with
`kind: "universal"`. Existing `kind: "revenue_recovery"` rows retain their original
configuration, deterministic evaluator, handoff tool, approvals and attribution.
Universal definitions live in `AgentVersion`, not the old recovery `config` JSON.

New execution journals are intentional: legacy `WorkforceAction` requires an opportunity
and supports only recovery handoffs. Making those existing constraints nullable would
weaken the production recovery model. Universal runs/actions instead use the canonical
`CrmRecord` subject registry. A later explicit migration can consolidate historical views
without reinterpreting old decisions.

Migration `20260908230000_agent_runtime` adds tables, indices, tenant foreign keys and
state/budget constraints. It does not rename/drop existing tables, backfill AI runs, alter
legacy agent configuration or replay events. Unrelated pre-existing database/schema drift
was excluded from the generated migration. All 25 migrations and a populated synthetic
legacy-data upgrade were rehearsed on disposable local PostgreSQL.

## Persistence model

| Entity                   | Meaning                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Agent (`WorkforceAgent`) | Stable organization-owned identity; enabled flag and current version number.                                  |
| `AgentVersion`           | Append-only through the service: full validated definition, hash, author, number and timestamp.               |
| `AgentGoal`              | Objective and typed success criterion for that version.                                                       |
| `AgentTrigger`           | Canonical event subscriptions for that version.                                                               |
| `AgentPolicy`            | Read-only policy projection of the version.                                                                   |
| `AgentToolPermission`    | Explicit tool allowlist and automatic-execution opt-in.                                                       |
| `AgentEscalationRule`    | Conditions that mark a stopped result for human review.                                                       |
| `AgentRun`               | Pinned version, internal subject, trigger, source event, correlation ID, limits, lease and lifecycle.         |
| `AgentStep`              | Exact projected context, decision summary, requested tool/input, policy result, receipt/error and timestamps. |
| `AgentAction`            | Immutable proposal/input, fingerprint, deduplication key, disposition and committed result.                   |
| `HumanApproval`          | One decision for one exact action; actor, reason, expiry and timestamps.                                      |
| `AgentSchedule`          | Subject-bound, finite, one-shot or interval schedule.                                                         |
| `AgentResult`            | Final disposition, summary, execution evidence and server-evaluated criterion.                                |

Every new entity has `organizationId`. Foreign keys to versions, agents, runs, approvals,
events and CRM records include the organization. Services acquire the existing organization
row lock for database mutations and query with explicit tenant scope. Authorization is
checked again after that lock. Model-facing tools can access only records in the run's
bounded context, not arbitrary records even within the same organization.

No general model-writable long-term memory is added. `AgentStep.context` is the per-step
context snapshot; CRM records remain business truth. This avoids creating an unaudited
second CRM or persisting unverified model assertions as customer facts. Version child
tables are derived in the same creation transaction and have no independent update API.
Direct SQL access remains privileged; this is not PostgreSQL RLS or cryptographic
protection against a database administrator.

## Structured definition

The following is an industry-neutral task-triage example. Replace `YOUR_REVIEWED_MODEL_ID`
with a model configured in the operator allowlist. It starts disabled after creation.

```json
{
  "version": 1,
  "name": "Service request triage",
  "description": "Review new requests and propose a staff task.",
  "objective": "Give the team a clear next step for each eligible request.",
  "businessContext": "We provide professional services using the Steel Scale CRM.",
  "communicationStyle": "Concise, factual and professional.",
  "mode": "COPILOT",
  "model": { "provider": "openai", "model": "YOUR_REVIEWED_MODEL_ID" },
  "triggers": ["contact.created"],
  "eligibility": {
    "entityTypes": ["contact"],
    "statuses": [],
    "staleAfterDays": 0
  },
  "permissions": [
    { "tool": "get_contact", "automatic": true },
    { "tool": "create_task", "automatic": false },
    { "tool": "request_human_approval", "automatic": false },
    { "tool": "stop_agent_run", "automatic": true }
  ],
  "restrictedActions": ["send_message", "book_appointment"],
  "escalationConditions": ["policy_denied", "customer_suppressed", "model_error"],
  "successCriteria": {
    "kind": "task_created",
    "description": "A staff task exists with a committed execution receipt."
  },
  "followupStrategy": { "enabled": false, "delayMinutes": 1440 },
  "maximumAttempts": 3,
  "operatingHours": {
    "timezone": "America/New_York",
    "days": [1, 2, 3, 4, 5],
    "startHour": 9,
    "endHour": 17
  },
  "enabledChannels": [],
  "humanApprovalMode": "all_mutations",
  "context": { "includeContactDetails": false, "includeMessageContent": false },
  "limits": {
    "maxSteps": 5,
    "maxActions": 3,
    "maxRunSeconds": 300,
    "maxRunsPerDay": 20,
    "maxOutputTokens": 1024
  }
}
```

Unknown fields, unsupported tools, duplicate permissions and invalid ranges are rejected.
Descriptions and business context inform the model but never grant permissions. There is
no prose-to-executable-policy compiler or arbitrary JavaScript/JSONPath expression engine.
More eligibility operators can be added as individually validated server-side primitives.
Currently eligibility supports subject type, status allowlist and opportunity inactivity.
A positive `staleAfterDays` requires an actual `lastActivityAt`; missing data is ineligible.

Creating a new version immediately disables the agent. Re-enable explicitly after review.
Already admitted runs stay pinned to their original version and cannot execute actions
under a superseded version. Old approvals do not carry forward.

## Modes, policy and tools

Revenue Recovery now plugs into this runtime as a registered `revenue_recovery`
DecisionProvider. `record_recovery_decision` is a scoped observation tool: it journals
structured classifications, creates handoffs and may impose opt-out suppression, but
cannot send or relax permissions. `send_recovery_message` is an external tool that
requires exact-action HumanApproval and only queues a guarded dispatch. Generic agents
cannot use these tools without a matching recovery program, case, run and version.
AgentVersion.specialization stores the reviewed domain configuration. The Agent Builder
continues to reject unsupported specialization semantics rather than bypassing policy.
See [REVENUE_RECOVERY.md](REVENUE_RECOVERY.md) for delivery and attribution boundaries.

| Mode        | Behavior                                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------------------------- |
| `AUTOPILOT` | Permitted internal actions execute automatically only with explicit `automatic: true` and compatible approval policy. |
| `COPILOT`   | Read tools can run; mutations/control handoffs become exact proposals requiring human approval.                       |
| `ADVISORY`  | Read tools can run; a mutation becomes a stored recommendation, with no execution or actionable approval.             |

`restrictedActions` wins over the allowlist. `all_mutations` forces review in Autopilot.
Stage updates always require review. External effects require review and an available
adapter; no external adapter is enabled in this increment. A human cannot override a
missing adapter, a prohibited tool, tenant boundaries, consent suppression, budgets,
disabled agents or stale context by clicking approve.

The execution sequence is:

```text
canonical event / manual request / schedule
  -> tenant-scoped admission + pinned version
  -> bounded context -> structured model proposal
  -> registered tool + argument/ownership checks -> server policy
       deny/recommend -> recorded terminal result
       approval       -> wait -> current-state revalidation
       allow          -> transactional native tool + audit + canonical fact
  -> next bounded step, or terminal result
```

| Tool                                                                 | Implemented behavior                                                                                                                                                 |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_contact`, `get_opportunity`, `get_estimate`, `get_conversation` | Return an allowed context projection for a known internal ID.                                                                                                        |
| `create_task`                                                        | Native CRM task with optional due date and validated organization-member assignment.                                                                                 |
| `add_note`                                                           | Native CRM note linked to a context record.                                                                                                                          |
| `update_opportunity`                                                 | Move to an active stage in the existing pipeline; uses native optimistic concurrency and lifecycle events. No arbitrary fields, money changes or pipeline switching. |
| `notify_employee`                                                    | Create an assigned internal task. It is not an email/SMS/push delivery.                                                                                              |
| `schedule_followup`                                                  | Persist a one-shot schedule for the same run subject, after the configured minimum delay. Does not send a message.                                                   |
| `request_human_approval`                                             | Pause for a human acknowledgement. This never authorizes a different subsequent action.                                                                              |
| `stop_agent_run`                                                     | Stop this run.                                                                                                                                                       |
| `send_message`, `book_appointment`                                   | Registered typed contracts, but unavailable executors. Fail closed with `adapter_unavailable`; Advisory can retain recommendations. No fake send/booking receipts.   |

Required fields and allowed nullable fields for each tool are declared in the registry.
The model cannot pass a provider name, URL, function name, SQL fragment, organization ID,
arbitrary CRM patch, payment details or integration credential to these tools.

Before implementing an external executor, add a durable action outbox, an organization-
bound integration adapter, consent/channel restrictions, recipient resolution, stable
provider idempotency keys, receipts and uncertain-outcome reconciliation. Do not put a
network send inside `executeTool` or a database transaction. Reuse the integration
delivery architecture where appropriate, but a Zapier HTTP 2xx is not proof of downstream
message delivery or appointment creation. Existing booking flows are not silently reused
with an inferred legacy `Client` or GHL location.

## Decisions and provider abstraction

Every decision has this closed shape. Every input field is required, using `null` for
fields not used by that tool; non-null undeclared fields fail validation.

```json
{
  "kind": "tool",
  "summary": "Create a staff review task for this new request.",
  "tool": "create_task",
  "input": {
    "targetId": "INTERNAL_CONTACT_UUID",
    "text": null,
    "title": "Review the new service request",
    "channel": null,
    "dueAt": null,
    "stageId": null,
    "memberId": null
  }
}
```

`kind: "finish"` requires a null tool and all-null input. There is no fallback prose
parser. `DecisionProvider` receives the pinned definition, stored trigger, projected
context, bounded prior receipts and an abort signal. The deployment-controlled provider
registry currently contains only `openai`; tests inject deterministic providers directly.
Organizations select a provider/model in configuration, never an arbitrary API endpoint.

The OpenAI adapter follows the repository's existing raw REST Responses pattern. It uses
`text.format` with `type: "json_schema"` and `strict: true`, then locally validates the
returned decision again. Incomplete responses and refusals are not actions. No native
model tools are supplied, and `store: false` is requested. These output-handling choices
were verified using the [official Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs).
No live model call was made during implementation. Model compatibility/account access
must be verified in staging for the exact allowlisted model.

## Bounds, concurrency and deduplication

- Hard maxima per active run: 12 model/read steps, 6 action proposals, 900-second execution
  window; configurations can lower them. Model calls time out after 30 seconds. Input is
  capped at 64 KiB, raw response at 128 KiB, output tokens at 4,096, summary at 1,000 characters.
- Each model attempt reserves a numbered step before network I/O. A 120-second lease and
  token fence prevent a stale worker from committing after reclamation. Model I/O is
  outside transactions. A crash consumes its reserved step; interrupted calls remain visible.
- Validated model/API failures terminate the run instead of automatically retrying paid
  calls. Expired leases may resume within the remaining step/deadline budget. There is no
  unbounded provider retry or automatic fallback to a different model.
- The deadline starts at admission and includes queue delay. Outside-hours checks defer
  work by one minute and extend the deadline by that interval. Hours use IANA timezones
  and weekdays 0=Sunday through 6=Saturday; overnight windows are not supported yet.
- Human approval expires after 24 hours. A successful review grants a fresh bounded active
  execution window, not extra steps/actions. Stale input, changed configuration or changed
  CRM context invalidates the proposal. Rejection/expiry stops the run.
- A run is unique by organization, agent and trigger key. Event triggers use the canonical
  event ID. Manual retries must reuse the supplied idempotency key. Schedules use the
  schedule ID and due timestamp. Distinct vendor notifications still normalize through
  the existing event-intake idempotency layer first.
- Exact action input is hashed with subject/tool and deduplicated across all runs/versions
  of that agent. Even an earlier blocked/recommended identical action cannot be replayed
  automatically. There is deliberately no reset/re-entry UI in this increment.
- `maximumAttempts` caps action proposals for the agent/subject across runs, including
  blocked/recommended/pending proposals. It does not reset on every webhook or new version.
- Admission limits: at most 100 runs per agent in a rolling 24 hours, 500 per organization,
  50 universal agents, 100 active schedules, and at most 20 scheduled occurrences. Rate
  limited/unresolvable event triggers are audited; they are not silently retried forever.
  Delayed interval schedules coalesce missed occurrences instead of replaying a burst.
- Agent-origin events cannot recursively trigger universal agents. Administrative run
  stopping fences in-flight model results; it cannot undo an already committed action.

Database effects, action receipts, CRM events, completion events and audit records commit
atomically. This guarantees no repeated internal effect from retrying a committed proposal.
It does not claim exactly-once external delivery or free duplicate model requests after a crash.

## Context, audit and results

The context graph contains at most 12 active CRM records. It follows same-tenant contact,
opportunity, estimate, conversation, appointment, task and message relationships. Contact
roots include up to three recent opportunities and two conversations; opportunities include
up to two estimates and their active pipeline stage options. Message content is opt-in,
limited to three inbound messages per conversation and 1,000 characters per message.
Names/titles and workflow facts are included; email/phone require `includeContactDetails`.
Unrelated custom fields, raw webhook payloads and credentials are not sent to the model.

An invoice/job observation can trigger a run using an explicitly linked active internal
CRM record when it has no supported native subject. No CRM record is invented from a
vendor ID. The run stores event type, ID, time and allowlisted transition/money data, not
the full incoming payload. Other missing/archived subjects produce a visible trigger audit.

The model sees business context as untrusted data, but prompt instructions are only an
additional safeguard. Ownership, tool arguments and policy checks remain authoritative.
Context is rebuilt after a model call and after approval; any fingerprint change stops
the stale proposal. Stage options include record versions, so changed stage definitions
also invalidate approval.

`AgentStep` stores useful decision summaries, not private chain-of-thought or raw Responses
reasoning items. Malformed model output is not retained. Validated failed proposals retain
their decision and a safe error code. HTTP/provider/SQL error bodies and keys are never
stored as error messages. Run detail is admin-scoped and bypasses generic request logging.
Context and drafted text can still contain personal data: apply an organization-approved
retention/access policy before a live rollout. No automatic purge or encryption-at-rest
layer beyond the database/deployment's existing controls is introduced here.

`AgentResult` distinguishes runtime completion from business success. Supported criteria
are recommendation completion, a committed task, a committed note or a committed opportunity
update. Financial success is never inferred from model text or a stage move. Existing revenue
attribution continues to require its separate validated evidence workflow.

Configured escalation conditions mark results with `escalationRequired`; they stop and
record rather than sending an unconfigured employee notification. `model_error` covers
failed execution; `policy_denied` covers other stopped policy/budget paths. Explicit human
handoffs use `request_human_approval`. There is no automatic staff paging in this increment.

Every committed mutation publishes `agent.action_completed` on its canonical subject,
with action/run/tool IDs and `deliveryStatus: "internal_only"`. Existing outbound subscribers
can receive these through the durable webhook queue. Legacy recovery handoff facts retain
their existing meaning. No `opportunity.recovered` fact is emitted just because an AI ran.

## API and operations

All routes are under `/api/agents`. Use HTTPS and
`Authorization: Bearer MEMBER_API_CREDENTIAL`. Active organization owners/admins need
`agents:write`; approval decisions require `approvals:write`. Integration-only keys are
not agent-management credentials. Membership, scope, expiry and revocation are checked
inside the tenant mutation boundary. Browser-origin requests are rejected; this increment
adds an API, not a customer-facing agent builder or approval UI.

| Method/path                    | Purpose                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`, `POST /`              | List or create agents with full structured definitions.                                                                                     |
| `POST /:id/versions`           | Append a reviewed definition; disables the agent.                                                                                           |
| `POST /:id/enabled`            | Set `{ "enabled": true }` or false.                                                                                                         |
| `POST /:id/runs`               | Admit `{ "subjectId": "UUID", "idempotencyKey": "stable-notification-key" }`.                                                               |
| `GET /runs`, `GET /runs/:id`   | Recent runs and complete scoped journals/proposals/approvals/results.                                                                       |
| `POST /runs/:id/stop`          | Stop a pending/running/waiting run; does not undo committed effects.                                                                        |
| `POST /approvals/:id/decision` | `{ "decision": "approve", "reason": "Reviewed by staff" }` or reject.                                                                       |
| `GET /schedules`               | Recent schedules.                                                                                                                           |
| `POST /:id/schedules`          | `{ "subjectId": "UUID", "nextRunAt": "ISO timestamp", "intervalMinutes": 1440, "remainingRuns": 3 }`. Use null interval for one occurrence. |
| `POST /schedules/:id/cancel`   | Disable future schedule admission.                                                                                                          |

JSON request limit is 32 KiB. The existing peer limit (300/minute) and distributed
organization limit (120/minute, shared with integration management) apply. `429` includes
`Retry-After: 60`. Never put credentials in URLs. Lists are bounded to 50 agents or 100
recent runs/schedules; this is not an unlimited export API.

Deployment sequence:

1. Back up production and rehearse all migrations in staging. Deploy the matching generated
   Prisma client. Keep the existing recovery agent enabled/disabled as it was.
2. Set `WORKFORCE_ENABLED=true` and `AGENT_RUNTIME_ENABLED=true` on API/worker services.
   `AGENT_MODEL_ENABLED=false` pauses model processing, while admission/audit can remain active.
3. Configure a reviewed `AGENT_ALLOWED_MODELS` comma-separated allowlist and `OPENAI_API_KEY`
   in secret configuration. No agent-definition request can change the global allowlist.
4. Run the existing `npm run start:workforce-worker` service with
   `WORKFORCE_WORKER_ENABLED=true`. No additional Redis or external queue dependency is added.
5. Test an Advisory agent on fictional records. Enable `AGENT_MODEL_ENABLED=true` only for
   the approved staging test. Review journals, then test Copilot and explicitly permitted
   internal Autopilot actions. External message/booking executors remain unavailable.
6. Monitor failed/stopped runs, interrupted steps, pending/expired approvals, schedule-blocked
   audits and admission limits. Review operational retention and model spending limits.

Do not run fixture scripts against production. Tests require an explicit loopback database
named `steel_scale_demo_*test` and `NODE_ENV=test`; model responses and sends are mocked.
Use `npm run test:agents`, `npm run test:agents:integration`, `npm run test:regressions`,
`npm run typecheck`, `npm run lint`, `npm run build` and `npm run format:check`.

Next increment: implement one consent-aware durable messaging adapter, including downstream
delivery receipts and reconciliation, then migrate the Revenue Recovery workflow onto a
reviewed universal version behind a tenant-specific rollout. Do not switch existing
production recovery agents to model-driven execution automatically.
