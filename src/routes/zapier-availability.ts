import { timingSafeEqual } from 'node:crypto';

import { Router } from 'express';

import { db } from '../db/client.js';
import { availabilityCallbackTokenHash } from '../services/zapier-availability.js';

export const zapierAvailabilityRouter = Router();

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseZapierAvailabilityCallback(
  value: unknown,
): { requestedAvailable: boolean; availableSlots: string[] } | undefined {
  const values = objectValue(value);
  const requestedAvailable =
    typeof values.requested_available === 'boolean'
      ? values.requested_available
      : typeof values.requestedAvailable === 'boolean'
        ? values.requestedAvailable
        : values.requested_available === 'true' || values.requestedAvailable === 'true'
          ? true
          : values.requested_available === 'false' || values.requestedAvailable === 'false'
            ? false
            : undefined;
  const rawSlots = values.available_slots ?? values.availableSlots;
  const normalizedSlots = Array.isArray(rawSlots)
    ? rawSlots
    : typeof rawSlots === 'string'
      ? rawSlots.split(/[\n,]/).map((slot) => slot.trim())
      : [];
  const availableSlots = normalizedSlots.filter(
    (slot): slot is string => typeof slot === 'string' && Number.isFinite(Date.parse(slot)),
  );
  return typeof requestedAvailable === 'boolean'
    ? { requestedAvailable, availableSlots }
    : undefined;
}

zapierAvailabilityRouter.post('/zapier/:requestId', async (request, response) => {
  const values = objectValue(request.body);
  const bearer = request.header('authorization');
  const token = bearer?.startsWith('Bearer ')
    ? bearer.slice(7)
    : typeof values.callback_token === 'string'
      ? values.callback_token
      : undefined;
  const check = await db.availabilityCheck.findUnique({
    where: { requestId: request.params.requestId },
  });
  if (
    !check ||
    !token ||
    !sameHash(availabilityCallbackTokenHash(token), check.callbackTokenHash)
  ) {
    response.status(401).json({ error: 'Unauthorized availability callback' });
    return;
  }
  if (check.expiresAt <= new Date()) {
    response.status(410).json({ error: 'Availability request expired' });
    return;
  }
  const parsed = parseZapierAvailabilityCallback(values);
  if (!parsed) {
    response.status(400).json({ error: 'requested_available must be true or false' });
    return;
  }
  await db.availabilityCheck.update({
    where: { requestId: check.requestId },
    data: {
      status: 'completed',
      response: parsed,
      completedAt: new Date(),
    },
  });
  response.json({ received: true });
});
