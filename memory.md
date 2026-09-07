This project is a lightweight, client-agnostic missed-call and booking
automation system for home service businesses (HVAC, plumbing, electrical,
roofing) doing $1-5M/year revenue.

CORE FLOW:

1. A call comes into a client's business phone number.
2. If unanswered/missed, the system immediately texts the caller back.
3. A voice AI agent (Vapi or Retell) can also answer calls live, qualify
   the caller, and book an appointment.
4. A chatbot embedded on the client's website can also qualify and book.
5. When an appointment is booked (via voice AI or chatbot), the system
   writes it to wherever the client's calendar/CRM actually lives:
   - If the client uses Housecall Pro, Jobber, ServiceTitan, etc., we
     push the booking via a Zapier webhook that fires into their existing
     Zapier integration for that tool.
   - If the client has no compatible tool, we fall back to writing the
     appointment directly into a GoHighLevel (GHL) calendar we control.

ARCHITECTURE PRINCIPLES:

- Multi-tenant from day one. Every client has a config record (business
  name, services, phone number, voice AI agent ID, destination type:
  "zapier" or "ghl_fallback", relevant webhook URLs/API keys).
- No client-specific code. All client differences live in config/database,
  not in branching logic scattered through the codebase.
- Every external call (Twilio, Vapi/Retell, Zapier, GHL) must be wrapped,
  logged, and fail loudly — a missed webhook here means a missed job for
  a real business, so silent failures are not acceptable.
- Stack: Node.js + TypeScript, Express, PostgreSQL (or SQLite for local
  dev), Twilio for telephony/SMS, Vapi or Retell for voice AI, Zapier
  webhooks (Catch Hook) as the CRM bridge, GHL API as fallback calendar.
- Deploy target: Railway or Render. Environment variables for all secrets,
  never hardcoded.

Work in small, testable increments. After each phase, stop and tell me
what to test manually before continuing.

## Approved business direction — on-demand sales demos (2026-09-07)

Steel Scale Systems owns and operates the demo engine for its own prospects and clients.
Do not build agency white-label resale, reseller billing, or an agency tenant hierarchy.
Lead scraping, enrichment, scoring, and normal outreach MUST NOT create demos, run demo
research, provision voice agents, or incur demo model/provider costs.

Demo creation is an explicit operator action: either enter business information manually
or prefill from an existing ProspectBusiness. A demo may exist without a prospect or Client.
Use website/GBP/niche/location/verified services and hours as available. Store private sales
notes separately from the public presentation. Never invent hours, pricing, reviews, audit
scores, local rankings, missed-lead counts, or revenue from a URL or niche alone.

Workflow: interested prospect -> Create Demo -> input/context -> draft generation ->
operator review -> explicit publish -> manually share link -> engagement -> sales call.
Production onboarding is a separate approved process; demo activity must never send real
SMS, place real calls, create live bookings, or automatically convert/create a Client.

The initial implementation contains guided simulations, bounded homepage research,
ROI scenarios, optional prospect linking, review/publishing and engagement events.
Live browser voice, live AI chat, review automation, verified GBP enrichment, score/call-queue
integration and the client portal are separate milestones, not completed features.
See docs/STEEL_SCALE_DEMO_ENGINE.md and docs/DEMO_ENGINE_ROLLOUT.md. Keep
DEMO_ENGINE_ENABLED=false until migration, application integration and staging tests pass.
