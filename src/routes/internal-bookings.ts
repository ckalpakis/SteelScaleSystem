import { BookingSource } from '@prisma/client';
import { Router } from 'express';

import { createBookingAttempt } from '../services/bookings.js';
import type { InternalBookingRequest } from '../types/booking.js';
import { logger } from '../utils/logger.js';

export const internalBookingRouter = Router();

function requiredString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function parseBookingRequest(body: unknown): InternalBookingRequest | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const values = body as Record<string, unknown>;
  const clientId = requiredString(values, 'client_id');
  const source = requiredString(values, 'source');
  const customerName = requiredString(values, 'caller_name');
  const phoneNumber = requiredString(values, 'caller_phone');
  const address = requiredString(values, 'address');
  const service = requiredString(values, 'requested_service');
  const preferredTime = requiredString(values, 'preferred_datetime');

  if (
    !clientId ||
    (source !== BookingSource.voice && source !== BookingSource.chatbot) ||
    !customerName ||
    !phoneNumber ||
    !service ||
    !preferredTime ||
    !/^\+?[1-9]\d{7,14}$/.test(phoneNumber) ||
    !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(preferredTime) ||
    Number.isNaN(Date.parse(preferredTime))
  ) {
    return undefined;
  }

  return {
    clientId,
    source,
    customerName,
    phoneNumber,
    address,
    service,
    preferredTime,
    providerCallId: requiredString(values, 'provider_call_id'),
    providerRequestId: requiredString(values, 'provider_request_id'),
  };
}

internalBookingRouter.post('/', async (request, response) => {
  const booking = parseBookingRequest(request.body);

  if (!booking) {
    response.status(400).json({ error: 'Invalid booking request' });
    return;
  }

  try {
    const result = await createBookingAttempt(booking);
    response.status(result.accepted ? 201 : 502).json(result);
  } catch (error: unknown) {
    logger.error({ error, clientId: booking.clientId }, 'Internal booking request failed');
    response.status(500).json({ error: 'Booking request failed' });
  }
});
