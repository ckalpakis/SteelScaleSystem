import type { InternalBookingRequest } from '../types/booking.js';
import { logger } from '../utils/logger.js';

export interface ZapierBookingPayload {
  booking_attempt_id: string;
  client_id: string;
  business_name: string;
  caller_name: string;
  caller_phone: string;
  address: string | null;
  requested_service: string;
  preferred_datetime: string;
  source: string;
  received_at: string;
}

export async function sendBookingToZapier(
  webhookUrl: string,
  bookingAttemptId: string,
  businessName: string,
  request: InternalBookingRequest,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(webhookUrl);
  } catch {
    throw new Error('The client Zapier webhook URL is invalid');
  }

  if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new Error('The client Zapier webhook URL must use HTTPS');
  }

  const payload: ZapierBookingPayload = {
    booking_attempt_id: bookingAttemptId,
    client_id: request.clientId,
    business_name: businessName,
    caller_name: request.customerName,
    caller_phone: request.phoneNumber,
    address: request.address ?? null,
    requested_service: request.service,
    preferred_datetime: request.preferredTime,
    source: request.source,
    received_at: new Date().toISOString(),
  };
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-booking-id': bookingAttemptId },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error: unknown) {
    logger.error(
      { err: error, clientId: request.clientId, bookingAttemptId, attempted: 'zapier_booking' },
      'Zapier API request failed',
    );
    throw error;
  }

  if (!response.ok) {
    const body = (await response.text()).slice(0, 1_000);
    logger.error(
      {
        clientId: request.clientId,
        bookingAttemptId,
        attempted: 'zapier_booking',
        status: response.status,
        responseBody: body,
      },
      'Zapier webhook rejected booking',
    );
    throw new Error(`Zapier returned HTTP ${response.status}${body ? `: ${body}` : ''}`);
  }
}
