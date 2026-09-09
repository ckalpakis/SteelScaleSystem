# Revenue Recovery

Revenue Recovery is an optional, service-business-neutral specialization of the existing generic Agent Runtime. It monitors canonical opportunities and estimates; it does not require GoHighLevel or copy a vendor schema. Existing booking, legacy recovery, GHL and webhook routes remain in place.

## Release boundary

This is a guarded, human-reviewed release, **not unattended messaging enabled in production**. Every AI-proposed message requires exact-action approval, including in AUTOPILOT; ADVISORY cannot queue a message. An inbound reply stops autonomous follow-up and enters the handoff queue. The model classifies language; server code chooses only exact organization-approved text. Employee-written responses require takeover and the same consent/time/ownership checks.

A secure pull-delivery adapter contract is implemented, but no native SMS/email provider or installed customer Zap is included. A trusted CRM/provider adapter must implement the claim/deduplication/receipt protocol below. Nothing was deployed, no production migration was run, and no real customer communication or paid model call was made during verification.

## Architecture and data

```text
Canonical CRM events / stale-opportunity scan
  -> tenant-scoped RecoveryCase
  -> existing AgentRun -> AgentStep -> registered observation tool
  -> structured classification + server normalization
  -> existing Policy Engine -> HumanApproval -> registered delivery tool
  -> RecoveryDispatch -> fresh pre-send guards -> trusted adapter -> receipt

Customer reply / opt-out / employee takeover
  -> pause case + invalidate old run/approval + cancel unclaimed dispatch
  -> RecoveryHandoff -> employee review
```

| Model                       | Responsibility                                                                                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RecoveryProgram             | One organization program, generic universal agent, immutable runtime-version reference and optional delivery connection.                                               |
| AgentVersion.specialization | Versioned, validated recovery configuration; existing runtime definition and permissions remain authoritative.                                                         |
| RecoveryCase                | One case per organization/opportunity; revision, contact/conversation, due date, attempt count, delivery/engagement/employee timestamps and enrollment value snapshot. |
| RecoveryDecision            | One normalized decision per generic run, fenced by case revision.                                                                                                      |
| RecoveryHandoff             | One queue record per case, assignment and optimistic revision; open, owned, returned or closed.                                                                        |
| RecoveryConsent             | Explicit per-contact/per-channel permission with evidence. Recording permission does not clear CRM opt-out.                                                            |
| RecoveryDispatch            | Approved AI or explicit employee message, action/request deduplication, claim lease, transport attempts, receipt and error state.                                      |
| RecoveryAttribution         | Unique canonical outcome, attribution status, currency, reviewed payment evidence.                                                                                     |
| RecoverySimulation          | Separate fictional input/result journal; never a live case, run, message or revenue entry.                                                                             |

All tables carry organizationId. Repositories/services scope every access; transactions use the existing organization advisory lock. Composite foreign keys prevent cross-tenant links among programs, runtime versions, cases, contacts, opportunities, conversations, messages, employees, integration connections, actions and outcomes. PostgreSQL enforces one unresolved dispatch per case; the locked application guard additionally prevents concurrent dispatches across a shared contact. API integration credentials cannot browse the member dashboard or operate handoffs.

Organization.active defaults true for existing organizations. Migration `20260909040000_revenue_recovery` adds eight tables and two columns without deleting or replacing existing records. The CRM's identity triggers remain the sole creators of CrmRecord identities. Application reconfiguration bulk-pauses existing work atomically and disables the agent; it never silently reactivates cases.

## Configuration

Use `/revenue-recovery` with the existing organization-member credential bridge, or `PUT /api/recovery/program`. API authentication is `Authorization: Bearer <organization-member-credential>`; credential material is never put in the URL. Owner/admin access is required for configuration, consent and enrollment. Browser forms use action-bound CSRF tokens; machine API requests reject Origin headers. JSON input is closed-schema and limited to 64 KB. Peer and organization rate limits reuse the integrations infrastructure.

```json
{
  "expectedVersion": 0,
  "reviewed": true,
  "connectionId": null,
  "config": {
    "version": 1,
    "name": "Unsold proposal recovery",
    "model": "YOUR_DEPLOYMENT_ALLOWLISTED_MODEL",
    "mode": "COPILOT",
    "minimumValueMinor": 250000,
    "currency": "USD",
    "pipelineIds": [],
    "stageIds": [],
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
    "handoffConditions": ["pricing_negotiation", "angry_customer"],
    "knowledge": [
      {
        "key": "initial",
        "topic": "initial",
        "text": "Would you like to discuss your proposal with our team? Reply STOP to opt out.",
        "approved": true
      },
      {
        "key": "followup",
        "topic": "followup",
        "text": "Checking whether you would still like to discuss your proposal. Reply STOP to opt out.",
        "approved": true
      }
    ]
  }
}
```

The example is a proposed configuration, not business/legal approval. An authorized organization administrator must review the actual channel permission, approved wording, operating timezone and policy requirements. Amounts are minor currency units; currencies are never converted or combined. Empty pipeline/stage lists mean any otherwise eligible canonical pipeline/stage, not vendor stages. Selected stages must be open and belong to permitted pipelines.

Maximum attempts: 1–10. Cadence contains exactly maximumAttempts minus one positive interval; repeated intervals are valid. Initial delay is measured from opportunity activity/event time, not from arbitrary model dates. Subsequent intervals begin at confirmed delivery. The first configured channel is the automatic follow-up channel; other enabled channels are available to employee responses. A consented destination is required; there is no automatic cross-channel fallback. Operating hours are an explicit IANA timezone, weekdays and an hourly same-day window; holidays, overnight windows and recipient-specific timezone inference are not implemented.

Saving requires reviewed=true and an expected runtime version. All knowledge entries must be explicitly approved before enabling. Configuration changes create a new generic AgentVersion, disable the agent, revoke pending approvals and queue existing active cases for human review. Agents edited outside the specialization fail version checks. Disabling remains possible even when a model has been removed from the deployment allowlist.

## Scheduling, decisions and safety

The existing workforce worker calls the recovery scanner once per minute. Each pass selects at most 20 due programs, pages 50 stale opportunities per program and considers up to 50 due cases. Programs have scan cursors; cases with unresolved dispatches or live pending runs do not occupy the next scheduling batch. There is a 10,000-case organization capacity and the generic 100-run/day agent budget, 3-step/1-external-action loop and 5-minute run limit. Capacity/model/runtime failures remain visible in audit/handoff/run records; no unbounded retries.

Supported intake includes estimate.sent, opportunity.stage_changed, opportunity.created/updated, customer.message_received, won/lost, accepted/declined estimates, appointment booking/cancellation, employee messages and contact opt-out changes. Vendor normalization stays in the existing integration adapter layer. The router's event ledger, unique case/run keys, revisions, unique action/request keys and dispatch reservation protect against repeated facts and concurrent scans.

Before proposal, approval execution and adapter claim, guards check agent/version, active organization, current CRM ownership/archives, contact opt-out, explicit channel consent and destination, current open opportunity/value/currency/pipeline/stage, accepted/declined estimates, booked appointments, employee activity, human ownership, unprocessed inbound messages, unresolved dispatches, working hours, delay and remaining attempts. Approval is not permanent authorization to send later. Customer facts are re-read directly, without waiting for asynchronous event processing.

Structured intents:

`interested`, `not_interested`, `price_objection`, `competitor_comparison`, `timing`, `needs_spouse_or_partner`, `financing_question`, `scheduling_request`, `information_request`, `pricing_negotiation`, `angry_customer`, `legal_or_compliance`, `wrong_person`, `opt_out`, `unknown`.

```json
{
  "intent": "pricing_negotiation",
  "interest_level": "unknown",
  "recommended_action": "handoff",
  "human_required": true,
  "reason": "Customer response classified as pricing_negotiation; autonomous follow-up paused.",
  "next_followup_at": null,
  "message_if_allowed": null
}
```

The provider uses the shared OpenAI Responses strict JSON-schema helper, with local validation and refusal/error handling, following [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs). Its sole input is bounded customer message text, not company credentials or complete contact context. The provider/model is deployment-allowlisted and replaceable via RecoveryClassifier. Deterministic safety detection adds early opt-out/negotiation/legal/wrong-person/angry-customer handoffs. Unrecognized language cannot authorize sending: every inbound response pauses messaging before classification.

Model-written reply text and dates are discarded. The normalized decision uses only exact approved knowledge and deterministic cadence. Discounts, pricing negotiation, legal/compliance claims and other restricted intents never select an autonomous reply. Finance/warranty/company facts must be explicitly reviewed knowledge; missing knowledge creates a handoff. Generic journal steps contain useful decision summaries, not hidden chain-of-thought. The registered observation may journal, hand off or impose a stricter opt-out; it cannot dispatch, clear suppression or expand permissions.

## Handoff workflow

The dashboard shows customer, opportunity, current value, reason and assigned employee. Case detail shows the customer's canonical message, decision summary and delivery evidence. Defaults use the opportunity's assigned organization member. Unassigned work can be taken by an owner/admin; ordinary employees must be assigned.

- **Take Over:** assigns the current member, pauses the case and other tracked opportunities for the contact, cancels unclaimed AI dispatches and rejects pending approvals.
- **Respond:** requires owned assignment, a reviewed employee message and unique requestKey; queues it to the same guarded delivery adapter. This is not AI-authored execution and does not count as an AI recovery touch.
- **Return to AI:** explicit, revision-checked resumption only if eligible, with no unresolved delivery. Keeps attempt counts and waits through cadence/employee quiet time. It does not clear opt-out or reactivate won/lost opportunities.
- **Close Handoff:** closes the case without restarting AI.

An adapter claim is a short authorization lease, not an atomic transaction with an external CRM. An already-claimed message may be in flight when takeover/opt-out arrives. Adapters must send immediately, enforce their own latest consent/suppression controls and never send after lease expiry. This distributed-system boundary is explicitly shown in the UI; the application does not promise cancellation of a message already accepted by a provider.

## Delivery adapter protocol (v1)

Configure a dedicated organization ExternalConnection and scoped integration credential in Integrations; set its ID as program.connectionId. Only that active connection's credential with events:write may claim or acknowledge dispatches. Member credentials and other organization/connection credentials are rejected. Credential revocation, member authority and organization/agent state are rechecked, not cached indefinitely.

1. `GET /api/recovery/delivery` lists up to 50 pending dispatch IDs, without recipient/message content.
2. `POST /api/recovery/delivery/:id/claim` with `{}` atomically rechecks guards and returns either blocked/retryable or a v1 claim: dispatchId, idempotencyKey, one-time claimToken, expiresAt, channel, destination, message. The lease is 30 seconds; only a hash of claimToken is stored. Treat the response as sensitive and do not put it in workflow logs.
3. Adapter deduplicates durably on idempotencyKey and submits that key to the messaging provider where supported. It must not re-send merely because an HTTP response was lost. Send before expiresAt; no send if the guard returns blocked.
4. `POST /api/recovery/delivery/:id/receipt` submits:

```json
{
  "claimToken": "TOKEN_FROM_CLAIM",
  "status": "delivered",
  "providerMessageId": "VERIFIABLE_PROVIDER_MESSAGE_ID",
  "occurredAt": "2026-09-08T14:00:00Z",
  "evidence": "Provider-confirmed delivery receipt reference; no unnecessary customer details."
}
```

Status is delivered, not_sent or unknown. delivered requires provider confirmation and an ID, not a successful Zapier/webhook HTTP response. CRM Message uses its existing `recorded` status; actual delivery proof remains in RecoveryDispatch. Identical receipts replay idempotently and provider receipt IDs are unique within organization/connection. The adapter is trusted to supply honest evidence; this release does not independently query a vendor to verify it.

Only a conclusive not_sent result is retryable: exponential backoff (20s, 40s), at most three transport claims, without consuming another logical follow-up attempt. Unknown outcomes and expired unacknowledged leases freeze the case and appear in the queue. A later definitive receipt can reconcile an unknown claim using its original token; it never resumes automation on its own. If the token was lost, escalate for operator/provider reconciliation; do not rotate credentials and resend blindly. Failed/unknown/cancelled records and audits are retained. There is no automatic drop or unlimited retry loop.

To connect a CRM/Zapier workflow, continue sending canonical contact, opportunity, estimate and inbound message information through [the existing integration API](ZAPIER_INTEGRATION.md). A scheduled, trusted adapter can poll and execute the protocol above; building/certifying that customer-specific workflow is still required. Outbound agent.handoff_created and reviewed opportunity.recovered/appointment.recovered events use the existing signed retrying outbound webhook system. Outbound event subscribers must not independently send a second message for an already claimed dispatch.

## Attribution and dashboard definitions

AI_ASSISTED means confirmed AI delivery followed by a reply and valid outcome inside the configured window. UNCERTAIN means temporal contact without adequate engagement evidence. NOT_ATTRIBUTED covers missing/invalid/out-of-window evidence. None automatically becomes AI_RECOVERED.

AI_RECOVERED requires an authorized review, confirmed AI dispatch, subsequent unambiguous customer engagement, current won/booked CRM state and outcome inside the attribution window, without employee intervention before engagement. A shared-contact reply pauses every case but is not automatically credited to all opportunities. Such ambiguous cases remain uncertain until a stronger attribution model is implemented.

Recovered revenue additionally requires a unique payment reference, paid timestamp after the outcome, amount greater than zero and no larger than the opportunity value, and matching currency. This is **operator-reviewed evidence**, not independent payment verification or causal proof. Appointments carry zero revenue. Repeated identical reviews are idempotent; reopening/loss/cancellation events revoke invalid recovery credit. Refund/partial-payment reconciliation and automated accounting integrations are future work.

Dashboard: current unsold pipeline (all open canonical opportunities), enrollment count/value snapshots, active cases, distinct engaged contacts, distinct inbound responses after confirmed AI delivery, reviewed appointments/deals/revenue, open handoffs and recent audit/delivery activity. Response counts describe observed temporal responses, not experimentally proven causal lift. Multiple currencies remain separate. Queue/activity lists are bounded initial views (50 handoffs/cases, 30 activity/error records); broader search/pagination and operational alert delivery are next-stage work.

## API reference

All paths below are under `/api/recovery`:

| Method/path                                                         | Purpose                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| GET /dashboard                                                      | Scoped metrics, open handoffs, approvals, recent activity/errors.               |
| PUT /program                                                        | Reviewed versioned configuration.                                               |
| POST /program/enable                                                | `{ "enabled": true/false }`; explicit admin action.                             |
| POST /consent                                                       | contactId, channel, granted, evidence.                                          |
| POST /cases                                                         | Explicit enrollment by canonical opportunityId.                                 |
| GET /cases/:id                                                      | Scoped contact/opportunity, handoff, decisions, dispatches and outcomes.        |
| POST /handoffs/:id                                                  | action, expectedRevision; respond also needs message, channel, requestKey.      |
| POST /approvals/:id                                                 | decision approve/reject and reason; delegates existing runtime approval engine. |
| POST /attributions/:id/review                                       | status, evidence, amountMinor, currency, paymentReference, paidAt.              |
| GET /scenarios                                                      | Version-controlled fictional scenarios.                                         |
| POST /simulations                                                   | scenarioKey, or message + complete fake state; optional validated config.       |
| GET /delivery; POST /delivery/:id/claim; POST /delivery/:id/receipt | Dedicated integration-adapter protocol above.                                   |

## Simulation and verification

`src/recovery/scenarios.ts` seeds **37** version-controlled realistic fictional scenarios across service businesses. They include all 15 intents plus opt-out variants, Unicode, prompt injection, unknown/emoji input, disabled/inactive/opted-out states, missing consent, won/lost, employee conflict, duplicate dispatch, hours, value and attempt limits. They are not inserted as production CRM contacts or messages.

The Simulation lab executes an offline deterministic classifier and the same decision normalization; it never calls a model or delivery API. It stores only RecoverySimulation. Fake safety state demonstrates guard behavior; it is not a substitute for database integration tests or a live-model evaluation. Custom simulations require a full fake state. There is a 100-simulation/day organization limit.

Run `npm run test:recovery` (no DB), `npm run test:recovery:integration`, `npm run test:recovery:browser`, `npm run test:regressions`, typecheck, lint and build. Database tests require NODE_ENV=test and an explicit loopback `steel_scale_demo_*test` database. See [REVENUE_RECOVERY_VERIFICATION.md](REVENUE_RECOVERY_VERIFICATION.md) for results and limits.

## Safe rollout

Communication integration: COMMUNICATIONS_ENABLED mirrors Recovery dispatches into canonical
Message/CommunicationDelivery records from queue time, including failure/cancellation and
claim-expiry reconciliation. These records do not prove delivery; use deliveredAt/receipt state.
Inbound STOP and address suppression are applied synchronously by canonical publication and
checked again by the Recovery send guard. The native member-send worker never claims Recovery
dispatches. See [COMMUNICATIONS.md](COMMUNICATIONS.md); existing certified adapter and approval
requirements remain unchanged.

Business Knowledge integration: reviewed `knowledge[]` items can bind `versionId` to a current
approved public general KnowledgeVersion with identical text. When BUSINESS_KNOWLEDGE_ENABLED
is true, all items require those bindings; configuration, proposal, approval and delivery claim
revalidate them. Withdrawal blocks AI dispatch and removes stale references from observations.
Bound references are rechecked even with the flag false. Unbound legacy templates retain their
previous behavior only while false. Prepare bindings before enabling on web/worker; do not
silently backfill approvals. See [Business Knowledge](BUSINESS_KNOWLEDGE.md).

Both new flags default false: REVENUE_RECOVERY_ENABLED and REVENUE_RECOVERY_DELIVERY_ENABLED. No existing `.env` was changed. In staging, apply migrations through the normal web release, configure the existing separate workforce worker, enable WORKFORCE_ENABLED and AGENT_RUNTIME_ENABLED, and then enable recovery for one reviewed organization. Leave delivery off until adapter idempotency, expiry, consent, revoked credentials, duplicate events, takeover races and provider receipt reconciliation are certified. Live classification additionally requires AGENT_MODEL_ENABLED, OPENAI_API_KEY and AGENT_ALLOWED_MODELS. Set consistent flags on web and worker services.

Next milestone: certify one consent-aware delivery adapter against a sandbox CRM/provider, evaluate the classifier against representative multilingual customer data, and pilot with human review. Do not remove approvals or enable unattended sending as part of merely deploying this migration. Roll back behavior by disabling delivery/recovery on both services; preserve tables, dispatches and financial evidence.
