import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { db } from '../db/client.js';
import { authenticate, type Principal } from '../workforce/tenancy/service.js';
import { WorkforceError, object, uuid } from '../workforce/shared.js';
import { IntegrationService } from './service.js';
import { receive } from './inbound.js';
import { organizationLimit, peerLimit } from './rate-limit.js';

export const enabled: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (process.env.WORKFORCE_ENABLED !== 'true') {
    res.sendStatus(404);
    return;
  }
  next();
};
export const integrationErrors: ErrorRequestHandler = (err: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const parserStatus = err && typeof err === 'object' && 'status' in err ? Number(err.status) : 0;
  const status =
    err instanceof WorkforceError
      ? err.status
      : err instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2003'].includes(err.code)
        ? 409
        : [400, 413, 415].includes(parserStatus)
          ? parserStatus
          : 500;
  if (status === 429) res.setHeader('Retry-After', '60');
  res.status(status).json({
    error:
      err instanceof WorkforceError
        ? err.code
        : status === 409
          ? 'record_conflict'
          : status < 500
            ? 'invalid_request'
            : 'integration_request_failed',
    requestId: randomUUID(),
  });
};
export const integrationRouter = express.Router();
integrationRouter.use(enabled, peerLimit);
integrationRouter.use(async (req, res, next) => {
  if (req.header('origin')) throw new WorkforceError(403, 'browser_origin_not_supported');
  const principal = await authenticate(db, req.header('authorization'));
  await organizationLimit(db, principal.organizationId);
  res.locals.principal = principal;
  next();
});
integrationRouter.use((req, _res, next) => {
  if (req.method !== 'GET' && !req.is('application/json'))
    throw new WorkforceError(415, 'json_required');
  next();
});
integrationRouter.use(express.json({ limit: '64kb', strict: true }));
const principal = (locals: Record<string, unknown>) => locals.principal as Principal;
const manager = (locals: Record<string, unknown>) => new IntegrationService(db, principal(locals));
for (const path of ['/webhooks/events', '/webhooks/:connectionId/events'])
  integrationRouter.post(path, async (req, res) => {
    const actor = principal(res.locals);
    if (req.params.connectionId && uuid(req.params.connectionId) !== actor.integrationId)
      throw new WorkforceError(403, 'integration_scope_mismatch');
    const result = await receive(db, actor, req.body, req.header('idempotency-key'));
    res.status(result.duplicate ? 200 : 202).json(result);
  });
integrationRouter.get('/', async (_req, res) => {
  res.json(await manager(res.locals).overview());
});
integrationRouter.post('/connections', async (req, res) => {
  res.status(201).json(await manager(res.locals).createConnection(req.body));
});
integrationRouter.post('/connections/:id/credentials', async (req, res) => {
  res.status(201).json(await manager(res.locals).issue(uuid(req.params.id)));
});
integrationRouter.post('/credentials/:id/revoke', async (req, res) => {
  res.json(await manager(res.locals).revoke(uuid(req.params.id)));
});
integrationRouter.post('/outbound', async (req, res) => {
  res.status(201).json(await manager(res.locals).createEndpoint(req.body));
});
integrationRouter.post('/outbound/:id/:operation', async (req, res) => {
  const operation = req.params.operation;
  if (operation !== 'test' && operation !== 'enable' && operation !== 'disable')
    throw new WorkforceError(404, 'operation_not_found');
  object(req.body);
  res
    .status(operation === 'test' ? 202 : 200)
    .json(await manager(res.locals).endpoint(uuid(req.params.id), operation));
});
integrationRouter.post('/deliveries/:id/retry', async (req, res) => {
  res.status(202).json(await manager(res.locals).retry(uuid(req.params.id)));
});
integrationRouter.use(integrationErrors);
