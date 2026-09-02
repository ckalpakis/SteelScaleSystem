import { Router } from 'express';

import { processChatbotMessage } from '../services/chatbot.js';
import { logger } from '../utils/logger.js';

export const chatbotRouter = Router();

chatbotRouter.use((request, response, next) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (request.method === 'OPTIONS') {
    response.sendStatus(204);
    return;
  }
  next();
});

chatbotRouter.post('/message', async (request, response) => {
  const body = request.body as Record<string, unknown> | undefined;
  const clientId = typeof body?.client_id === 'string' ? body.client_id.trim() : '';
  const sessionId = typeof body?.session_id === 'string' ? body.session_id.trim() : '';
  const message = typeof body?.message === 'string' ? body.message.trim() : '';

  if (!clientId || !sessionId || !message || sessionId.length > 200 || message.length > 4_000) {
    response.status(400).json({ error: 'client_id, session_id, and message are required' });
    return;
  }

  try {
    const result = await processChatbotMessage({ clientId, sessionId, message });
    response.status(200).json({ session_id: sessionId, ...result });
  } catch (error: unknown) {
    logger.error({ error, clientId, sessionId }, 'Chatbot message processing failed');
    response.status(500).json({ error: 'Unable to process chatbot message' });
  }
});
