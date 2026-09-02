import { Router } from 'express';

import { env } from '../config/env.js';
import {
  buildAssistantResponse,
  handleToolCalls,
  logCallEnded,
  logCallStarted,
  type VapiMessage,
} from '../services/vapi.js';
import { logger } from '../utils/logger.js';

export const vapiWebhookRouter = Router();

vapiWebhookRouter.use((request, response, next) => {
  if (!env.VAPI_WEBHOOK_SECRET) {
    next();
    return;
  }

  const bearer = request.header('authorization');
  const legacySecret = request.header('x-vapi-secret');
  const authenticated =
    bearer === `Bearer ${env.VAPI_WEBHOOK_SECRET}` || legacySecret === env.VAPI_WEBHOOK_SECRET;

  if (!authenticated) {
    logger.warn('Rejected unauthenticated Vapi webhook');
    response.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
});

function parseMessage(body: unknown): VapiMessage | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const message = (body as Record<string, unknown>).message;
  return message && typeof message === 'object' && !Array.isArray(message)
    ? (message as VapiMessage)
    : undefined;
}

vapiWebhookRouter.post('/', async (request, response) => {
  const message = parseMessage(request.body);
  const type = typeof message?.type === 'string' ? message.type : undefined;

  if (!message || !type) {
    response.status(400).json({ error: 'Invalid Vapi webhook payload' });
    return;
  }

  try {
    if (type === 'assistant-request') {
      response.status(200).json(await buildAssistantResponse(message));
      return;
    }

    if (type === 'tool-calls') {
      response.status(200).json(await handleToolCalls(message));
      return;
    }

    if (type === 'status-update' && message.status === 'in-progress') {
      await logCallStarted(message);
    } else if (type === 'status-update' && message.status === 'ended') {
      await logCallEnded(message);
    } else if (type === 'end-of-call-report') {
      await logCallEnded(message);
    }

    response.status(200).json({ received: true });
  } catch (error: unknown) {
    logger.error({ error, vapiMessageType: type }, 'Vapi webhook processing failed');
    response.status(500).json({ error: 'Vapi webhook processing failed' });
  }
});
