import express from 'express';
import { db } from '../db/client.js';
import { authenticate, type Principal } from '../workforce/tenancy/service.js';
import { enabled, integrationErrors } from '../integrations/http.js';
import { organizationLimit, peerLimit } from '../integrations/rate-limit.js';
import { WorkforceError } from '../workforce/shared.js';
import { BlueprintService } from './service.js';

export const blueprintRouter = express.Router();
export const builderEnabled: express.RequestHandler = (_req, _res, next) => {
  if (process.env.AGENT_RUNTIME_ENABLED !== 'true' || process.env.AGENT_BUILDER_ENABLED !== 'true')
    throw new WorkforceError(404, 'not_found');
  next();
};
blueprintRouter.use(enabled, builderEnabled, peerLimit);
blueprintRouter.use(async (req, res, next) => {
  if (req.header('origin')) throw new WorkforceError(403, 'browser_origin_not_supported');
  const principal = await authenticate(db, req.header('authorization'));
  await organizationLimit(db, principal.organizationId);
  res.locals.principal = principal;
  if (req.method !== 'GET' && !req.is('application/json'))
    throw new WorkforceError(415, 'json_required');
  next();
});
blueprintRouter.use(express.json({ limit: '64kb', strict: true }));
const service = (locals: Record<string, unknown>) =>
  new BlueprintService(db, locals.principal as Principal);
blueprintRouter.get('/', async (_req, res) => {
  res.json(await service(res.locals).list());
});
blueprintRouter.post('/', async (req, res) => {
  res.status(201).json(await service(res.locals).save(req.body));
});
blueprintRouter.post('/generate', async (req, res) => {
  res.status(201).json(await service(res.locals).generate(req.body));
});
blueprintRouter.get('/:id', async (req, res) => {
  res.json(
    await service(res.locals).detail(
      String(req.params.id),
      req.query.version === undefined ? undefined : Number(req.query.version),
    ),
  );
});
blueprintRouter.post('/:id/versions', async (req, res) => {
  res.status(201).json(await service(res.locals).save(req.body, String(req.params.id)));
});
blueprintRouter.post('/:id/test', async (req, res) => {
  res.json(await service(res.locals).test(String(req.params.id), req.body));
});
blueprintRouter.post('/:id/activate', async (req, res) => {
  res.json(await service(res.locals).activate(String(req.params.id), req.body));
});
blueprintRouter.use(integrationErrors);
