import { Router } from 'express';
import type { Principal } from '../workforce/tenancy/service.js';
import { integer, keys, object, string, uuid } from '../workforce/shared.js';
import { CrmService } from './service.js';
import { resource } from './validation.js';

// Transport only: validation, authorization, tenant scoping and business rules live in services.
export function createCrmRouter(factory: (principal: Principal) => CrmService): Router {
  const router = Router();
  router.use((_request, response, next) => {
    if (process.env.CRM_ENABLED !== 'true') {
      response.sendStatus(404);
      return;
    }
    next();
  });
  const service = (locals: Record<string, unknown>) => factory(locals.principal as Principal);
  router.get('/organization', async (_req, res) => {
    res.json(await service(res.locals).organization());
  });
  router.patch('/organization', async (req, res) => {
    res.json(await service(res.locals).organization(req.body));
  });
  router.get('/members', async (_req, res) => {
    res.json(await service(res.locals).members());
  });
  router.get('/users', async (_req, res) => {
    res.json((await service(res.locals).members()).map((member) => member.user).filter(Boolean));
  });
  router.post('/members', async (req, res) => {
    res.status(201).json(await service(res.locals).addMember(req.body));
  });
  router.patch('/members/:id', async (req, res) => {
    res.json(await service(res.locals).updateMember(uuid(req.params.id), req.body));
  });
  router.delete('/members/:id', async (req, res) => {
    keys(object(req.body), []);
    res.json(await service(res.locals).updateMember(uuid(req.params.id), { active: false }));
  });
  router.get('/custom-fields', async (_req, res) => {
    res.json(await service(res.locals).fields());
  });
  router.post('/custom-fields', async (req, res) => {
    res.status(201).json(await service(res.locals).createField(req.body));
  });
  router.patch('/custom-fields/:id', async (req, res) => {
    res.json(await service(res.locals).updateField(uuid(req.params.id), req.body));
  });
  router.delete('/custom-fields/:id', async (req, res) => {
    keys(object(req.body), []);
    res.json(await service(res.locals).updateField(uuid(req.params.id), { archived: true }));
  });
  router.get('/connections', async (_req, res) => {
    res.json(await service(res.locals).connections());
  });
  router.post('/connections', async (req, res) => {
    res.status(201).json(await service(res.locals).createConnection(req.body));
  });
  router.patch('/connections/:id', async (req, res) => {
    res.json(await service(res.locals).updateConnection(uuid(req.params.id), req.body));
  });
  router.delete('/connections/:id', async (req, res) => {
    keys(object(req.body), []);
    res.json(await service(res.locals).updateConnection(uuid(req.params.id), { enabled: false }));
  });
  router.get('/external-mappings', async (req, res) => {
    res.json(
      await service(res.locals).mappings(
        req.query.after === undefined ? undefined : uuid(req.query.after),
      ),
    );
  });
  router.post('/external-mappings', async (req, res) => {
    res.status(201).json(await service(res.locals).mapExternal(req.body));
  });
  router.delete('/external-mappings/:id', async (req, res) => {
    keys(object(req.body), []);
    await service(res.locals).unmapExternal(uuid(req.params.id));
    res.sendStatus(204);
  });
  router.post('/pipelines/:id/reorder', async (req, res) => {
    res.json(await service(res.locals).reorderStages(uuid(req.params.id), req.body));
  });
  router.get('/:resource', async (req, res) => {
    const query = {
      after: req.query.after === undefined ? undefined : uuid(req.query.after),
      search: req.query.search === undefined ? undefined : string(req.query.search, 100),
      pipelineId: req.query.pipelineId === undefined ? undefined : uuid(req.query.pipelineId),
      stageId: req.query.stageId === undefined ? undefined : uuid(req.query.stageId),
    };
    res.json(await service(res.locals).list(resource(req.params.resource), query));
  });
  router.post('/:resource', async (req, res) => {
    res.status(201).json(await service(res.locals).create(resource(req.params.resource), req.body));
  });
  router.get('/:resource/:id', async (req, res) => {
    res.json(await service(res.locals).detail(resource(req.params.resource), uuid(req.params.id)));
  });
  router.patch('/:resource/:id', async (req, res) => {
    res.json(
      await service(res.locals).update(
        resource(req.params.resource),
        uuid(req.params.id),
        req.body,
      ),
    );
  });
  router.delete('/:resource/:id', async (req, res) => {
    const body = object(req.body);
    keys(body, ['expectedVersion']);
    await service(res.locals).archive(
      resource(req.params.resource),
      uuid(req.params.id),
      integer(body.expectedVersion, 1, 2_147_483_646),
    );
    res.sendStatus(204);
  });
  return router;
}
