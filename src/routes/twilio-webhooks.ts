import { Router } from 'express';

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
