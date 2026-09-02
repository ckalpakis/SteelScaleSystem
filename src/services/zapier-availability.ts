import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { Prisma } from '@prisma/client';

import { env } from '../config/env.js';
import { db } from '../db/client.js';
import type { CalendarAvailabilityResult } from '../types/availability.js';
import { logger } from '../utils/logger.js';

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeWebhookUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new Error('Zapier availability webhook must use HTTPS');
  }
  return url;
}

function callbackBaseUrl(): URL {
  if (!env.APP_URL) throw new Error('APP_URL is required for Zapier availability callbacks');
  const url = new URL(env.APP_URL);
  if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new Error('APP_URL must use HTTPS');
  }
  return url;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseStoredResponse(
  value: Prisma.JsonValue | null,
  requestedTime: string,
  timezone: string,
): CalendarAvailabilityResult | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const available = value.requestedAvailable;
  const slots = value.availableSlots;
  if (typeof available !== 'boolean' || !Array.isArray(slots)) return undefined;
  return {
    requestedTime,
    requestedAvailable: available,
    availableSlots: slots.filter((slot): slot is string => typeof slot === 'string'),
    timezone,
    source: 'zapier',
  };
}

export async function checkAvailabilityThroughZapier(input: {
  clientId: string;
  businessName: string;
  webhookUrl: string;
  preferredTime: string;
  timezone: string;
  maximumWaitMs?: number;
}): Promise<CalendarAvailabilityResult> {
  const requestedAt = new Date(input.preferredTime);
  if (Number.isNaN(requestedAt.valueOf())) throw new Error('Preferred time must be ISO 8601');
  const webhookUrl = safeWebhookUrl(input.webhookUrl);
  const recent = await db.availabilityCheck.findFirst({
    where: {
      clientId: input.clientId,
      requestedTime: requestedAt,
      timezone: input.timezone,
      status: 'completed',
      createdAt: { gte: new Date(Date.now() - 60_000) },
    },
    orderBy: { createdAt: 'desc' },
  });
  const recentResult = recent
    ? parseStoredResponse(recent.response, input.preferredTime, input.timezone)
    : undefined;
  if (recentResult) return recentResult;
  const requestId = randomUUID();
  const callbackToken = randomBytes(32).toString('hex');
  const callbackUrl = new URL(`/internal/availability/zapier/${requestId}`, callbackBaseUrl());
  const expiresAt = new Date(Date.now() + 60_000);
  await db.availabilityCheck.create({
    data: {
      clientId: input.clientId,
      requestId,
      callbackTokenHash: hash(callbackToken),
      requestedTime: requestedAt,
      timezone: input.timezone,
      expiresAt,
    },
  });
  let response: Response;
  try {
    response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-availability-request-id': requestId },
      body: JSON.stringify({
        request_id: requestId,
        client_id: input.clientId,
        business_name: input.businessName,
        preferred_datetime: input.preferredTime,
        timezone: input.timezone,
        search_days: 7,
        maximum_alternatives: 5,
        callback_url: callbackUrl.toString(),
        callback_token: callbackToken,
      }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    await db.availabilityCheck.update({
      where: { requestId },
      data: {
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
  if (!response.ok) {
    const message = `Zapier availability webhook returned HTTP ${response.status}`;
    await db.availabilityCheck.update({
      where: { requestId },
      data: { status: 'failed', errorMessage: message },
    });
    throw new Error(message);
  }
  const deadline = Date.now() + Math.min(25_000, Math.max(1_000, input.maximumWaitMs ?? 20_000));
  while (Date.now() < deadline) {
    const check = await db.availabilityCheck.findUnique({ where: { requestId } });
    if (check?.status === 'completed') {
      const result = parseStoredResponse(check.response, input.preferredTime, input.timezone);
      if (result) return result;
      throw new Error('Zapier availability callback contained invalid data');
    }
    if (check?.status === 'failed') throw new Error(check.errorMessage ?? 'Zapier check failed');
    await wait(400);
  }
  await db.availabilityCheck.update({
    where: { requestId },
    data: { status: 'timed_out', errorMessage: 'Zapier did not return availability in time' },
  });
  logger.warn({ clientId: input.clientId, requestId }, 'Zapier availability callback timed out');
  throw new Error('Zapier did not return availability within 20 seconds');
}

export function availabilityCallbackTokenHash(token: string): string {
  return hash(token);
}
