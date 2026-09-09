# Business Knowledge

Business Knowledge is an organization-owned, reviewed source of facts, not an authorization
system. `src/knowledge` contains closed contracts, a tenant-scoped repository, transactional
service, retrieval, API and server-rendered admin UI. It reuses workforce identity, audit,
transaction locks, rate limits and registered agent tools. No GHL, model call, vector database
or paid ingestion service is required.

## Data model and review

| Model             | Responsibility                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| KnowledgeSource   | Provenance name, optional HTTPS reference, active state and revision. References are not fetched.               |
| KnowledgeDocument | Immutable text, filename, source, hash, author and active state. Same-source identical content is deduplicated. |
| KnowledgeEntry    | Stable identity, category, audience, source/document provenance, current version and explicit approval pointer. |
| KnowledgeVersion  | Immutable numbered title, FAQ question, exact content, structured facts, risk, author and timestamp.            |

Every model carries organizationId. Composite foreign keys prevent cross-organization source,
document, entry and approved-version links. Approval must reference a version of the same
entry; document links must belong to the entry's source. Organization.knowledgeRevision changes
atomically with mutations. Existing business records are not converted or deleted.

New entries are inactive drafts. An owner/admin must review the exact latest version and
intended audience before activation. Editing appends a version and withdraws the previous
approval immediately. `expectedRevision` fences stale saves, reviews and toggles. PostgreSQL
triggers prevent version edits/deletion and document content/provenance changes. There is no
delete endpoint. Deactivating a source/document removes dependent facts without deleting them.

Audience defaults to internal. Current agent retrieval exposes public entries only, including
when asked about employees. Internal entries are visible to organization members with CRM read
authority in management, not to the model tool. Do not store secrets or sensitive employee
records in this shared reference library.

## Structured knowledge and permissions

Categories: company, services, service_areas, business_hours, pricing, financing, warranties,
faq, scheduling, offers, policies, employees, products, service_descriptions,
escalation_contacts and communication_template. The UI displays the allowed structured fields
per category; `src/knowledge/contracts.ts` is the authoritative closed schema. Fields accept
bounded strings/string arrays. Unknown fields, including permissions, are rejected. FAQs
require a question. Exact content is capped at 4,000 characters.

Example draft after creating a source:

```json
{
  "sourceId": "<organization-source-uuid>",
  "category": "financing",
  "audience": "public",
  "title": "Financing availability",
  "content": "Financing is available through ABC Finance, subject to lender approval.",
  "facts": {
    "provider": "ABC Finance",
    "availability": "Available, subject to lender approval.",
    "limitations": "Terms must be confirmed with the lender."
  }
}
```

Approval does not authorize a monthly payment quote, guaranteed approval, discount, price
change or additional tool permission. Pricing, financing, warranty, offer, policy, scheduling
and employee/escalation categories are conservatively restricted. Text checks also restrict
sensitive claims in other categories. This is a conservative guard, not a complete semantic
or legal classifier; admins remain responsible for factual accuracy and classification.
Restricted facts are reference-only: the current automatic public-claim validator rejects
them even after knowledge approval. Future sensitive actions require separate reviewed policy.

## Uploaded documents

The UI loads a local .txt/.md file for review, then saves its plain text. The API accepts
`{sourceId, filename, content}` with at most 40,000 UTF-8 bytes. Paths, other formats and binary
controls are rejected. Markdown is escaped text, never executable HTML or model instructions.
Raw documents are never retrieved by agents. Create a documentId-linked entry whose content
is an exact excerpt, then review it. Document-backed entries cannot add inferred structured
facts. Changed documents are new documents; deactivate old ones to withdraw their excerpts.

The repository has no general file ingestion pipeline. This bounded text path adds no PDF/OCR,
website fetching, object storage, embeddings or automatic extraction dependency.

## Retrieval and unsupported claims

`retrieve(transaction, organizationId, question)` searches current approved active public
entries, active source/documents and an active organization. Organization scope is derived
from authentication or runtime context, never model-selected. Results contain:

- answer: exact reviewed answer or null, never synthesized/paraphrased assertions.
- status: approved_exact_answer, reference_only, unsupported or refine_question.
- sources: up to five entry/version/source IDs, approved excerpts, structured facts, risk,
  optional reference and source-document filename.
- permissionsGranted: false, plus organization knowledge revision.

An automatic answer requires a unique exact title/FAQ-question match with general risk.
Approximate matches show references, unknown questions have no answer and ambiguous exact
matches cannot generate an answer. More than 100 candidates requires a narrower question.
An exact answer always cites its own version. This is lexical retrieval, not semantic RAG.
Limits per organization: 100 sources, 500 documents, 5,000 entries. Management shows 50 entries
with keyset paging, 100 documents and the latest 50 versions. Unlimited exports are not built.

`currentPublicClaim` is the executable grounding check: organization/version must still be
active, public, current and approved, and supplied text must exactly equal general-risk
approved content. An invented $199/month statement cannot pass against financing availability.

## Runtime integration

`get_business_knowledge` is a registered read tool taking a query in input.text and no target
ID. It requires explicit reviewed agent permission; citations/results appear in AgentStep.
With the feature enabled, knowledgeRevision becomes part of the generic context fingerprint:
a change invalidates a pending decision/approval's old context rather than authorizing stale
facts. Knowledge never grants send/booking/pricing permission.

Recovery `knowledge[]` items now accept versionId alongside existing key, topic, text and
approved fields. When BUSINESS_KNOWLEDGE_ENABLED=true, every item must bind exact current
approved public general content. Configuration and message guards check this before proposal,
approval and delivery claim. Withdrawn references are also removed from decision observations.
Recovery journals/audits record source version IDs. Missing/stale references block action;
there is no unreviewed-text fallback. AgentPolicy, consent, eligibility, operating hours,
tool permissions and HumanApproval remain mandatory. Human takeover replies remain human
actions, not AI-grounded claims. Question testing calls no model and sends no communication.

Scope: this increment grounds the universal runtime knowledge tool and Recovery AI outbound
templates. It does not certify arbitrary model-written internal recommendations or retrofit
legacy booking/chatbot prompt paths. Builder business-context prose is not automatically
approved knowledge. Future customer-facing executors must enforce the claim validator or a
separately reviewed action policy at execution, not trust an LLM instruction. No unrestricted
generative answer/sending endpoint is introduced.

## API and admin

`/api/knowledge` uses current organization-member Bearer credentials. `/business-knowledge`
uses the existing member API-key Basic-auth bridge, action-bound CSRF, escaped text, CSP and
rate limits; this is not a new password/session system. Integration credentials cannot manage
knowledge. Reads need CRM read scope; mutations need agents write scope (owner/admin), with
current membership/access rechecked inside each tenant-locked transaction.

| Method / API-relative path | Purpose                                                      |
| -------------------------- | ------------------------------------------------------------ |
| GET /                      | Sources, document metadata and entries; optional after UUID. |
| POST /sources              | Create name and optional reference.                          |
| POST /documents            | Save/deduplicate sourceId, filename, content.                |
| GET /documents/:id         | Scoped immutable source text.                                |
| POST /entries              | New entry and draft version.                                 |
| GET /entries/:id           | Entry, provenance and latest 50 versions.                    |
| PUT /entries/:id           | Full entry content and expectedRevision; appends draft.      |
| POST /entries/:id/approve  | versionId, expectedRevision, reviewed: true.                 |
| POST /sources/:id/active   | active, expectedRevision; also documents and entries.        |
| POST /questions            | question; supported answer/references with citations.        |

Machine API requests carrying Origin are rejected. JSON/form bodies are limited to 64 KB.
Peer/distributed organization limits reuse integration management limits. Audits store actor,
action, version IDs and hashes, not duplicate uploaded text. Documents/immutable versions
retain text for evidence; erasure requires a separately reviewed retention process. The tester
does not persist question text; run journals retain agent tool queries/excerpts under existing
retention. Source URLs are not fetched or rendered as external requests.

## Safe rollout

1. Back up production; rehearse the additive 20260909120000_business_knowledge migration in
   staging. Deploy the matching generated Prisma client. Four tables and organization revision
   are added; legacy data/models remain intact.
2. BUSINESS_KNOWLEDGE_ENABLED defaults false. Existing unbound Recovery templates retain their
   previous behavior while false. Bound references are always revalidated, even while false;
   disabling the feature is not a bypass for withdrawn facts.
3. Prepare reviewed public staging entries and bind Recovery knowledge[].versionId with exact
   text through its versioned configuration API/UI. This is not an automatic conversion of
   legacy approved-text flags into new knowledge approvals.
4. Enable WORKFORCE_ENABLED and BUSINESS_KNOWLEDGE_ENABLED consistently on web and worker.
   Existing unbound recovery configurations fail closed once enabled: prepare bindings before
   production cutover. Changes invalidate pending context and can require a new run/configuration
   review. Approving a replacement never silently changes a pinned agent version.
5. Verify withdrawal, tenants and unsent proposals before allowing a certified delivery adapter.
   No production deploy or communication occurred in this implementation. Preserve tables and
   evidence during rollback; do not reset a production database.

Tests: test:knowledge, test:knowledge:integration, test:knowledge:browser, migration rehearsal,
existing test:regressions, typecheck, lint and build. Database/browser checks require NODE_ENV=test
and an explicit loopback steel_scale_demo_*test database; fixtures are fictional and providers
are disabled. See [verification results](BUSINESS_KNOWLEDGE_VERIFICATION.md).

Next increment: add a knowledge-version picker to agent configuration, then evaluate multilingual
and semantic retrieval with source-coverage tests. Preserve reviewed-claim and action-policy
execution checks before adding generated customer-facing answers.
