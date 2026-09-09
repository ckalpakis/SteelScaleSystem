import express from 'express';
import { db } from '../db/client.js';
import { enabled, integrationErrors } from '../integrations/http.js';
import { peerLimit, organizationLimit } from '../integrations/rate-limit.js';
import { authenticate, type Principal } from '../workforce/tenancy/service.js';
import { WorkforceError } from '../workforce/shared.js';
import { KnowledgeService } from './service.js';
export const knowledgeEnabled: express.RequestHandler = (_req, _res, next) => {
  if (process.env.BUSINESS_KNOWLEDGE_ENABLED !== 'true') throw new WorkforceError(404, 'not_found');
  next();
};
export const knowledgeRouter = express.Router();
knowledgeRouter.use(enabled, knowledgeEnabled, peerLimit);
knowledgeRouter.use(async (req, res, next) => {
  if (req.header('origin')) throw new WorkforceError(403, 'browser_origin_not_supported');
  const p = await authenticate(db, req.header('authorization'));
  await organizationLimit(db, p.organizationId);
  res.locals.principal = p;
  if (req.method !== 'GET' && !req.is('application/json'))
    throw new WorkforceError(415, 'json_required');
  next();
});
knowledgeRouter.use(express.json({ limit: '64kb', strict: true }));
const service = (res: express.Response) =>
  new KnowledgeService(db, res.locals.principal as Principal);
knowledgeRouter.get('/', async (req, res) => {
  res.json(
    await service(res).overview(typeof req.query.after === 'string' ? req.query.after : undefined),
  );
});
knowledgeRouter.post('/sources', async (req, res) => {
  res.status(201).json(await service(res).source(req.body));
});
knowledgeRouter.post('/documents', async (req, res) => {
  res.status(201).json(await service(res).document(req.body));
});
knowledgeRouter.get('/documents/:id', async (req, res) => {
  res.json(await service(res).documentDetail(String(req.params.id)));
});
knowledgeRouter.post('/entries', async (req, res) => {
  res.status(201).json(await service(res).save(req.body));
});
knowledgeRouter.put('/entries/:id', async (req, res) => {
  res.json(await service(res).save(req.body, String(req.params.id)));
});
knowledgeRouter.get('/entries/:id', async (req, res) => {
  res.json(await service(res).detail(String(req.params.id)));
});
knowledgeRouter.post('/entries/:id/approve', async (req, res) => {
  res.json(await service(res).approve(String(req.params.id), req.body));
});
for (const kind of ['sources', 'documents', 'entries'] as const)
  knowledgeRouter.post(`/${kind}/:id/active`, async (req, res) => {
    res.json(await service(res).toggle(kind, String(req.params.id), req.body));
  });
knowledgeRouter.post('/questions', async (req, res) => {
  res.json(await service(res).question(req.body));
});
knowledgeRouter.use(integrationErrors);
