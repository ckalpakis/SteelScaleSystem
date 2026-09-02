import { env } from '../config/env.js';
import type { InternalBookingRequest } from '../types/booking.js';
import { logger } from '../utils/logger.js';

interface GhlBookingResult {
  appointmentId: string;
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
