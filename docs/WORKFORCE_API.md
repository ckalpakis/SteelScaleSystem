# Workforce foundation: local/staging API examples

The v1 transport examples below remain supported. New imports now publish canonical v2
facts; see [universal events](EVENT_ARCHITECTURE.md) for normalized relay endpoints,
GHL translation, handler receipts and event metadata. Do not dual-feed v1 and v2 endpoints.

This API is separate from the production booking/availability Zaps. First apply the
migration to an isolated/staging database and enable `WORKFORCE_ENABLED=true`. See
[ARCHITECTURE.md](ARCHITECTURE.md) for security, limits and the Railway worker rollout.
Use a terminal or trusted server; this milestone does not accept browser Origin requests.

## 1. Provision an organization

Using the existing operator Basic credentials, send `POST /api/workforce/organizations`:

```json
{
  "name": "Example Home Services",
  "ownerSubject": "operator-provisioned:example-owner"
}
```

An optional `legacyClientId` links an existing Client without copying or changing its
data. Omit it for a standalone organization. Save the returned `token`, `credentialId`
and `expiresAt`. The token is shown only when issued, lasts 90 days, and serves as the
owner's API credential in this milestone. All following owner requests use
`Authorization: Bearer <owner-token>` and `Content-Type: application/json`.

## 2. Connect Zapier or a generic webhook

Send `POST /api/workforce/integrations` with the owner credential:

```json
{ "name": "Estimate updates from Zapier", "provider": "zapier" }
```

Use `generic_webhook` for another server that can send JSON. Save the returned integration
ID and its separate intake token. In Zapier, configure **Webhooks by Zapier → Custom Request**
to POST to `https://<your-host>/api/workforce/webhooks/<integration-id>` with:

```text
Content-Type: application/json
Authorization: Bearer <integration-intake-token>
```

The intake token is limited to that integration and organization. Do not put the owner
credential or a token in a URL/query string. No GHL account, calendar or API key is involved.
This guide describes the HTTP contract; it does not create or publish a Zap for you.

## 3. Import a customer, then an opportunity

First send the customer envelope to the integration endpoint:

```json
{
  "id": "customer-482-revision-1",
  "version": 1,
  "type": "customer.upserted",
  "occurredAt": "2026-09-08T12:00:00Z",
  "data": {
    "externalId": "customer-482",
    "name": "Example Customer",
    "email": "customer@example.test",
    "phone": "+15555550123"
  }
}
```

Then send the estimate envelope to the same endpoint:

```json
{
  "id": "estimate-907-revision-1",
  "version": 1,
  "type": "opportunity.upserted",
  "occurredAt": "2026-09-08T12:01:00Z",
  "data": {
    "externalId": "estimate-907",
    "customerExternalId": "customer-482",
    "title": "Water heater replacement",
    "status": "estimate_sent",
    "amountMinor": 325000,
    "currency": "USD",
    "lastActivityAt": "2026-08-20T15:00:00Z"
  }
}
```

Map timestamps and identifiers from the actual source; the dates above are examples.
For USD, 325000 minor units means $3,250.00. Retain exactly the same event ID/body on a
retry. Use a new event ID and later source timestamp for an update; do not generate a fresh
ID for each retry. Customer/opportunity `externalId` stays stable over their lifetime.

Without an external CRM, send these same envelopes to `POST /api/workforce/customers`
and `POST /api/workforce/opportunities` using the owner credential. Those records share
the `internal` namespace; webhook records use the integration's namespace. Data from
different integrations is not automatically merged by email or phone.

Expected responses: 201 for direct CRM creation/intake, 202 for webhook intake, 200 for
an identical duplicate, 400 for invalid payload, 401/403 for credential/scope failure,
409 for a conflicting replay or missing customer. Import the customer before retrying a
missing-customer opportunity. Older/equal observations are retained but not projected;
inspect `applied: false`. A stale/no-op event does not start agent work.

## 4. Configure the first recovery agent

Optionally call `POST /api/workforce/agents/propose` with
`{"description":"Help my team follow up on unsold estimates after seven days."}`.
This returns **template defaults**, not AI interpretation, and requires review.

Create the reviewed agent with `POST /api/workforce/agents`:

```json
{
  "name": "Revenue Recovery",
  "description": "Help my team follow up on unsold estimates after seven days.",
  "config": {
    "version": 1,
    "staleAfterDays": 7,
    "maxCandidates": 50,
    "allowedTools": ["recovery.prepare_handoff"],
    "requireApproval": true
  }
}
```

The agent starts disabled. Activate with `PATCH /api/workforce/agents/<agent-id>`:

```json
{ "expectedVersion": 1, "enabled": true }
```

The response contains its new `configVersion`. Use that version on later changes.
Start the separate worker with both flags true and `npm run start:workforce-worker`
after building. It schedules hourly scans automatically. For an immediate scan, POST
to `/api/workforce/recovery/scan` using an owner/admin credential:

```json
{
  "id": "manual-scan-1",
  "version": 1,
  "type": "recovery.scan.requested",
  "occurredAt": "2026-09-08T12:05:00Z",
  "data": {}
}
```

## 5. Review handoffs and inspect results

`GET /api/workforce/approvals` lists the action, draft and status. Send
`POST /api/workforce/approvals/<approval-id>/decision`:

```json
{ "decision": "approve", "reason": "Reviewed customer and estimate; prepare the team handoff." }
```

Use `reject` to decline. Always inspect `executed` and the returned approval status:
expired, suppressed, disabled, changed or closed records cannot execute. An approved
handoff has `deliveryStatus: "not_sent"`. A human must perform the actual follow-up.
There is no SMS/email delivery adapter in this foundation, and no automatic estimate changes.

Inspect `/events`, `/jobs`, `/runs`, `/audit`, `/customers` and `/opportunities` for the
organization's persisted evidence. The read limit is 100 rows; continue supported lists
with `?after=<last-id>`. Dead jobs can be requeued through
`POST /jobs/<job-id>/retry` with `{"reason":"Cause fixed; retry evaluation."}`.

Revenue is entered separately through `/revenue` only after a completed handoff, a won
opportunity and actual operator-provided payment evidence. It is labeled assisted revenue,
not automatically proven recovery. Rotating an intake token via
`POST /credentials/<credential-id>/rotate` with `{}` revokes the old token immediately;
update the Zap's Authorization header with the returned replacement. Revoke using the
corresponding `/revoke` endpoint when disconnecting.
