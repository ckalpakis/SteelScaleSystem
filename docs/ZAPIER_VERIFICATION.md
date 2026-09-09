# Zapier integration verification

September 8, 2026. Work was performed locally. No production data, Railway deployment,
Zapier account, real CRM or outbound recipient was changed/contacted.

## Implemented changes

- `src/integrations`: scoped inbound/management APIs, field mapping, atomic related-record
  intake, redacted diagnostics, organization/peer rate limiting, encrypted outbound
  destinations, HMAC signing, DNS-pinned HTTPS transport, durable queue/retries, and admin UI.
- Extended canonical intake to reuse native pipeline/stage/conversation rules alongside
  the existing customer/opportunity/estimate/message paths. Existing endpoints remain valid.
- Canonical publication now snapshots opted-in outbound subscriptions in the same database
  transaction. Approved recovery handoffs/action completion and validated assisted-revenue
  evidence publish corresponding facts. They do not claim a message was sent.
- Existing workforce worker can deliver outbound jobs when explicitly enabled. Added
  `WEBHOOK_DELIVERY_ENABLED` and `INTEGRATION_ENCRYPTION_KEY` configuration.
- Additive migration: nullable connection mapping; endpoint, delivery, attempt, diagnostic
  and organization-rate-counter tables. Existing tables/IDs/payloads are preserved.
- The Integrations UI follows the existing navy/steel/white palette, system typography,
  form/table layout and responsive rules, as directed by the frontend-design skill.

## Checks

- Passed: all 17 new tests (6 unit, 11 database/API), type checking, lint, build,
  formatting checks, Prisma schema validation and whitespace checks.
- New unit tests cover mapping, coercion, tenant/prototype rejection, diagnostic redaction,
  encryption/AAD, URL safety, HMAC and backoff.
- Database/API tests cover atomic bundles and rollback, concurrent retries, changed-ID
  conflicts, custom vendor mapping, tenant isolation, revocation/secret visibility,
  pipelines/appointments/messages/invoices/jobs, outbound retries/dead/manual retry,
  encryption, privacy defaults, loop suppression, agent facts, CSRF/roles and rate limits.
  They also cover simultaneous worker claims, expired leases, paused sending, disabled
  destinations and preservation of historical opportunity activity timestamps.
- Full existing regression runner passes all CRM/workforce/event/demo/booking/GHL/admin
  checks, plus new integration suites. It still reports the two pre-existing
  lead-intelligence failures: phase 5 stale-rescore fixture (expected 1, got 0) and phase 9
  rerun-score fixture. These were not suppressed or changed.
- All 24 migrations applied to disposable PostgreSQL 16. A separate populated upgrade
  rehearsal verified unchanged legacy Client/workforce values, identities and event
  payloads/hashes/versions; outbound stores start empty.
- Read-only browser checks pass at desktop (1440px) and mobile (390px), with no page
  errors or document overflow. Browser-created persistent access and real sends are not
  part of this check. The browser skill's connection failed due to an environment issue;
  the repository's installed local Playwright browser was used as a fallback.

Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run format:check`, and
`npm run test:integrations`. Database tests require the existing explicit disposable
loopback database guard; do not run fixture scripts against production. The full runner
disables external providers and sends. The integration suite injects mocked transports.

## Remaining operational work

Deploy first to staging, set a stable encryption key/public origin, configure a destination,
and verify both directions with a real customer-approved Zap before enabling the sender
in production. Receiver-side idempotency is mandatory for downstream messages/actions.
Monitor pending/dead queues and Zapier run history. Native invoice/job CRM domains,
appointment recovery attribution, SSO/session login, bulk replay, editable mapping/destination
configuration and automated encryption-key rotation remain separate increments.
