import express from 'express';
import { db } from '../db/client.js';
import { authenticate, type Principal } from '../workforce/tenancy/service.js';
import { object, keys, string, WorkforceError } from '../workforce/shared.js';
import { enabled, integrationErrors } from '../integrations/http.js';
import { organizationLimit, peerLimit } from '../integrations/rate-limit.js';
import { AgentService } from './service.js';
import { decideApproval } from './approvals.js';

export const agentRouter = express.Router();
agentRouter.use(enabled, peerLimit);
agentRouter.use(async (req, res, next) => {
  if (process.env.AGENT_RUNTIME_ENABLED !== 'true') throw new WorkforceError(404, 'not_found');
  if (req.header('origin')) throw new WorkforceError(403, 'browser_origin_not_supported');
  const principal = await authenticate(db, req.header('authorization'));
  await organizationLimit(db, principal.organizationId);
  res.locals.principal = principal;
  if (req.method !== 'GET' && !req.is('application/json'))
    throw new WorkforceError(415, 'json_required');
  next();
});
agentRouter.use(express.json({ limit: '32kb', strict: true }));
const manager = (locals: Record<string, unknown>) =>
  new AgentService(db, locals.principal as Principal);
agentRouter.get('/', async (_req, res) => {
  res.json(await manager(res.locals).list());
});
agentRouter.post('/', async (req, res) => {
  res.status(201).json(await manager(res.locals).create(req.body));
});
agentRouter.get('/runs', async (_req, res) => {
  res.json(await manager(res.locals).runs());
});
agentRouter.get('/runs/:id', async (req, res) => {
  res.json(await manager(res.locals).detail(String(req.params.id)));
});
agentRouter.post('/runs/:id/stop', async (req, res) => {
  res.json(await manager(res.locals).stop(String(req.params.id)));
});
agentRouter.get('/schedules', async (_req, res) => {
  res.json(await manager(res.locals).schedules());
});
agentRouter.post('/schedules/:id/cancel', async (req, res) => {
  res.json(await manager(res.locals).cancelSchedule(String(req.params.id)));
});
agentRouter.post('/:id/versions', async (req, res) => {
  res.status(201).json(await manager(res.locals).version(String(req.params.id), req.body));
});
agentRouter.post('/:id/enabled', async (req, res) => {
  const v = object(req.body);
  keys(v, ['enabled']);
  res.json(await manager(res.locals).enable(String(req.params.id), v.enabled));
});
agentRouter.post('/:id/runs', async (req, res) => {
  res.status(202).json(await manager(res.locals).start(String(req.params.id), req.body));
});
agentRouter.post('/:id/schedules', async (req, res) => {
  res.status(201).json(await manager(res.locals).schedule(String(req.params.id), req.body));
});
agentRouter.post('/approvals/:id/decision', async (req, res) => {
  const v = object(req.body);
  keys(v, ['decision', 'reason']);
  if (v.decision !== 'approve' && v.decision !== 'reject')
    throw new WorkforceError(400, 'invalid_approval_decision');
  res.json(
    await decideApproval(
      db,
      res.locals.principal as Principal,
      String(req.params.id),
      v.decision,
      string(v.reason, 1000),
    ),
  );
});
agentRouter.use(integrationErrors);
