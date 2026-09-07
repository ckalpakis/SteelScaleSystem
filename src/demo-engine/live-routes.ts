import express, { Router, type ErrorRequestHandler, type Request } from 'express';
import { db } from '../db/client.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { record } from '../services/openai-response.js';
import { TOKEN, UUID } from './core.js';
import { signForm, verifyForm } from './security.js';
import {
  authenticateSession,
  availableDemo,
  connectVoice,
  endSession,
  LiveError,
  sendChat,
  startSession,
} from './live-runtime.js';

export function runtimeToken(req: Request, id: string, version: number, preview: boolean) {
  return signForm(
    env.ADMIN_PASSWORD || '',
    preview ? req.header('authorization') || '' : '',
    `live:${id}:${version}:${preview}`,
  );
}

export function liveRouter(preview: boolean) {
  const router = Router({ mergeParams: true });
  router.use(express.json({ limit: '32kb' }));
  router.use(async (req, res, next) => {
    const origin = req.header('origin');
    if (
      req.header('sec-fetch-site') === 'cross-site' ||
      (origin &&
        origin !== `${req.protocol}://${req.get('host')}` &&
        origin !== (env.APP_URL ? new URL(env.APP_URL).origin : ''))
    )
      throw new LiveError(403, 'Cross-origin demo requests are not allowed.');
    let id: string;
    if (preview) {
      if (typeof req.params.id !== 'string' || !UUID.test(req.params.id))
        throw new LiveError(404, 'Demo not found.');
      id = req.params.id;
    } else {
      if (typeof req.params.token !== 'string' || !TOKEN.test(req.params.token))
        throw new LiveError(404, 'Demo not found.');
      const demo = await db.salesDemo.findUnique({
        where: { shareToken: req.params.token },
        select: { id: true },
      });
      if (!demo) throw new LiveError(404, 'Demo not found.');
      id = demo.id;
    }
    const demo = await availableDemo(id, preview);
    if (
      !env.ADMIN_PASSWORD ||
      !verifyForm(
        req.header('x-demo-csrf'),
        env.ADMIN_PASSWORD,
        preview ? req.header('authorization') || '' : '',
        `live:${id}:${demo.version}:${preview}`,
      )
    )
      throw new LiveError(403, 'Reload the demo to refresh its conversation credentials.');
    res.locals.demoId = id;
    next();
  });
  router.post('/sessions', async (req, res) => {
    const channel = record(req.body).channel;
    if (channel !== 'chat' && channel !== 'voice')
      throw new LiveError(400, 'Choose chat or voice.');
    res.status(201).json(await startSession(String(res.locals.demoId), preview, channel));
  });
  router.use('/sessions/:sessionId', async (req, res, next) => {
    if (typeof req.params.sessionId !== 'string' || !UUID.test(req.params.sessionId))
      throw new LiveError(400, 'Invalid conversation ID.');
    res.locals.session = await authenticateSession(
      req.params.sessionId,
      req.header('x-demo-session'),
      String(res.locals.demoId),
      preview,
    );
    next();
  });
  router.post('/sessions/:sessionId/message', async (req, res) => {
    const session = await authenticateSession(
      String(req.params.sessionId),
      req.header('x-demo-session'),
      String(res.locals.demoId),
      preview,
    );
    res.json(await sendChat(session, record(req.body).message));
  });
  router.post('/sessions/:sessionId/voice', async (req, res) => {
    const session = await authenticateSession(
      String(req.params.sessionId),
      req.header('x-demo-session'),
      String(res.locals.demoId),
      preview,
    );
    res.json(await connectVoice(session, record(req.body).sdp));
  });
  router.get('/sessions/:sessionId', async (req, res) => {
    const session = await authenticateSession(
      String(req.params.sessionId),
      req.header('x-demo-session'),
      String(res.locals.demoId),
      preview,
    );
    res.json({
      ended: Boolean(session.endedAt) || session.expiresAt <= new Date(),
      expiresAt: session.expiresAt,
      booking: session.booking,
    });
  });
  router.post('/sessions/:sessionId/end', async (req, res) => {
    await endSession(String(req.params.sessionId));
    res.sendStatus(204);
  });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    void next;
    if (error instanceof LiveError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    const status = record(error).status;
    if (status === 400 || status === 413) {
      res.status(status).json({ error: 'Invalid or oversized request.' });
      return;
    }
    logger.error({ component: 'demo-live' }, 'Live demo request failed');
    res.status(502).json({ error: 'The AI service could not respond. Please try again.' });
  };
  router.use((_req, res) => {
    res.status(404).json({ error: 'Conversation route not found.' });
  });
  router.use(errors);
  return router;
}
