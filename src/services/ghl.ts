import { env } from '../config/env.js';
import type { InternalBookingRequest } from '../types/booking.js';
import { logger } from '../utils/logger.js';

interface GhlBookingResult {
  appointmentId: string;
}

export interface GhlAvailabilityResult {
  requestedTime: string;
  requestedAvailable: boolean;
  availableSlots: string[];
  calendarId: string;
  timezone: string;
}

function requireGhlConfig(): { apiKey: string; locationId: string } {
  if (!env.GHL_API_KEY || !env.GHL_LOCATION_ID) {
    throw new Error('GHL_API_KEY and GHL_LOCATION_ID are required for GHL delivery');
  }
  return { apiKey: env.GHL_API_KEY, locationId: env.GHL_LOCATION_ID };
}

async function ghlRequest(
  path: string,
  body: Record<string, unknown>,
  context: { clientId: string; bookingAttemptId: string },
): Promise<Record<string, unknown>> {
  const { apiKey } = requireGhlConfig();
  let response: Response;
  try {
    response = await fetch(`${env.GHL_API_BASE_URL.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        version: 'v3',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error: unknown) {
    logger.error({ err: error, ...context, attempted: `ghl:${path}` }, 'GHL API request failed');
    throw error;
  }
  const rawBody = await response.text();
  let parsed: unknown;
  try {
    parsed = rawBody ? (JSON.parse(rawBody) as unknown) : {};
  } catch {
    parsed = { raw: rawBody.slice(0, 1_000) };
  }
  if (!response.ok) {
    logger.error(
      { ...context, attempted: `ghl:${path}`, status: response.status, responseBody: parsed },
      'GHL API rejected request',
    );
    throw new Error(`GHL returned HTTP ${response.status}: ${JSON.stringify(parsed)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('GHL returned an invalid JSON response');
  }
  return parsed as Record<string, unknown>;
}

async function ghlGet(
  path: string,
  query: Record<string, string>,
  context: { clientId: string; attempted: string },
  fetcher: typeof fetch,
): Promise<Record<string, unknown>> {
  const { apiKey } = requireGhlConfig();
  const url = new URL(`${env.GHL_API_BASE_URL.replace(/\/$/, '')}${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, version: 'v3' },
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error: unknown) {
    logger.error({ err: error, ...context }, 'GHL availability request failed');
    throw error;
  }
  const body: unknown = await response.json();
  if (!response.ok) {
    logger.error({ ...context, status: response.status }, 'GHL availability rejected');
    throw new Error(`GHL availability returned HTTP ${response.status}`);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('GHL availability returned invalid JSON');
  }
  return body as Record<string, unknown>;
}

export async function getGhlCalendarAvailability(
  input: {
    calendarId: string;
    clientId: string;
    preferredTime: string;
    timezone: string;
    rangeDays?: number;
  },
  fetcher: typeof fetch = fetch,
): Promise<GhlAvailabilityResult> {
  const requestedTimestamp = Date.parse(input.preferredTime);
  if (!Number.isFinite(requestedTimestamp)) throw new Error('Preferred time must be ISO 8601');
  const rangeDays = Math.min(14, Math.max(1, input.rangeDays ?? 7));
  const start = Math.max(Date.now(), requestedTimestamp - 12 * 3_600_000);
  const end = start + rangeDays * 86_400_000;
  const availability = await ghlGet(
    `/calendars/${encodeURIComponent(input.calendarId)}/free-slots`,
    {
      startDate: String(start),
      endDate: String(end),
      timezone: input.timezone,
    },
    { clientId: input.clientId, attempted: 'ghl:calendar_availability' },
    fetcher,
  );
  const slots = Object.values(availability)
    .flatMap((rawDay): string[] => {
      if (!rawDay || typeof rawDay !== 'object' || Array.isArray(rawDay)) return [];
      const rawSlots = (rawDay as Record<string, unknown>).slots;
      return Array.isArray(rawSlots)
        ? rawSlots.filter((slot): slot is string => typeof slot === 'string')
        : [];
    })
    .filter((slot) => Number.isFinite(Date.parse(slot)))
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  const requestedAvailable = slots.some(
    (slot) => Math.abs(Date.parse(slot) - requestedTimestamp) < 60_000,
  );
  const nearby = [...slots]
    .sort(
      (left, right) =>
        Math.abs(Date.parse(left) - requestedTimestamp) -
        Math.abs(Date.parse(right) - requestedTimestamp),
    )
    .slice(0, 5)
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  return {
    requestedTime: input.preferredTime,
    requestedAvailable,
    availableSlots: requestedAvailable
      ? [
          input.preferredTime,
          ...nearby.filter((slot) => Math.abs(Date.parse(slot) - requestedTimestamp) >= 60_000),
        ].slice(0, 5)
      : nearby,
    calendarId: input.calendarId,
    timezone: input.timezone,
  };
}

export async function createGhlAppointment(
  calendarId: string,
  bookingAttemptId: string,
  businessName: string,
  request: InternalBookingRequest,
): Promise<GhlBookingResult> {
  const { locationId } = requireGhlConfig();
  const context = { clientId: request.clientId, bookingAttemptId };
  const contactResponse = await ghlRequest(
    '/contacts/upsert',
    {
      name: request.customerName,
      phone: request.phoneNumber,
      address1: request.address,
      locationId,
      source: `Steel Scale ${request.source}`,
    },
    context,
  );
  const contact =
    contactResponse.contact &&
    typeof contactResponse.contact === 'object' &&
    !Array.isArray(contactResponse.contact)
      ? (contactResponse.contact as Record<string, unknown>)
      : undefined;
  if (!contact || typeof contact.id !== 'string') {
    throw new Error('GHL contact upsert response did not contain a contact ID');
  }

  const appointmentResponse = await ghlRequest(
    '/calendars/events/appointments',
    {
      calendarId,
      locationId,
      contactId: contact.id,
      title: `${request.service} — ${request.customerName}`,
      description: [
        `Requested service: ${request.service}`,
        `Source: ${request.source}`,
        `Booking attempt: ${bookingAttemptId}`,
        `Business: ${businessName}`,
      ].join('\n'),
      address: request.address,
      startTime: request.preferredTime,
      appointmentStatus: 'confirmed',
      toNotify: true,
      ignoreFreeSlotValidation: false,
    },
    context,
  );
  if (typeof appointmentResponse.id !== 'string') {
    throw new Error('GHL appointment response did not contain an appointment ID');
  }
  return { appointmentId: appointmentResponse.id };
}
