# Provider-independent communication

`src/communications` owns canonical communication records, transport interfaces, inbound
normalization, suppression and delivery state. Agents do not call vendor APIs. Existing GHL
contact/calendar/booking support is unchanged: repository inspection found no operational GHL
message sender to wrap. The working SMS transport was Twilio, now shared through TwilioSmsProvider.

## Boundaries

MessageProvider identifies a transport; SmsProvider.sendSms and EmailProvider.sendEmail define
typed requests/results. The fixed provider resolver selects installed implementations; neither
an HTTP payload nor a model can register a function, supply an API endpoint or choose credentials.
The transport receives a fixed recipient/body and cannot authorize claims or clear opt-outs.
CommunicationService exposes sendSms, sendEmail and getConversation; processInboundMessage is
the authenticated-adapter entry point. Conversations and messages are read from Steel Scale,
not a vendor CRM. Adding providers changes this layer, not Agent Runtime logic.

Implemented transports: Twilio SMS. Email has a typed interface and an internal sendEmail
entry point, but returns communication_provider_unavailable until an email provider is installed.
LC Phone/GHL, SendGrid, Resend and native email are extension points, not simulated live senders.

There are two deliberate outbound execution paths:

1. Human-authored communication: current member authorization → canonical message/queued ledger
   → worker consent/DND/ownership checks → installed provider → signed delivery status.
2. AI Recovery communication: existing runtime tool → exact-action HumanApproval/Policy Engine
   → RecoveryDispatch + canonical message/ledger → existing certified adapter claim/receipt.

The direct-send queue accepts member-authored messages only; a forged agent actor cannot execute.
Recovery retains its existing adapter protocol and fresh business-knowledge/eligibility checks.
It is not automatically moved onto the native Twilio worker. The generic send_message tool remains
unavailable rather than exposing a new unreviewed AI send path. Recovery internal tools now write
the universal ledger, including pending, claimed, failed, cancelled and reconciled deliveries.
Enabling this feature does not bypass any runtime approval or activate autonomous sending.

## Canonical records

Existing Contact, Conversation and Message models are reused. Message.status remains the CRM
record/draft state: it is **not** proof of transmission. New additive models:

| Model                    | Purpose                                                                                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CommunicationAccount     | Organization/provider/channel/sender configuration, external account identity, encrypted credentials, enabled state and revision.                                                                           |
| CommunicationDelivery    | Message/contact/conversation, organization, provider/connection, external ID, agent/member/system actor, direction, delivery state, timestamps, idempotency fingerprint and optional RecoveryDispatch link. |
| CommunicationAttempt     | Append-only application history of claims, results, failures and provider status notifications.                                                                                                             |
| CommunicationSuppression | Organization/channel/address-hash block that survives duplicate contact creation. No clearing endpoint.                                                                                                     |

Composite foreign keys enforce tenant ownership, the message's actual conversation and that
conversation's contact. Provider/connection relationships are also scoped. Idempotency keys
are unique within an organization; a reused key with changed content fails with 409. Provider
message IDs are secondary identifiers, unique within organization/provider/connection, never
canonical primary keys. RecoveryDispatch retains its existing action/claim idempotency.

The existing RecoveryConsent table remains the single explicit contact/channel consent journal;
CommunicationService reuses it instead of introducing a second competing consent truth. This
legacy storage name is an intentional incremental-refactoring compromise. Native member sends
require granted consent, not merely the presence of a phone/email address. Legacy booking/SMS
retains its existing admission rules, with the new hard suppression check at the transport boundary.

## Inbound processing and opt-outs

Native provider ingress validates the exact configured HTTPS callback URL, all request fields,
account SID and X-Twilio-Signature using the account-specific encrypted secret. Account IDs in
URLs are routing identifiers, not authentication. Missing secrets/signatures never bypass checks.
Requests are rate limited and persisted before acknowledgment. Bodies are capped at 32 KB;
message content at 10,000 characters. No raw payload or provider secret is copied into audit logs.

Every new canonical inbound Message emits customer.message_received with its organization,
message/contact/conversation IDs, provider, external message ID, timestamp and correlation ID.
The existing canonical publisher captures CRM, Zapier/generic webhook and supported native
integration messages into the same ledger. Event and ledger changes commit atomically before
agent jobs run. Duplicate inbound requests produce one message/event; changed replays fail.

Known unique senders reuse scoped contacts/conversations. Unknown senders create canonical
contacts without granting consent. Shared/ambiguous phone identities are recorded against an
unresolved sender instead of assigning engagement to an arbitrary existing customer; review
and merge those records before using them for attribution. This initial version does not infer
customer identity from message content or support attachments/MMS.

STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT/REVOKE and common opt-out phrases, including normalized
Unicode, set contact DND, revoke consent and persist address-level suppression during ingestion.
The native sender and Recovery guard check DND, suppression, active organization/contact,
current channel consent and destination before execution. Duplicate contacts cannot evade an
address block or another matching contact's DND. START is not an automatic canonical opt-in.
No agent tool, human approval or generic consent write can clear DND/suppression. Verified
re-consent needs a separately designed human workflow, not a boolean override.

The Twilio transport maps error 21610 to provider_opt_out and persists suppression. Twilio
documents this error as an unsubscribed recipient; Steel Scale's canonical gate remains
conservative even if the provider later accepts START. [Twilio error 21610](https://www.twilio.com/docs/api/errors/21610).

## Delivery and failure semantics

States: recorded (imported, not asserted sent), received, queued, awaiting_provider (Recovery
adapter), sending, accepted, sent, delivered, failed, unknown and cancelled. Creation/acceptance
is not delivery; only a definitive delivery status sets deliveredAt. This follows the provider's
distinct lifecycle states. [Twilio message statuses](https://www.twilio.com/docs/messaging/api/message-resource).

The workforce worker sends one native message per iteration. Tenant-locked claims serialize
replicas, then network I/O occurs outside the transaction with a ten-second timeout. The sender
rechecks destination, active account/connection, conversation, consent and current member role.
Queued employee messages publish canonical activity so Recovery sees conflicting human action.

Native sends retry only a conclusive not-sent response, at most three transport attempts with
exponential backoff (20s then 40s). Twilio 429/error 20429 is the installed adapter's retryable
case because those requests are documented as not processed. [Twilio retry guidance](https://www.twilio.com/docs/api/errors/20429).
Timeouts, server errors and malformed receipts are unknown, never automatic resend instructions.
Expired sending leases also become unknown. Accepted/sent messages without receipts for 24 hours
become unknown with delivery_receipt_overdue, without retransmission. Late authenticated
definitive receipts can reconcile unknown outcomes. Replayed or out-of-order statuses cannot
downgrade delivered/sent into acceptance. Terminal conflicting receipts remain in attempt history;
they do not silently rewrite confirmed terminal state.

Recent deliveries/errors are available through the API and getConversation history; errors are
sanitized codes. Unknown/failed outcomes are retained, not silently dropped or deleted. There is
no automatic new-message retry with a different idempotency key. Recovery additionally preserves
its human-handoff behavior on unknown/exhausted delivery outcomes.

Safety boundary: a STOP committed before the final send claim blocks it. No application can
recall a request already in flight or a message accepted by a carrier; an opt-out arriving after
that boundary blocks subsequent sends. Keep provider-level opt-out protection enabled too.

## Existing legacy SMS

The original sendSms compatibility function delegates to TwilioSmsProvider, preserving the old
missed-call, booking and employee-notification call sites and dry-run behavior. It always checks
legacy SmsConversation opt-out and existing canonical DND/address blocks on linked Clients,
including when the canonical feature is disabled. Failed booking replies retain their
deduplication records: an ambiguous timeout must not allow replay.
The canonical send gate also checks linked Clients' historical legacy SMS opt-outs, so a new
contact or provider account cannot bypass suppression recorded before this migration.

For Clients explicitly linked through Organization.legacyClientId, enabling communications adds
canonical inbound events and outbound ledger records. Signed legacy STOP is persisted before
webhook acknowledgment even when SMS booking is disabled. Legacy provider receipts use the new
signed /webhooks/twilio/sms-status/:deliveryId endpoint. Existing inbound URL stays unchanged.
Dry runs retain their legacy synthetic SID behavior and are not recorded as real delivery.

Unlinked Clients keep their existing legacy records/workflows; they cannot safely be assigned
an organization automatically. Link and audit those Clients during rollout to obtain canonical
coverage. This is not a destructive backfill or a claim that all historical SMS was migrated.
The legacy reply-generation/admission workflow is unchanged apart from suppression and preserving
failed attempts; it does not gain the new worker's retries or become a universal AI runtime agent.

## API

Management paths are relative to /api/communications. Require current organization-member Bearer
credentials, no Origin header, JSON writes, and existing peer/organization rate limits. Integration
webhook credentials cannot call member management/send routes. Accounts require integrations:write
(owner/admin); sending/consent require crm:write; conversation/activity reads require crm:read.

| Method/path                                          | Contract                                                                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| GET /                                                | Sanitized accounts and 100 recent ledger records.                                                                      |
| POST /accounts                                       | provider: twilio, channel: sms, sender: E.164, accountSid, authToken. Creates disabled account; secret never returned. |
| POST /accounts/:id/enabled                           | enabled and expectedRevision.                                                                                          |
| POST /consent                                        | contactId, channel, granted, evidence. Cannot override suppression.                                                    |
| GET /conversations/:id                               | Canonical conversation, latest 100 messages and up to 20 status-history entries per message.                           |
| POST /sms                                            | conversationId, body (≤1600 characters), idempotencyKey. Returns 202 with queued record, not delivery success.         |
| POST /email                                          | Same request; unavailable until a real EmailProvider is installed. Subject comes from the conversation.                |
| POST /providers/twilio/:accountId/inbound            | Signed Twilio form: AccountSid, MessageSid, From, To, Body.                                                            |
| POST /providers/twilio/:accountId/status/:deliveryId | Signed Twilio status notification.                                                                                     |

Example member send:

```json
{
  "conversationId": "<canonical-conversation-uuid>",
  "body": "Our team will contact you about your request.",
  "idempotencyKey": "employee-reply-2026-09-08-001"
}
```

Accounts use the existing AES-256-GCM INTEGRATION_ENCRYPTION_KEY, with organization/account
authenticated context. Credentials are encrypted, not hashed, because the transport needs them;
membership/API keys retain existing hash-only storage. Provider credentials, message bodies and
Prisma parameter dumps are redacted from generic communication logs. Native URLs are fixed Twilio
HTTPS endpoints with redirects disabled; no model-supplied fetch URL is accepted. Signature
validation includes all incoming fields. [Twilio webhook security](https://www.twilio.com/docs/usage/webhooks/webhooks-security).

Initial account management supports one account per organization/channel. Sender/account identity
is immutable through this API. Secret rotation, multi-sender routing, provider reconciliation
polling, retention/erasure tooling and an activity UI remain follow-on work; do not manipulate
encrypted configuration ad hoc while sends or receipts are unresolved.

## Migration, rollout and rollback

1. Back up production and rehearse 20260909150000_communication_layer in staging. It atomically
   adds four tables and tenant-composite indexes to existing Message/Conversation, with a five-second
   lock timeout. There are no row deletions, renames or automatic tenant/contact backfills.
2. Deploy matching Prisma client/code. Both new flags default false: COMMUNICATIONS_ENABLED
   (API, canonical ledger/bridges) and COMMUNICATION_DELIVERY_ENABLED (native worker sends).
   Existing Twilio and Recovery delivery flags retain their independent meanings.
3. Set WORKFORCE_ENABLED, a valid INTEGRATION_ENCRYPTION_KEY and public HTTPS APP_URL in staging.
   Configure a test account, set the signed inbound URL in Twilio, then explicitly enable it.
   Link legacy Clients only after reviewing tenant ownership and avoiding duplicate ingress routes.
4. Use fake-provider tests first. Certify one native account's actual signatures, DND, receipt
   replay and unknown-outcome handling before enabling COMMUNICATION_DELIVERY_ENABLED on the
   existing workforce worker. No live sends, credential installs or deployment occurred here.
5. Keep web/worker feature configuration consistent. To pause new native sending, disable its
   delivery flag/account while leaving ingress active to continue recording opt-outs and receipts.
   This flag does not stop legacy Twilio workflows or the separate Recovery adapter; pause those
   through their existing controls as needed. Do not drop tables to roll back behavior.

Run test:communications, test:communications:integration, test:recovery:communications,
test:regressions, typecheck, lint, build and format:check. DB checks require an explicit loopback
steel_scale_demo_*test database and NODE_ENV=test. Providers are fake/dry-run; no paid messages.
See [verification](COMMUNICATIONS_VERIFICATION.md).

Next increment: certify a native Recovery-to-provider adapter that consumes the existing
exact-action claim/receipt protocol, then add an EmailProvider with authenticated inbound/status
translation. Preserve approved knowledge and Policy Engine checks; do not simply enable the
generic send_message tool or route AI output through the human-send endpoint.
