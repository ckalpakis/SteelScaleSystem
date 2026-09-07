# Steel Scale Systems — on-demand sales demo engine

> September 7, 2026 implementation update: the original package/spec below is retained for context. The integrated application now includes an interactive website/chat presentation and a demo-only OpenAI browser-voice/chat runtime. See [LIVE_DEMO_EXPERIENCE.md](LIVE_DEMO_EXPERIENCE.md) for current functionality, simulated boundaries, configuration and remaining validation. The old “text-only simulation” rows below describe the initial milestone, not the current UI.

**Approved direction:** September 7, 2026. **Owner:** Carson Kalpakis / Steel Scale Systems.
**Repository:** `ckalpakis/SteelScaleSystem`.
**Inspected baseline:** `e9ff23049fa34db1977b295ea2eb3d0f61bc45a5`.

## Status and scope

This is a repository-specific first implementation package plus the remaining product specification. It is **not deployed**, has **not been committed or pushed to GitHub**, and is **not a complete live-AI platform**. Creating a GitHub branch through the active integration returned HTTP 403, `Resource not accessible by integration`.

The supplied source implements the on-demand workflow, guided demonstration modules, website homepage observations, a calculator, and engagement storage. Some core modules were typechecked and unit-tested; Express/Prisma integration, database migrations, full repository tests and browser execution remain release gates. See `DEMO_ENGINE_ROLLOUT.md`.

The scope below is derived from Carson's approved requirements, not an independently verified exhaustive Lumina feature inventory. No complete YouTube transcript was available for the earlier comparison; do not claim feature-for-feature parity.

## Non-negotiable product rule

**Scraping a lead does not create a demo.** Neither importing, deduplicating, enriching, scoring, calling, emailing, texting, nor changing lead status may create a demo, perform demo research, or provision paid demo resources. Demo creation must follow an explicit authenticated operator action.

A lead can exist without a demo. A demo can exist without a prospect record. A demo must not require or automatically create a production `Client`.

The business lifecycle is:

`Find prospects → ordinary outreach → interest / discovery → operator creates a demo → review → publish → manually share → engagement → sales conversation → won → separately approved production onboarding.`

A demo is optional even after a prospect expresses interest. Carson decides whether it helps the sale.

## Business model

Steel Scale sells business outcomes and implements automation directly for its own clients. The platform is Steel Scale branded. There is no agency-reseller tier, agency signup, wholesale fulfillment marketplace, agency billing, agency impersonation, or agency-level white-label hierarchy.

This does **not** remove client isolation. Existing production clients must continue to have separate data, voice settings, phone numbers, integrations, and secrets. Future client portals need proper client-scoped authentication and authorization; an unguessable demo link is not a client login.

## Two creation paths

### Standalone demo

Open `/admin/demos/new`. Business name and niche are required. Website and Google Business Profile URLs, service area, business phone, verified services, hours, public summary, private sales notes, and selected modules are optional as appropriate.

The first release accepts business phone as a private reference only. It never calls or texts that number. The GBP link is reference-only; this version does not read the profile, reviews, ratings, or hours from Google.

### Existing prospect

Open `/admin/demos/prospects`, search a business name and select a match. Prefill name, website, niche/category, location and phone from the existing `ProspectBusiness`, then allow edits before generation. Save an optional foreign key to that prospect, but keep a snapshot of demo-specific context.

If a prospect is later deleted, `ON DELETE SET NULL` detaches the demo rather than deleting it. Existing ingestion and scoring code remains untouched.

## Reviewable inputs and provenance

Keep operator-entered information, website observations, and niche-template examples distinguishable. Website content is untrusted data, never application instructions. Business URLs must be validated. Crawls must reject private/reserved addresses, credentials in URLs and arbitrary ports, pin DNS at connection time, constrain redirects, cap response sizes, and enforce deadlines.

The initial source fetches only one HTML page, with at most two same-business-domain redirects, a 10-second total deadline, and a 512 KiB limit. It does not execute JavaScript, fetch embedded assets, bypass blocked access, or start background crawls. Website research is optional and is performed only during an explicit authenticated generation request.

Fetched description text can seed the public summary, subject to operator review. Failed fetches must be visibly marked unavailable. Never replace missing evidence with a made-up score or unverified statement.

Never invent business hours, staff availability, prices, policy quotes, review counts, competitor review counts, rankings, Lighthouse metrics, jobs lost or revenue recovered. A static HTML observation is not a full SEO or performance audit. A webpage listing a service is evidence of a published claim, not proof of current capacity or availability.

Private sales notes influence recommendations locally but must never be spread into the public snapshot, model-visible business facts, HTML, logs, analytics metadata or URLs. The current `generatePresentation` function uses an explicit public-field allowlist.

## Implemented source components

| Component               | Initial implementation boundary                                                       |
| ----------------------- | ------------------------------------------------------------------------------------- |
| Admin demo workspace    | List, create, edit/regenerate, preview, publish/renew, archive                        |
| Prospect integration    | Search and prefill; optional relationship; no automatic generation                    |
| Recommended modules     | Deterministic rules from niche and operator notes; not an LLM or website diagnosis    |
| Website personalization | Optional bounded homepage fetch; title, meta description, qualified HTML observations |
| Receptionist demo       | Guided text conversation preview; not live voice                                      |
| Chat demo               | Guided chat scenario; not an interactive LLM conversation                             |
| Missed-call demo        | On-page illustrative sequence; sends no SMS                                           |
| Nurture demo            | On-page fast-forwarded sequence; no real workflow enrollment                          |
| ROI                     | Editable assumptions; recovery, qualification, conversion and contribution separated  |
| Sharing                 | Random 256-bit bearer link, explicit publication, expiry, private preview             |
| Analytics               | Allowlisted pseudonymous session events, database deduplication, lifetime cap         |
| Documentation           | Persistent business rules and rollout checklist                                       |

The live-AI and production-onboarding features below remain unfinished milestones. Do not label these complete because the production repository already contains some related services.

## Demo lifecycle

Creation produces a private draft. Repeated submission of the same creation request ID returns the existing record. Operator preview generates no analytics. Publishing requires an explicit reviewed checkbox and a lifetime of 1–90 days; the form defaults to 45 days.

Editing regenerates a draft and unpublishes the previous version until reviewed again. Optimistic version checks prevent one browser tab from overwriting another tab's changes. Publication also checks the version. Expired, archived and draft public URLs return 404.

Expiry is enforced at request time, not by a cron that might fail. Expiration blocks access; it does not delete the prospect, production client, or stored draft. The current record retention policy must be reviewed before large-scale use. A scheduled retention/deletion policy is not implemented in this package.

Anyone possessing an active demo link can view it. Do not include secrets or private customer information. Use internal preview for testing; public links can create engagement events.

## Data and runtime integration

Add `SalesDemo` and `SalesDemoEvent`, with an optional inverse relationship on `ProspectBusiness`. Leave `Client`, production booking models and lead-ingestion behavior unchanged. JSON input and presentation snapshots keep the first milestone additive; use versioned, typed validation when evolving them.

Mount the new authenticated admin router and public demo router before the existing generic request logger. Each router owns its parsing, auth where applicable, headers and error handling. This avoids adding bearer demo URLs and private demo forms to the existing generic request logs. Infrastructure/proxy logs still need their own redaction and retention review.

`DEMO_ENGINE_ENABLED` defaults to false. New public and admin demo routes return 404 until explicitly enabled after migration and staging verification. Existing call/text/booking routes do not change.

Admin forms use signed, expiring action-scoped tokens bound to the operator's authenticated credentials. All dynamic output is escaped. Public events accept only a UUID browser-session key and an allowlisted event name for an enabled module. Event persistence deduplicates on `(demoId, sessionKey, kind)`. A transaction caps total recorded events at 5,000 per demo and rolls back the counter on duplicates.

Analytics are **cumulative across demo versions**. A new per-version attribution model can be added later. Do not interpret a browser session as a verified owner, buyer or unique human. Admin preview is excluded; link scanners or bots that execute JavaScript can still affect public measurements.

## ROI policy

Show assumptions and let the operator/prospect edit them:

`Potential recovered revenue = missed calls × recoverable share × qualified/bookable share × close rate × average collected job value.`

`Contribution after fee = potential recovered revenue × contribution margin − monthly fee.`

Do not call revenue profit. Do not treat every missed call as a lost customer, and do not assert that the system recovers every call. Niche defaults are illustrative, not measured. Never infer missed calls, profitability or conversion rate from a website or GBP URL.

## Remaining milestone A — actual sandbox AI chat and browser voice

Build distinct demo sessions with explicit `mode=demo` enforced server-side. Do not expose the production `/chatbot`, `/internal/bookings`, Twilio webhooks or production voice tools to a demo visitor. Avoid creating a fake production `Client` just to reuse an integration.

Share only safe prompt-building and provider-adapter code. Introduce a demo-only tool dispatcher with `check_demo_availability` and `create_demo_booking`; the dispatcher may write demo data but must have no access to production bookings, customer SMS, live calendars, CRM actions or owner alerts. Simulated booking returns must say that no real appointment was created.

Keep business identity, service facts and simulation status explicit. No real policy quotes, emergency guarantees, or invented availability. Avoid collecting real customer data in a sales demo.

Before enabling paid providers, implement server-side issuance of short-lived session credentials; per-session, per-demo and daily agency usage limits; concurrent-call limits; cost caps; maximum call duration and maximum chat turns; expiry checks on every session and tool call; kill switches; and abuse controls. Provision paid resources on first allowed interaction where possible, not for every stored draft or prospect. Never expose provider secret keys.

Production `src/services/chatbot-llm.ts` currently advertises a `create_booking` tool; importing it unchanged into public demos is not sufficient isolation. The existing raw OpenAI REST response parsing should also be reviewed against the actual API response format before reuse. Treat this as a concrete integration review task, not proof that the production path was tested here.

## Remaining milestone B — stronger evidence and configurable vertical packs

Replace the compact illustrative niche defaults with validated, versioned packs: verified services, safe qualification questions, common objections, boundaries, example workflows, input fields and editable financial assumptions. Start with the niches Carson is actually pitching rather than maintaining dozens of speculative packs.

Add a supported GBP data source only when access and reuse are appropriate. Store source URL, time, confidence and verification state per claim. Missing or inaccessible data must remain unknown. Do not silently claim an external profile was read.

A true performance audit can later call an appropriate measurement provider with explicit cost controls and source attribution. Distinguish observed metrics from heuristic suggestions; do not invent Lighthouse scores, local rankings, or competitor comparisons.

## Remaining milestone C — review / local SEO demonstrations

Add optional modules for review requests and local visibility analysis, using verified inputs and clearly labeled examples. No review gating, fabricated reviews or claims that a ranking improvement already occurred. Demonstrating a request must not send it to a real customer.

## Remaining milestone D — sales workspace and engagement prioritization

Connect eligible demo signals to the existing call queue and offer recommendations as a separate, explainable signal. Never overwrite the underlying fit score with a raw click count. Bot filtering, repeated-event caps, owner/test exclusions and event age decay are required before automatic reprioritization.

Do not automatically initiate SMS/email/calls because a link was opened. Demo engagement does not grant outreach consent or override DND, suppression, client/partner exclusions or opt-outs.

Add an operator-configured consultation CTA, sales follow-up reminders and optional notifications. Notifications should link to the internal record rather than copying private notes into public channels. No third-party messaging integration is enabled by the initial package.

## Remaining milestone E — sales handoff and client portal

A won opportunity creates a reviewed onboarding draft only after an explicit operator action. Keep demo and production identifiers, prompts, credentials, destinations and analytics separate. Copy approved business facts, never temporary demo tokens, synthetic appointments, sample customer data or illustrative financial values.

Production activation requires actual hours/services, verified routing, phone configuration, authorized integrations, end-to-end tests and operator go-live approval. The client portal needs authenticated per-client access to onboarding tasks, approved reports, assets, support and appropriate call/booking data. Reseller/white-label features remain excluded.

## Release acceptance

A normal scrape, CSV import, lead score update and cold-outreach action must produce zero demo rows and zero demo provider calls. Both standalone and prefilled creation must work. Drafts stay private; edited versions require review; expired links and archived demos fail closed. Private notes never leave the operator surface. Duplicate generation and engagement requests are idempotent. URL security, validation, CSRF, XSS, expiry, privacy, quota and concurrency tests must pass.

For the live-provider milestones, additionally prove with spies/mocks and staging isolation that no demo can create a production appointment, send a real message, transfer to an owner, or consume unbounded paid usage.
