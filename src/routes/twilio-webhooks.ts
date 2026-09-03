import { createHmac, timingSafeEqual } from 'node:crypto';

import { Router } from 'express';

import { env } from '../config/env.js';
import { processInboundSms } from '../services/sms-booking.js';
import { processTwilioVoiceStatus } from '../services/missed-call.js';
import type { TwilioVoiceStatusEvent } from '../types/twilio.js';
import { logger } from '../utils/logger.js';

export const twilioWebhookRouter = Router();

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseEvent(body: unknown): TwilioVoiceStatusEvent | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;

  const payload = Object.fromEntries(
    Object.entries(body).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  const callSid = stringValue(payload.CallSid);
  const callStatus = stringValue(payload.CallStatus)?.toLowerCase();
  const from = stringValue(payload.From);
  const to = stringValue(payload.To);

  if (!callSid || !callStatus || !from || !to) return undefined;

  const parsedDuration = Number.parseInt(payload.CallDuration ?? '0', 10);

  return {
    callSid,
    callStatus,
    from,
    to,
    answeredBy: stringValue(payload.AnsweredBy)?.toLowerCase(),
    durationSeconds: Number.isNaN(parsedDuration) ? 0 : Math.max(0, parsedDuration),
    rawPayload: payload,
  };
}

function validTwilioSignature(
  url: string,
  body: Record<string, unknown>,
  signature: string,
): boolean {
  if (!env.TWILIO_AUTH_TOKEN) return env.NODE_ENV !== 'production';
  const parameters = Object.entries(body)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}${value}`)
    .join('');
  const expected = createHmac('sha1', env.TWILIO_AUTH_TOKEN)
    .update(`${url}${parameters}`)
    .digest('base64');
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  return left.length === right.length && timingSafeEqual(left, right);
}

function publicWebhookUrl(path: string): string | undefined {
  if (!env.APP_URL) return undefined;
  return new URL(path, `${env.APP_URL.replace(/\/$/, '')}/`).toString();
}

twilioWebhookRouter.post('/voice-status', async (request, response) => {
  const event = parseEvent(request.body);

  if (!event) {
    logger.warn({ body: request.body }, 'Invalid Twilio voice-status payload');
    response.sendStatus(204);
    return;
  }

  try {
    await processTwilioVoiceStatus(event);
  } catch (error: unknown) {
    logger.error({ error, callSid: event.callSid }, 'Twilio voice-status processing failed');
  }

  response.sendStatus(204);
});

twilioWebhookRouter.post('/sms', (request, response) => {
  const body = request.body as Record<string, unknown> | undefined;
  const messageSid = stringValue(body?.MessageSid);
  const from = stringValue(body?.From);
  const to = stringValue(body?.To);
  const messageBody = stringValue(body?.Body)?.trim();
  const webhookUrl = publicWebhookUrl('/webhooks/twilio/sms');
  const signature = request.header('x-twilio-signature') ?? '';

  if (!body || !webhookUrl || !validTwilioSignature(webhookUrl, body, signature)) {
    logger.warn({ messageSid, from, to }, 'Rejected invalid Twilio SMS signature');
    response.sendStatus(403);
    return;
  }
  if (!messageSid || !from || !to || !messageBody || messageBody.length > 1_600) {
    response.sendStatus(204);
    return;
  }

  response.type('text/xml').status(200).send('<Response></Response>');
  setImmediate(() => {
    void processInboundSms({ messageSid, from, to, body: messageBody }).catch((error: unknown) => {
      logger.error({ error, messageSid, from, to }, 'Inbound SMS processing failed');
    });
  });
});
