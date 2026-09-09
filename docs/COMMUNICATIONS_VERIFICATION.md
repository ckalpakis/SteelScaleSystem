# Communication layer verification

Verified locally on 2026-09-08. No production database, Railway deployment, provider account
configuration, live SMS/email or paid model call was performed. Existing uncommitted platform
increments were preserved. Local databases contain fictional fixtures and were not reset/deleted.

## Implemented changes

- `src/communications`: MessageProvider/SmsProvider/EmailProvider contracts, Twilio SMS transport,
  member communication service/API, scoped canonical ledger, inbound publication, hard suppression,
  authenticated status webhooks, bounded sender worker and legacy bridges.
- Additive atomic migration: CommunicationAccount, CommunicationDelivery, CommunicationAttempt,
  CommunicationSuppression; composite Message/Conversation identity indexes; scoped foreign keys,
  uniqueness and status/attempt checks. Existing CRM identity triggers are reused.
- Existing Twilio compatibility function delegates to the adapter. Legacy STOP is stored before
  webhook acknowledgment, even with booking disabled. Failed booking replies retain their dedupe
  record. Linked legacy Clients gain canonical message records and signed delivery callbacks.
- Recovery internal tools/handoffs create queued ledger records; claims, receipts, cancellation,
  changed configuration and expired claims update them. Policy/approval/knowledge gates remain.
- Default-off flags, worker mounting, safe logging, regression scripts and architecture docs.

## Results

| Check                                               | Result                                                                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Communication unit tests                            | 17 passed.                                                                                                                                 |
| Communication PostgreSQL/API tests                  | 18 passed.                                                                                                                                 |
| Existing Recovery tests with communications enabled | All 30 passed.                                                                                                                             |
| Final populated migration rehearsal                 | All 29 migrations applied; existing legacy/client, workforce, canonical identities, provider mappings and historical event data preserved. |
| Final expanded regression suite                     | 40 of 42 commands passed. Only the two previously documented lead-intelligence failures remain.                                            |
| Typecheck, lint, build, format check                | Passed.                                                                                                                                    |
| Prisma format/generate/validate                     | Passed.                                                                                                                                    |
| git diff --check                                    | Passed.                                                                                                                                    |

The final rehearsal/regressions used newly created steel_scale_demo_communication_final_test
on local PostgreSQL. Earlier dedicated checks used the already isolated knowledge test database.
After the full regression run, the communication integration suite and quality checks were rerun
for the final paused-organization ingress and historical legacy opt-out safeguards.
The test runner disables provider credentials, uses fake transports/dry runs, and refuses
non-loopback databases or names outside steel_scale_demo_*test.

Unrelated existing failures:

- test:lead-intelligence-phase-5: stale enrichment rescore expects 1, receives 0.
- test:lead-intelligence-phase-9: idempotent rerun creates another score.

Legacy missed-call, booking, Vapi, chatbot, admin, summary, GHL availability and demo checks
passed. Workforce, CRM, events, integrations, agent runtime, builder, knowledge and Recovery
checks passed, including the new communications-enabled Recovery variant.

## Coverage

Tests verify duplicate sends/webhooks, mismatched idempotency content, provider acceptance versus
delivery, concurrent claims, tenant-scoped reads/writes/SQL links, synchronous canonical STOP,
Unicode/common opt-out phrases, duplicate-address suppression, forbidden consent overrides,
paused-account ingress, source/destination changes, disabled accounts, revoked members, invalid
agent actors, missing providers, signature forgery, cross-account callbacks, secret redaction,
monotonic receipt replay, unknown outcomes, expired leases, bounded safe retry/backoff,
missing-receipt reconciliation, employee activity and both legacy/canonical DND paths.

Recovery's enabled-mode tests retain their no-delivery assertion using ledger delivery evidence:
a queued/cancelled Message now exists internally by design, without deliveredAt or transmission.
This replaces the old assumption that the absence of any Message record proved no send. STOP
can now report opt_out immediately instead of waiting for unprocessed_opt_out detection.
Default-off tests keep the original expectations.

## Scope and remaining rollout work

This is a backend increment; no frontend/browser changes were requested. HTTP tests exercised
real local Express routes, member authentication and signed provider callbacks. No UI screenshots
or browser verification are claimed.

Live provider behavior has not been certified with a real Twilio account. Email implementations,
native Recovery adapter certification, credential rotation, verified re-consent, multi-sender
routing and an operations UI are follow-on work. The native worker sends human-authored messages;
Recovery retains the existing separately certified claim/receipt adapter. Unlinked legacy Clients
are not assigned tenants automatically. See [COMMUNICATIONS.md](COMMUNICATIONS.md) before rollout.

## Reproduce

Use explicit NODE_ENV=test and a loopback DATABASE_URL naming a disposable steel_scale_demo_*test
database. The migration rehearsal requires a new empty database; it creates populated historical
fixtures before upgrading. Do not run test seeds or a reset against production.

```bash
npm run test:crm:migration
npm run test:regressions
npm run test:communications
npm run test:communications:integration
npm run test:recovery:communications
npm run typecheck
npm run lint
npm run build
npm run format:check
npx prisma validate
```

The two communication flags default off. To pause native sends later, disable delivery while
retaining ingress for STOP/receipts; existing legacy and Recovery sender controls are separate.
