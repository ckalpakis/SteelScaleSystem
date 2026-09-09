# Business workspace and commercial product review

See [verification results](PRODUCT_WORKSPACE_VERIFICATION.md) for local test and
browser evidence, rollout limits and repeatable checks.

## Design and scope

Preserve the existing server-rendered Express design: navy `#172554`, ink
`#172033`, steel `#526174`, pale background `#f4f7fa`, white `#ffffff`, blue
`#1d4ed8`. System sans is used for headings and prose; existing monospace is
reserved for counts and metadata. Left-align content on the existing page grid.
The workspace hierarchy is organization and status, urgent human work, launch
checklist, then evidence-based results. Mobile stacks the same reading order.
Use links to existing workflows rather than inventing another configuration UI.
The distinguishing product principle is actionable evidence: every warning has a
next step and every financial number has a stated basis. No decorative dashboard
charts, invented trends, cross-currency totals, or automatic activation.

## Review findings and priorities

The canonical CRM, event outbox, bounded agent runtime, policy engine, recovery
handoffs, knowledge versions, communication ledger, and durable workers already
provide useful domain boundaries. Preserve them.

The highest-leverage gaps are the missing member CRM entry point, disconnected
organization navigation, absence of a launch checklist, newest-first handoffs
burying older work, and financial summaries without a reporting window.
This increment addresses those gaps without changing the database or execution
policy. It does not add a new agent, native CRM integration, or authentication
system.

## What shipped

- `/workspace`: organization-specific Today page with a six-step launch checklist,
  aging handoffs, delivery exceptions, approval counts, current unsold pipeline
  and evidence-based recovery results.
- `/workspace/crm`: member-facing contacts, opportunities, configurable pipelines
  and stages, assignments, custom fields, details, notes and activity timelines.
  It shares the existing router implementation, forms and `CrmService` with the
  retained `/admin/crm` operator interface. Business users never receive the
  synthetic platform-operator principal.
- Shared workspace navigation across CRM, Recovery, Business Knowledge, Agent
  Builder and member Integrations. Operator navigation remains separate.
- Role-aware CRM controls: viewers cannot create, edit, note or archive; fieldsets
  are read-only. Pipeline/stage configuration requires owner/admin access.
  Server permissions still reject forged submissions.
- All/mine/unassigned handoffs ordered by oldest update. Accurate filtered counts
  accompany the oldest 30 matches and a 24-hour aging indicator. Members default
  to their assignments. Aging is time since last handoff update, not a response
  SLA. Links open existing takeover/respond/return/close workflows.
- Separate warnings for unknown and failed Recovery messages, dead outbound
  webhooks, pending approvals and expired approvals awaiting worker reconciliation.
  Unknown delivery advises receipt reconciliation, never blind resending.

### Launch checklist semantics

The checklist inspects stored business records, reviewed Recovery configuration,
current approved knowledge, recorded consent, simulations of this configuration,
and an enabled configured delivery connection. A green item means a setup record
is present—not that all contacts are eligible or a provider is healthy.

Knowledge uses `currentPublicClaim`: same organization, active source/document/
entry, latest approved version, public audience, exact text and general risk.
Legacy inline text does not get a version-verified checkmark. Editing or
deactivating knowledge removes that checkmark. Knowledge never grants permission.

Simulation credit requires the exact saved configuration and a simulation
timestamp at or after its AgentVersion creation. Older-version or edited-draft
tests do not count. Offline scenario evidence is not a live delivery test or a
model-quality evaluation.

Consent counts channel records on non-DND, unarchived contacts. It does not imply
coverage, destination validity or absence of address-level suppression for every
opportunity. Each send retains the existing hard guards.

The web service's agent/model/delivery settings and last delivered-message
timestamp are shown separately. The page explicitly does not claim worker or
provider health. Continue using `/ready` and operator queue monitoring.

### Financial definitions

Windows are rolling 7, 30 (default), or 90 days in UTC, inclusive of the displayed
start and snapshot, based on **outcome occurredAt**. They are not cash-receipt or
review-completion periods. Future outcomes are excluded. Later reviews can
restate earlier periods.

Verified recovered-payment totals require opportunity outcomes with AI_RECOVERED
status, a reviewer and review timestamp, payment reference and positive amount.
The existing attribution service validates delivery, engagement, outcome and
payment evidence; this read model never creates or upgrades attribution.
Currencies remain separate and use correct minor-unit formatting, including
JPY/KWD. Recovered appointments also require human review. Unreviewed outcomes
and the complete status breakdown are separate; the latest 20 outcomes link to
case evidence. Assisted and uncertain outcomes are never recovered revenue.

No profit, subscription expense, counterfactual uplift, ROI percentage or
incremental-revenue claim is invented. The existing Recovery dashboard retains
its older lifetime counters; use this explicit window for period reporting.

## Access, rollout and architecture

`/workspace` requires the existing `WORKFORCE_ENABLED` flag. Member CRM also
requires `CRM_ENABLED`; Recovery and knowledge links respect their flags.
There is no new flag, dependency, queue, migration or Railway setting. Deploy
after the existing platform migrations as described in [DEPLOYMENT.md](DEPLOYMENT.md).

Use an existing member credential as the browser Basic-auth password (username
is a label), or a Bearer header. HTTPS is required in production; never put keys
in URLs. Workspace pages do not expose credentials. Existing feature modules
retain their Basic-auth realms, so browsers may prompt again across modules.
This is intentionally not a new cookie/session implementation.

`auth.ts` reuses credential lookup, rate limits and current membership/scope
validation. Integration keys cannot read the workspace. `service.ts` uses the
existing tenant transaction and current-authorization boundaries; every query
has authenticated organization scope. Foreign path/form identifiers cannot
select a tenant. Existing composite foreign keys protect related records.
Revocation and role changes are rechecked, including stale service principals.
CRM writes retain version fencing, canonical events, audits and soft archival.

Routes precede generic request logging and use no-store, restrictive CSP, escaped
HTML and path/member-bound signed CSRF forms. The workspace has no mutation
endpoint and does not load customer message bodies or hidden model reasoning.
It neither fetches external URLs nor changes consent, enables agents, calls an
LLM or enqueues messages. Authentication still increments the existing rate-limit
bucket. Lists are bounded and query values allowlisted.

## Next highest-value steps

1. Invitations, identity-provider login, secure browser sessions, organization
   switching and credential recovery. Retain CSRF and current-membership checks.
2. Guided Recovery setup with record/approved-knowledge selectors instead of raw
   JSON and UUIDs. Keep reviewed AgentVersions, explicit activation and simulation.
3. A certified delivery adapter and staging canary for opt-out, unknown receipts,
   worker restart and human takeover races. A connection is not certification.
4. Opt-in handoff notifications with recipient preferences, deduplication and
   delivery evidence using the existing durable event/job system. This increment
   sends no unsolicited notifications.

Proposed pilot measures: time to first imported opportunity and reviewed
simulation, median handoff response time, approval backlog age, unknown-send
resolution time and verified recovered payments by currency. These are proposed
measures, not newly instrumented analytics or claimed customer outcomes.

## Operational boundaries

The workspace is an advisory read model, not an authorization or health check.
Only existing services can change CRM data, enable agents, approve messages, or
record recovery evidence. Configuration readiness is not permission to send.
Consent, DND, operating hours, ownership, current knowledge, and policy checks
still run at execution time.

Member API credentials remain the current authentication mechanism. Provisioning
is still operator-assisted. A proper invitation/login/session experience is the
next commercial onboarding priority; this change must not disguise an API-key
portal as completed self-service authentication.
