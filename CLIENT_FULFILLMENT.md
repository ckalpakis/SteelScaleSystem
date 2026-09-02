# Client Fulfillment SOP

This is the repeatable operating procedure for onboarding, configuring, testing, launching, and maintaining one client. Use a separate checklist or ticket for every client and record evidence for every acceptance test.

## 1. Fulfillment outcome

A client is fulfilled only when:

- Their real phone number maps to the correct tenant.
- Their business information and services are accurate.
- Missed calls receive approved SMS copy.
- Their Vapi assistant answers with the correct prompt.
- Voice and chatbot bookings use the shared booking workflow.
- Bookings arrive in Zapier or GHL.
- GHL safety-net delivery and Slack alerting are operational.
- The client has approved a complete test from lead entry to calendar record.

Do not call a client “live” merely because their database record exists.

## 2. Create the fulfillment workspace

For each client, create one internal fulfillment record containing:

- Client legal and display name.
- Primary contact name, email, and phone.
- Escalation contact.
- Website URL and website administrator.
- Main business phone number in E.164 format.
- Business timezone.
- Services offered.
- Service area and address requirements.
- Operating hours and after-hours behavior.
- Booking rules and appointment duration.
- CRM/calendar destination.
- Twilio, Vapi, GHL, and Zapier ownership.
- Launch date.
- Test evidence and approval status.

Never store API tokens or passwords in the fulfillment record. Store credentials only in the appropriate provider or Railway secret store.

## 3. Client discovery call

Collect and confirm the following.

### Business identity

- Exact customer-facing business name.
- Main phone number.
- Timezone.
- Website domain.
- List of services, using the client's language.
- Service-area limitations.

### Lead qualification

- Which services should the AI book directly?
- Which requests should be rejected or escalated?
- Is a service address always required?
- What information must be collected before booking?
- What should happen for emergencies?
- What promises must the AI never make?

### Scheduling

- Calendar or CRM destination.
- Appointment duration.
- Minimum notice.
- Working hours.
- Blackout periods.
- Whether requested times are confirmed or treated as requests.
- Who handles manually recovered leads.

### Messaging and voice

- Approved missed-call SMS wording.
- Approved greeting.
- Desired tone.
- Pronunciation guidance.
- Required disclaimers.
- Escalation or transfer behavior.

Document the client's explicit approval of the final SMS and voice prompt.

## 4. Decide the booking destination

Choose one active primary destination.

### Zapier

Use Zapier when the client's CRM or field-service platform is supported through an existing Zapier workflow and direct calendar creation is not required from this application.

Required client configuration:

- `destination_type=zapier`
- A production Zapier Catch Hook URL.

### GHL fallback as the primary destination

Use GHL when the appointment should be written directly to a client's GHL calendar.

Required client configuration:

- `destination_type=ghl_fallback`
- The client's production GHL calendar ID.

The system-wide `GHL_FALLBACK_CALENDAR_ID` remains the final safety net when the client's primary route fails.

## 5. Build the client's Zapier workflow

Skip this section when GHL is the primary destination.

1. Sign in to the client's approved Zapier account.
2. Create a new Zap.
3. Select **Webhooks by Zapier** as the trigger.
4. Select **Catch Hook**.
5. Copy the webhook URL.
6. Keep the Zap editor open while configuring the client.
7. Send a controlled test booking through the application.
8. In Zapier, click the option to find/test the request.
9. Confirm these fields arrived:

   - `booking_attempt_id`
   - `client_id`
   - `business_name`
   - `caller_name`
   - `caller_phone`
   - `address`
   - `requested_service`
   - `preferred_datetime`
   - `source`
   - `received_at`

10. Add the CRM/calendar action.
11. Map every field deliberately.
12. Add a client-visible note that identifies Steel Scale as the source.
13. Test the action.
14. Confirm the record in the actual destination, not only in Zapier's test screen.
15. Publish the Zap.
16. Record the Zap name and owner in the fulfillment record.

Do not paste a Zapier test URL or an unpublished Zap into production configuration.

## 6. Create the client in the admin panel

Open `APP_URL/admin`, authenticate, and click **Add client**.

Enter:

1. **Business name** — exact approved display name.
2. **Main phone number** — E.164 format, for example `+15551234567`.
3. **Timezone** — IANA value such as `America/New_York`.
4. **Services** — comma-separated or one per line.
5. **Missed-call SMS template** — approved copy using `{business_name}` where appropriate.
6. **Destination type** — Zapier or GHL fallback.
7. **Zapier webhook URL** or **GHL calendar ID**.
8. **Voice provider** — Vapi.
9. **Agent ID** — production Vapi assistant ID.
10. **Provider phone number ID** — production Vapi phone-number ID.
11. **System prompt** — approved client-specific behavior.

Save the record and copy the client UUID. Use that UUID for the website chatbot.

## 7. Write the voice-agent prompt

The prompt must include:

- The business name through `{business_name}`.
- Services through `{services}`.
- A concise greeting.
- Qualification questions.
- Name, callback number, address, requested service, and preferred time collection.
- A read-back and explicit confirmation step.
- An instruction to call `create_booking` only after confirmation.
- An instruction never to claim success unless the tool reports acceptance.
- Client-specific restrictions and escalation rules.

Review the prompt for unsupported claims. The agent must not invent pricing, availability, guarantees, licenses, or service coverage.

## 8. Configure Vapi

1. Create or duplicate a production assistant for the client.
2. Apply the approved voice, greeting, and prompt strategy.
3. Open **Advanced → Webhook Server**.
4. Set the URL to `APP_URL/webhooks/vapi`.
5. Attach the Bearer credential matching the Railway `VAPI_WEBHOOK_SECRET`.
6. Set a request timeout of at least 30 seconds.
7. Enable `status-update`, `end-of-call-report`, and `tool-calls`.
8. Assign the assistant to the client's Vapi phone number.
9. Publish changes.
10. Copy the exact assistant and phone-number IDs into `/admin`.

If a phone number dynamically requests its assistant from the server, configure the webhook at the phone-number level and do not attach a fixed assistant.

## 9. Configure Twilio missed-call callbacks

The missed-call endpoint records status and sends SMS. It does not answer calls.

1. Open the client's active Twilio number.
2. Preserve the existing incoming call handler under **A call comes in**.
3. Configure the final/dial-leg status callback as:

   ```text
   POST APP_URL/webhooks/twilio/voice-status
   ```

4. Ensure the call flow reports `busy`, `canceled`, `failed`, `no-answer`, or answering-machine results.
5. Confirm the Twilio number matches the client phone number in `/admin` exactly.
6. Confirm the production Railway service uses the correct Twilio account SID and auth token.

When a Vapi number is imported from Twilio, do not overwrite Vapi's incoming voice routing. Attach status reporting only in a way supported by the active Twilio/Vapi call flow.

## 10. Install the chatbot

Provide the client's web administrator with:

```html
<script
  src="APP_URL/widget/chatbot-widget.js"
  data-api-base="APP_URL"
  data-client-id="CLIENT_UUID"
></script>
```

Replace `APP_URL` and `CLIENT_UUID` before delivery.

Install it before the closing `</body>` tag or through the client's tag manager/custom-code area. Confirm that security or caching plugins do not strip the tag.

## 11. Internal acceptance testing

Use clearly fake customer data and a phone number you control.

### Test A: Client isolation

- Call and message the client's real number.
- Confirm logs appear under the correct client only.
- Confirm the business name and services are correct.

### Test B: Vapi information collection

- Ask for a supported service.
- Provide name, phone, address, and preferred time.
- Correct one detail mid-call.
- Confirm the agent reads back the corrected information.
- Confirm it does not book before explicit approval.

### Test C: Voice booking

- Approve the booking.
- Confirm a successful `BookingAttempt` with source `voice`.
- Confirm the destination received the booking.
- Confirm date, timezone, phone, address, and service are correct.

### Test D: Missed-call SMS

- Produce a genuine no-answer status through the configured call flow.
- Confirm exactly one SMS is sent.
- Confirm the approved business name and copy are used.
- Confirm `CallLog.smsAttemptStatus` is `sent`.

### Test E: Chatbot qualification

- Open the widget on desktop and mobile.
- Submit incomplete information and verify it asks follow-up questions.
- Complete and approve a booking.
- Confirm a successful `BookingAttempt` with source `chatbot`.
- Confirm it reaches the same destination as voice.

### Test F: Primary routing failure

- Only in a controlled test environment, temporarily use a failing destination.
- Confirm the primary route is attempted twice.
- Confirm the GHL safety-net appointment is created.
- Confirm the attempt is marked for manual follow-up.
- Restore the production destination immediately.

### Test G: Total failure alert

- Use the automated local simulator rather than deliberately breaking production.
- Confirm `npm run test:booking-routing` produces one Slack alert in its mock receiver.
- Send the protected daily summary and confirm the real Slack channel receives it.

## 12. Client acceptance test

Schedule a live screen-share or call with the client.

Demonstrate:

1. A Vapi call using a test lead.
2. The resulting calendar or CRM record.
3. A missed-call SMS.
4. A chatbot conversation and booking.
5. The client-specific greeting, services, and SMS copy.

Ask the client to verify:

- Business name and pronunciation.
- Services and qualification behavior.
- Date/time interpretation.
- Destination record placement.
- Notification recipients.
- SMS language.

Record written approval and every requested change.

## 13. Launch procedure

1. Resolve every acceptance-test issue.
2. Re-run the affected test.
3. Confirm both production dry-run flags are `false`.
4. Confirm the Zap is published or GHL calendar is active.
5. Confirm Vapi changes are published.
6. Confirm the Twilio callback is saved.
7. Publish the chatbot script on the production website.
8. Place one final controlled call and chatbot booking.
9. Mark the client live with timestamp and operator name.
10. Monitor logs, Slack, and the destination closely for the first business day.

## 14. Client handoff

Give the client a short operating guide containing:

- What the voice agent and chatbot do.
- Where bookings appear.
- What a safety-net/manual-follow-up booking means.
- Who receives alerts.
- Who to contact for changes or incidents.
- How quickly they must respond to unconfirmed leads.

Do not give clients Railway, global GHL safety-net, or cross-client admin access unless your access model is intentionally changed first. The current `/admin` panel is an internal operator tool, not a tenant-isolated client portal.

## 15. First-week monitoring

For the first seven days:

- Review every call and booking daily.
- Compare booking records to destination records.
- Review misunderstood services or names.
- Check duplicate messages or appointments.
- Check timezone handling.
- Check all safety-net and failed attempts.
- Adjust prompts only after documenting the reason.

Tell the client when a prompt or routing change is released.

## 16. Ongoing fulfillment

### Daily

- Read the Slack summary.
- Recover failed leads immediately.
- Check manual-follow-up bookings.

### Weekly

- Review per-client call and booking history.
- Check Zapier task failures.
- Check Twilio messaging delivery and balance.
- Check Vapi call errors and balance.
- Check LLM usage and errors.
- Confirm GHL API access is still valid.

### Monthly

- Review service list and business hours with the client.
- Review call outcomes and booking conversion.
- Remove stale credentials and users.
- Test one voice, missed-call, and chatbot flow.
- Confirm the escalation contact is current.

## 17. Change-management procedure

For every requested change:

1. Record the exact request and client approval.
2. Identify whether it affects prompts, services, SMS, phone routing, calendar routing, or website code.
3. Make the smallest scoped change.
4. Test with fake lead data.
5. Confirm no other client's configuration changed.
6. Release the change.
7. Record the completion time and test evidence.

Never reuse another client's webhook URL, calendar ID, assistant ID, phone-number ID, or chatbot UUID.

## 18. Offboarding procedure

When a client leaves:

1. Agree on an exact shutdown time.
2. Export any records the agreement requires.
3. Remove the chatbot embed from their website.
4. Disconnect Vapi and Twilio callbacks without disrupting number ownership.
5. Turn off the client's Zap.
6. Revoke client-specific credentials.
7. Retain or delete call and booking records according to the contract and privacy policy.
8. Document completion.

The current admin panel has no delete action. Database deletion or retention work must follow an approved operational procedure rather than ad hoc manual commands.

## 19. Per-client completion checklist

- [ ] Discovery information complete.
- [ ] SMS copy approved.
- [ ] Voice prompt approved.
- [ ] Destination selected.
- [ ] Zap published or GHL calendar confirmed.
- [ ] Client created in `/admin`.
- [ ] Phone number uses exact E.164 format.
- [ ] Services and timezone verified.
- [ ] Vapi assistant and phone IDs verified.
- [ ] Vapi webhook and credential configured.
- [ ] Twilio status callback configured correctly.
- [ ] Chatbot installed with correct client UUID.
- [ ] Voice booking passed.
- [ ] Missed-call SMS passed.
- [ ] Chatbot booking passed.
- [ ] Destination record verified.
- [ ] Safety-net behavior verified.
- [ ] Slack summary verified.
- [ ] Client acceptance completed.
- [ ] Written approval recorded.
- [ ] First-week monitoring assigned.
