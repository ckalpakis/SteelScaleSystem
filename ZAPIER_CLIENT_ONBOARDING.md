# Zapier Client Onboarding Guide

Use this guide when a new client wants Steel Scale's voice agent to check a calendar and create appointments through Zapier.

Each client needs **two separate Zaps**:

1. **Availability Zap** — checks the calendar and returns available times to the caller.
2. **Booking Zap** — creates the confirmed appointment.

Do not reuse one Catch Hook for both jobs. Keep the two webhook URLs labeled clearly.

## 1. Information to collect from the client

Before building anything, collect:

- Business name
- Main phone number
- Timezone, such as `America/New_York`
- Services the voice agent may book
- Calendar provider: Google Calendar, Outlook, or another supported system
- Exact calendar to use
- Appointment duration
- Business hours for each weekday
- Minimum scheduling notice
- Time required before or after appointments
- Whether overlapping appointments are allowed
- Staff member or shared calendar responsible for appointments
- Email address that should receive test invitations
- Owner or manager transfer phone number in E.164 format, such as `+15551234567` (optional)
- Whether owner calls should use a blind transfer or a warm transfer with a conversation summary
- Owner notification mobile number in E.164 format
- Which owner SMS alerts to enable: bookings, missed calls, completed calls without bookings, failed bookings, failed transfers, and daily summaries

Confirm that the client has authorized your Zapier connection to read availability and create events on the selected calendar.

## 2. Prepare Steel Scale

Confirm Railway contains:

```env
APP_URL=https://YOUR-RAILWAY-DOMAIN
```

`APP_URL` must be the public HTTPS origin without `/webhooks/vapi`, `/admin`, or a trailing application path.

Deploy the current application and migration before configuring the client:

```bash
npm run prisma:deploy
```

The migration adds the per-client availability webhook and secure callback records.

## 3. Create the Availability Zap

### Step 1 — Catch the request

1. In Zapier, select **Create → Zap**.
2. Name it `CLIENT NAME — Check Calendar Availability`.
3. Choose **Webhooks by Zapier** as the trigger.
4. Choose **Catch Hook**.
5. Copy the generated webhook URL.
6. Keep this URL somewhere labeled `Availability webhook`.

Steel Scale sends these fields:

| Field                  | Meaning                           |
| ---------------------- | --------------------------------- |
| `request_id`           | Unique availability request       |
| `client_id`            | Steel Scale client ID             |
| `business_name`        | Client business name              |
| `preferred_datetime`   | Requested ISO date and time       |
| `timezone`             | Client's configured timezone      |
| `search_days`          | Alternative-search window         |
| `maximum_alternatives` | Maximum alternatives to return    |
| `callback_url`         | One-time Steel Scale response URL |
| `callback_token`       | One-time authentication token     |

### Step 2 — Send Zapier a test request

Temporarily paste the Availability webhook into the client's **Zapier availability webhook URL** field in Steel Scale. Save the client and make a controlled test call, or send a temporary sample containing all fields above.

Return to Zapier and select **Test trigger**. Confirm the sample contains `callback_url`, `callback_token`, `preferred_datetime`, and `timezone`.

### Step 3 — Check Google Calendar

For Google Calendar, add **Google Calendar → Find Busy Periods in Calendar**. Zapier documents this action as finding busy periods within a specified time range.

Configure:

- Calendar: the exact client calendar
- Start time: a reasonable window beginning near `preferred_datetime`
- End time: up to seven days after the requested time

If the calendar provider has a native availability or free-slot action, use that instead. The output must ultimately determine:

- Whether the exact requested time is free
- Up to five nearby free start times

Account for appointment duration, working hours, minimum notice, buffers, and every calendar that can block the assigned team member.

### Step 4 — Calculate the result

Add **Code by Zapier** or appropriate Formatter/Paths steps. Produce:

```json
{
  "requested_available": false,
  "available_slots": ["2026-09-03T16:30:00-04:00", "2026-09-03T17:00:00-04:00"]
}
```

Rules:

- Use a real boolean for `requested_available` when possible. Steel Scale also accepts `"true"` and `"false"`.
- Return slots as ISO 8601 timestamps. `Z` or a numeric timezone offset is accepted.
- Return only genuinely available start times.
- Return no more than five alternatives.
- Sort alternatives from most useful/nearest to later choices when practical.
- Never mark an occupied or out-of-hours time as available.

### Step 5 — Post the result back to Steel Scale

Add **Webhooks by Zapier → POST** as the final action.

Configure:

- URL: map `callback_url` from the Catch Hook
- Payload type: JSON
- `callback_token`: map `callback_token` from the Catch Hook
- `requested_available`: map the calculated boolean
- `available_slots`: map the calculated list of ISO timestamps

Example body:

```json
{
  "callback_token": "{{callback_token from trigger}}",
  "requested_available": false,
  "available_slots": ["2026-09-03T16:30:00-04:00", "2026-09-03T17:00:00-04:00"]
}
```

The callback token is unique to one request, stored by Steel Scale only as a hash, and expires after one minute. Do not replace it with a fixed value.

### Step 6 — Turn on and time the Zap

Test the complete Availability Zap, then publish it. It must post its callback within **20 seconds**. Avoid delays, approvals, long AI actions, and unnecessary steps.

## 4. Create the Booking Zap

### Step 1 — Catch the confirmed booking

1. Create another Zap.
2. Name it `CLIENT NAME — Create Calendar Booking`.
3. Choose **Webhooks by Zapier → Catch Hook**.
4. Copy its separate webhook URL and label it `Booking webhook`.

Steel Scale sends:

| Field                | Map to                         |
| -------------------- | ------------------------------ |
| `caller_name`        | Event/customer name            |
| `caller_phone`       | Description or customer record |
| `address`            | Event location                 |
| `requested_service`  | Event title/description        |
| `preferred_datetime` | Event start time               |
| `business_name`      | Description or routing field   |
| `booking_attempt_id` | Idempotency/reference field    |
| `source`             | Source field or description    |

### Step 2 — Create the calendar event

For Google Calendar, add **Create Detailed Event**. For Outlook, use its create-event action.

Recommended mapping:

- Summary: `requested_service — caller_name`
- Start: `preferred_datetime`
- End: calculate start plus the client's appointment duration
- Description: caller name, phone, service, source, and `booking_attempt_id`
- Location: `address`
- Show as: Busy
- Notifications: according to the client's policy

Use `booking_attempt_id` in any available external-reference or notes field. Steel Scale already prevents the same provider tool request from creating a second BookingAttempt.

### Step 3 — Publish the Booking Zap

Test with non-production data. Confirm that the event appears once, at the correct local time, on the correct calendar. Then publish the Zap.

## 5. Connect both Zaps to the client

1. Open `https://YOUR-RAILWAY-DOMAIN/admin`.
2. Open the client.
3. Set **Destination type** to `Zapier`.
4. Paste the Booking Zap Catch Hook into **Zapier webhook URL**.
5. Paste the Availability Zap Catch Hook into **Zapier availability webhook URL**.
6. Confirm the client's timezone.
7. Enter the **Owner notification number** and select the desired SMS alerts. Leaving the number blank disables all owner notifications.
8. If the client wants live escalation, enter the **Owner transfer number** and select the transfer type. Leave the number blank to disable transfers.
9. Save.

The transfer number must be different from the main AI phone number and must not forward back to it. Otherwise calls can enter a routing loop. Steel Scale supplies this destination directly to Vapi for each call; do not create a Zap or Railway variable for it.

Owner alerts are sent from the client's main Twilio number only after Steel Scale records the outcome. Webhook retries are deduplicated. Successful-booking alerts contain the caller name, callback number, and appointment time; detailed service information remains in the calendar and admin dashboard.

Do not put either Zapier URL in Railway variables. These are stored per client in PostgreSQL.

## 6. Required acceptance tests

Complete all tests before going live.

### Available-time test

1. Request a known open time.
2. Confirm the agent checks availability.
3. Confirm it says the time is available.
4. Confirm the caller's details.
5. Verify exactly one event is created.

### Unavailable-time test

1. Add a blocking event to the calendar.
2. Request that exact time.
3. Confirm the agent does not promise it.
4. Confirm the agent offers real alternatives.
5. Choose one alternative and verify it is created once.

### Outside-hours test

Request a time outside business hours. It must be rejected even if no calendar event occupies it.

### Timezone test

Request “tomorrow at 4:30 PM.” Confirm the resulting event is 4:30 PM in the client's timezone, including across daylight-saving changes.

### Failure test

Temporarily turn off the Availability Zap. The agent must say availability could not be confirmed and must not promise the appointment.

### Owner-transfer test

1. Call the Vapi number and ask to speak with the owner.
2. Confirm the agent asks before transferring instead of transferring immediately.
3. Agree to the transfer and verify the owner phone rings.
4. Confirm Vapi's call log contains a `transferCall` invocation. An `assistant-forwarded-call` end reason means Vapi initiated the transfer; confirm the receiving carrier completed it as well.
5. Decline the transfer on a second test call and confirm the agent continues helping.

### Owner-notification test

1. Enable all owner notification checkboxes and enter a mobile number you can inspect.
2. Complete one test booking and confirm exactly one `NEW BOOKING` SMS arrives.
3. Trigger one missed call and confirm both messages arrive: the existing caller follow-up and the separate owner alert.
4. Open the client in `/admin` and confirm both attempts appear under **Owner notifications** with status `sent`.
5. Trigger `POST /internal/cron/daily-summary` through the configured Railway cron and confirm the owner receives one summary. Repeating the job on the same UTC date must not send a duplicate.

## 7. Troubleshooting

### Agent says availability could not be confirmed

Check:

- The Availability Zap is published.
- The correct Catch Hook is saved on the client.
- Railway `APP_URL` is correct.
- The final POST maps the incoming `callback_url` exactly.
- The final POST echoes the incoming `callback_token` exactly.
- The Zap finishes within 20 seconds.
- Railway deployment logs do not show a callback `401`, `400`, `410`, or timeout.

### Callback returns 401

The token is missing or was not mapped from the trigger. Do not type a fixed token into the POST action.

### Callback returns 410

The Zap took more than one minute or reused an old test payload. Trigger a new request.

### Wrong local time

Confirm:

- Client timezone in Steel Scale
- Calendar timezone
- Zapier account timezone
- The ISO timestamp and offset returned in `available_slots`

### Booking still falls back to GHL

Open the client's **Recent booking attempts** table. The error column shows whether the Booking Zap rejected or timed out. Confirm the Booking webhook—not the Availability webhook—is in **Zapier webhook URL**.

## 8. Client handoff checklist

- [ ] Client authorized the correct calendar account
- [ ] Client timezone verified
- [ ] Appointment duration verified
- [ ] Business hours and buffers verified
- [ ] Availability Zap published
- [ ] Availability callback completes within 20 seconds
- [ ] Booking Zap published
- [ ] Both URLs saved in the correct client fields
- [ ] Available-time test passed
- [ ] Unavailable-time test passed
- [ ] Outside-hours test passed
- [ ] Timezone test passed
- [ ] Duplicate-event test passed
- [ ] GHL safety-net calendar monitored
- [ ] Client knows how to report calendar changes

## References

- [Trigger Zap workflows from webhooks](https://help.zapier.com/hc/en-us/articles/8496288690317-Trigger-Zaps-from-webhooks)
- [Send webhooks from Zap workflows](https://help.zapier.com/hc/en-us/articles/8496326446989-Send-webhooks-in-Zaps)
- [Google Calendar actions available in Zapier](https://zapier.com/apps/google-calendar/integrations)
