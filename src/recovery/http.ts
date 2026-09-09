import express from 'express';
import { db } from '../db/client.js';
import { enabled, integrationErrors } from '../integrations/http.js';
import { organizationLimit, peerLimit } from '../integrations/rate-limit.js';
import { authenticate, type Principal } from '../workforce/tenancy/service.js';
import { object, WorkforceError } from '../workforce/shared.js';
import { RecoveryService } from './service.js';
import { RecoveryDashboardService } from './dashboard.js';
import { RecoveryDeliveryService } from './delivery.js';
import { RecoveryHandoffService } from './handoffs.js';
import { RecoveryAttributionService } from './attribution.js';
import { RecoverySimulationService } from './simulation.js';
import { recoveryScenarios } from './scenarios.js';
import { decideApproval } from '../agents/approvals.js';
export const recoveryEnabled: express.RequestHandler = (_req, _res, next) => {
  if (
    process.env.REVENUE_RECOVERY_ENABLED !== 'true' ||
    process.env.AGENT_RUNTIME_ENABLED !== 'true'
  )
    throw new WorkforceError(404, 'not_found');
  next();
};
export const recoveryRouter = express.Router();
recoveryRouter.use(enabled, recoveryEnabled, peerLimit);
recoveryRouter.use(async (req, res, next) => {
  if (req.header('origin')) throw new WorkforceError(403, 'browser_origin_not_supported');
  const p = await authenticate(db, req.header('authorization'));
  await organizationLimit(db, p.organizationId);
  res.locals.principal = p;
  if (req.method !== 'GET' && !req.is('application/json'))
    throw new WorkforceError(415, 'json_required');
  next();
});
recoveryRouter.use(express.json({ limit: '64kb', strict: true }));
const principal = (res: express.Response) => res.locals.principal as Principal;
recoveryRouter.get('/dashboard', async (_req, res) => {
  res.json(await new RecoveryDashboardService(db, principal(res)).dashboard());
});
recoveryRouter.put('/program', async (req, res) => {
  res.json(await new RecoveryService(db, principal(res)).configure(req.body));
});
recoveryRouter.post('/program/enable', async (req, res) => {
  res.json(await new RecoveryService(db, principal(res)).enable(object(req.body).enabled));
});
recoveryRouter.post('/consent', async (req, res) => {
  res.json(await new RecoveryService(db, principal(res)).consent(req.body));
});
recoveryRouter.post('/cases', async (req, res) => {
  res
    .status(201)
    .json(
      await new RecoveryService(db, principal(res)).enroll(String(object(req.body).opportunityId)),
    );
});
recoveryRouter.get('/cases/:id', async (req, res) => {
  res.json(await new RecoveryService(db, principal(res)).detail(String(req.params.id)));
});
recoveryRouter.post('/handoffs/:id', async (req, res) => {
  res.json(
    await new RecoveryHandoffService(db, principal(res)).act(String(req.params.id), req.body),
  );
});
recoveryRouter.post('/attributions/:id/review', async (req, res) => {
  res.json(
    await new RecoveryAttributionService(db, principal(res)).review(
      String(req.params.id),
      req.body,
    ),
  );
});
recoveryRouter.get('/scenarios', async (_req, res) => {
  await new RecoveryService(db, principal(res)).tx(() => Promise.resolve(true), 'crm:read');
  res.json(recoveryScenarios);
});
recoveryRouter.post('/simulations', async (req, res) => {
  res.json(await new RecoverySimulationService(db, principal(res)).run(req.body));
});
recoveryRouter.post('/approvals/:id', async (req, res) => {
  const b = object(req.body);
  if (!['approve', 'reject'].includes(String(b.decision)))
    throw new WorkforceError(400, 'invalid_approval_decision');
  res.json(
    await decideApproval(
      db,
      principal(res),
      String(req.params.id),
      b.decision as 'approve' | 'reject',
      String(b.reason),
    ),
  );
});
recoveryRouter.get('/delivery', async (_req, res) => {
  res.json(await new RecoveryDeliveryService(db, principal(res)).list());
});
recoveryRouter.post('/delivery/:id/claim', async (req, res) => {
  res.json(await new RecoveryDeliveryService(db, principal(res)).claim(String(req.params.id)));
});
recoveryRouter.post('/delivery/:id/receipt', async (req, res) => {
  res.json(
    await new RecoveryDeliveryService(db, principal(res)).receipt(String(req.params.id), req.body),
  );
});
recoveryRouter.use(integrationErrors);
