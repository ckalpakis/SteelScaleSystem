import express, { type ErrorRequestHandler } from 'express';
import { db } from '../../db/client.js';
import { createCrmRouter } from '../../crm/http.js';
import { CrmService } from '../../crm/service.js';
import { ingestExternal } from '../../events/intake.js';
import { normalizeGhlOpportunity } from '../../events/adapters/ghl.js';
import { requireAdminAuth } from '../../middleware/admin-auth.js';
import { audit } from '../audit/service.js';
import { parseRecoveryConfig, proposeRecoveryConfig } from '../agents/config.js';
import { decideApproval } from '../approvals/service.js';
import { parseEvent } from '../events/contracts.js';
import { ingestEvent } from '../events/service.js';
import { inboundAdapter } from '../integrations/adapters.js';
import { recordRevenue } from '../revenue/service.js';
import {
  boolean,
  currency,
  date,
  integer,
  json,
  keys,
  object,
  string,
  tenantTransaction,
  uuid,
  WorkforceError,
} from '../shared.js';
import {
  authenticate,
  authorize,
  issueCredential,
  provisionOrganization,
  scopes,
  type Principal,
  type Scope,
} from '../tenancy/service.js';

export const workforceRouter = express.Router();

workforceRouter.use((_request, response, next) => {
  response.setHeader('Cache-Control', 'no-store');
  if (process.env.WORKFORCE_ENABLED !== 'true') {
    response.sendStatus(404);
    return;
  }
  next();
});

// Machine JSON API, no cookies, CORS or browser forms. Tenant bootstrap stays operator-only.
workforceRouter.use((request, _response, next) => {
  if (request.header('origin')) throw new WorkforceError(403, 'browser_origin_not_supported');
  if (!['GET', 'HEAD'].includes(request.method) && !request.is('application/json')) {
    throw new WorkforceError(415, 'json_required');
  }
  next();
});

workforceRouter.post(
  '/organizations',
  requireAdminAuth,
  express.json({ limit: '32kb' }),
  async (request, response) => {
    const body = object(request.body);
    keys(body, ['name', 'ownerSubject', 'legacyClientId']);
    const result = await provisionOrganization(
      db,
      {
        name: string(body.name),
        ownerSubject: string(body.ownerSubject),
        legacyClientId: body.legacyClientId === undefined ? undefined : uuid(body.legacyClientId),
      },
      'platform_operator',
    );
    response.status(201).json(result);
  },
);

workforceRouter.use(async (request, response, next) => {
  response.locals.principal = await authenticate(db, request.header('authorization'));
  next();
});
workforceRouter.use(express.json({ limit: '32kb' }));
workforceRouter.use(
  '/crm',
  createCrmRouter((principal) => new CrmService(db, principal)),
);

function principal(locals: Record<string, unknown>, scope: Scope): Principal {
  const value = locals.principal as Principal;
  authorize(value, scope);
  return value;
}

workforceRouter.get('/organization', async (_request, response) => {
  const actor = principal(response.locals, 'crm:read');
  response.json(
    await db.organization.findUnique({
      where: { id: actor.organizationId },
      select: { id: true, name: true, createdAt: true },
    }),
  );
});

workforceRouter.post('/integrations', async (request, response) => {
  const actor = principal(response.locals, 'integrations:write');
  const body = object(request.body);
  keys(body, ['name', 'provider', 'externalAccountId']);
  if (
    typeof body.provider !== 'string' ||
    !['zapier', 'generic_webhook', 'ghl', 'jobber', 'housecall_pro'].includes(body.provider)
  )
    throw new WorkforceError(400, 'unsupported_integration');
  const name = string(body.name);
  const provider = body.provider;
  const externalAccountId =
    body.externalAccountId === undefined ? undefined : string(body.externalAccountId, 250);
  if (provider === 'ghl' && !externalAccountId)
    throw new WorkforceError(400, 'ghl_location_required');
  const result = await tenantTransaction(db, actor.organizationId, async (tx) => {
    const integration = await tx.externalConnection.create({
      data: { organizationId: actor.organizationId, name, provider, externalAccountId },
    });
    const credential = await issueCredential(
      tx,
      actor.organizationId,
      { integrationId: integration.id },
      ['events:write'],
    );
    await audit(tx, actor.organizationId, actor.actor, 'integration.created', integration.id);
    await audit(
      tx,
      actor.organizationId,
      actor.actor,
      'credential.issued',
      credential.credentialId,
    );
    return { integration, ...credential };
  });
  response.status(201).json(result);
});

workforceRouter.post('/credentials/:id/revoke', async (request, response) => {
  const actor = principal(response.locals, 'integrations:write');
  const id = uuid(request.params.id);
  keys(object(request.body), []);
  await tenantTransaction(db, actor.organizationId, async (tx) => {
    const updated = await tx.workforceCredential.updateMany({
      where: { id, organizationId: actor.organizationId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (!updated.count) throw new WorkforceError(404, 'credential_not_found');
    await audit(tx, actor.organizationId, actor.actor, 'credential.revoked', id);
  });
  response.sendStatus(204);
});

workforceRouter.post('/credentials/:id/rotate', async (request, response) => {
  const actor = principal(response.locals, 'integrations:write');
  const id = uuid(request.params.id);
  keys(object(request.body), []);
  const result = await tenantTransaction(db, actor.organizationId, async (tx) => {
    const credential = await tx.workforceCredential.findFirst({
      where: { id, organizationId: actor.organizationId, revokedAt: null },
    });
    if (!credential) throw new WorkforceError(404, 'credential_not_found');
    const owner = credential.membershipId
      ? { membershipId: credential.membershipId }
      : { integrationId: credential.integrationId! };
    const replacement = await issueCredential(
      tx,
      actor.organizationId,
      owner,
      credential.scopes.filter((s): s is Scope => scopes.includes(s as Scope)),
    );
    await tx.workforceCredential.update({ where: { id }, data: { revokedAt: new Date() } });
    await audit(tx, actor.organizationId, actor.actor, 'credential.rotated', id, {
      replacementId: replacement.credentialId,
    });
    return replacement;
  });
  response.status(201).json(result);
});

workforceRouter.post('/webhooks/:integrationId/canonical', async (request, response) => {
  const actor = principal(response.locals, 'events:write');
  const result = await ingestExternal(db, actor, uuid(request.params.integrationId), request.body);
  response.status(result.duplicate ? 200 : 202).json(result);
});
workforceRouter.post('/webhooks/:integrationId/ghl', async (request, response) => {
  const actor = principal(response.locals, 'events:write');
  const result = await ingestExternal(
    db,
    actor,
    uuid(request.params.integrationId),
    request.body,
    normalizeGhlOpportunity,
  );
  response.status(result.duplicate ? 200 : 202).json(result);
});
workforceRouter.get('/event-deliveries', async (request, response) => {
  const actor = principal(response.locals, 'audit:read');
  const eventId = uuid(request.query.eventId);
  response.json(
    await db.eventDelivery.findMany({
      where: { organizationId: actor.organizationId, eventId },
      orderBy: { handlerId: 'asc' },
      take: 100,
    }),
  );
});

workforceRouter.post('/webhooks/:integrationId', async (request, response) => {
  const actor = principal(response.locals, 'events:write');
  const integrationId = uuid(request.params.integrationId);
  if (actor.integrationId !== integrationId)
    throw new WorkforceError(403, 'integration_scope_mismatch');
  const integration = await db.externalConnection.findUnique({
    where: {
      organizationId_id: { organizationId: actor.organizationId, id: integrationId },
    },
  });
  if (!integration?.enabled) throw new WorkforceError(403, 'integration_disabled');
  const event = inboundAdapter(integration.provider).normalize(request.body);
  const result = await ingestEvent(db, actor.organizationId, integration.id, actor.actor, event);
  response.status(result.duplicate ? 200 : 202).json(result);
});

// Direct CRM writes use the same versioned, replay-safe event contract as integrations.
for (const [path, type] of [
  ['customers', 'customer.upserted'],
  ['opportunities', 'opportunity.upserted'],
] as const) {
  workforceRouter.post(`/${path}`, async (request, response) => {
    const actor = principal(response.locals, 'crm:write');
    const event = parseEvent(request.body);
    if (event.type !== type) throw new WorkforceError(400, 'event_type_mismatch');
    const result = await ingestEvent(db, actor.organizationId, 'internal', actor.actor, event);
    response.status(result.duplicate ? 200 : 201).json(result);
  });
}

workforceRouter.get('/customers', async (request, response) => {
  const actor = principal(response.locals, 'crm:read');
  const after = request.query.after === undefined ? undefined : uuid(request.query.after);
  response.json(
    await db.contact.findMany({
      where: {
        organizationId: actor.organizationId,
        record: { archivedAt: null },
        ...(after ? { id: { gt: after } } : {}),
      },
      orderBy: { id: 'asc' },
      take: 100,
    }),
  );
});
workforceRouter.get('/opportunities', async (request, response) => {
  const actor = principal(response.locals, 'crm:read');
  const after = request.query.after === undefined ? undefined : uuid(request.query.after);
  response.json(
    await db.opportunity.findMany({
      where: {
        organizationId: actor.organizationId,
        record: { archivedAt: null },
        ...(after ? { id: { gt: after } } : {}),
      },
      orderBy: { id: 'asc' },
      take: 100,
    }),
  );
});

workforceRouter.post('/agents/propose', async (request, response) => {
  principal(response.locals, 'agents:write');
  const body = object(request.body);
  keys(body, ['description']);
  response.json(await proposeRecoveryConfig(body.description));
});
workforceRouter.post('/agents', async (request, response) => {
  const actor = principal(response.locals, 'agents:write');
  const body = object(request.body);
  keys(body, ['name', 'description', 'config']);
  const name = string(body.name);
  const description = string(body.description, 4000);
  const config = parseRecoveryConfig(body.config);
  const agent = await tenantTransaction(db, actor.organizationId, async (tx) => {
    if ((await tx.workforceAgent.count({ where: { organizationId: actor.organizationId } })) >= 20)
      throw new WorkforceError(409, 'agent_limit');
    const created = await tx.workforceAgent.create({
      data: {
        organizationId: actor.organizationId,
        name,
        description,
        config: json(config),
      },
    });
    await audit(tx, actor.organizationId, actor.actor, 'agent.created', created.id, {
      configVersion: 1,
    });
    return created;
  });
  response.status(201).json(agent);
});
workforceRouter.patch('/agents/:id', async (request, response) => {
  const actor = principal(response.locals, 'agents:write');
  const id = uuid(request.params.id);
  const body = object(request.body);
  keys(body, ['expectedVersion', 'enabled', 'config']);
  const expectedVersion = integer(body.expectedVersion, 1, 2_147_483_646);
  const enabled = boolean(body.enabled);
  const config = body.config === undefined ? undefined : parseRecoveryConfig(body.config);
  const result = await tenantTransaction(db, actor.organizationId, async (tx) => {
    const changed = await tx.workforceAgent.updateMany({
      where: {
        organizationId: actor.organizationId,
        id,
        configVersion: expectedVersion,
      },
      data: { enabled, config: config ? json(config) : undefined, configVersion: { increment: 1 } },
    });
    if (!changed.count) throw new WorkforceError(409, 'agent_version_conflict');
    await audit(tx, actor.organizationId, actor.actor, 'agent.configured', id, {
      enabled,
      configVersion: expectedVersion + 1,
    });
    return tx.workforceAgent.findUnique({
      where: { organizationId_id: { organizationId: actor.organizationId, id } },
    });
  });
  response.json(result);
});
workforceRouter.get('/agents', async (_request, response) => {
  const actor = principal(response.locals, 'crm:read');
  response.json(
    await db.workforceAgent.findMany({
      where: { organizationId: actor.organizationId },
      take: 100,
    }),
  );
});
workforceRouter.post('/recovery/scan', async (request, response) => {
  const actor = principal(response.locals, 'agents:write');
  const event = parseEvent(request.body);
  if (event.type !== 'recovery.scan.requested')
    throw new WorkforceError(400, 'event_type_mismatch');
  response
    .status(202)
    .json(await ingestEvent(db, actor.organizationId, 'internal', actor.actor, event));
});

workforceRouter.get('/approvals', async (request, response) => {
  const actor = principal(response.locals, 'crm:read');
  const after = request.query.after === undefined ? undefined : uuid(request.query.after);
  response.json(
    await db.workforceApproval.findMany({
      where: { organizationId: actor.organizationId, ...(after ? { id: { gt: after } } : {}) },
      include: { action: true },
      orderBy: { id: 'asc' },
      take: 100,
    }),
  );
});
workforceRouter.post('/approvals/:id/decision', async (request, response) => {
  const actor = principal(response.locals, 'approvals:write');
  const body = object(request.body);
  keys(body, ['decision', 'reason']);
  if (body.decision !== 'approve' && body.decision !== 'reject')
    throw new WorkforceError(400, 'invalid_decision');
  response.json(
    await decideApproval(
      db,
      actor,
      uuid(request.params.id),
      body.decision,
      string(body.reason, 1000),
    ),
  );
});

for (const resource of ['events', 'runs', 'jobs', 'audit'] as const) {
  workforceRouter.get(`/${resource}`, async (request, response) => {
    const actor = principal(response.locals, 'audit:read');
    const after = request.query.after === undefined ? undefined : uuid(request.query.after);
    const args = {
      where: { organizationId: actor.organizationId, ...(after ? { id: { gt: after } } : {}) },
      orderBy: { id: 'asc' as const },
      take: 100,
    };
    const records =
      resource === 'events'
        ? await db.businessEvent.findMany(args)
        : resource === 'runs'
          ? await db.workforceRun.findMany(args)
          : resource === 'jobs'
            ? await db.workforceJob.findMany(args)
            : await db.auditLog.findMany(args);
    response.json(records);
  });
}

workforceRouter.post('/revenue', async (request, response) => {
  const actor = principal(response.locals, 'revenue:write');
  const body = object(request.body);
  keys(body, [
    'opportunityId',
    'actionId',
    'externalPaymentId',
    'amountMinor',
    'currency',
    'evidence',
    'paidAt',
  ]);
  const paidAt = date(body.paidAt);
  if (paidAt > new Date()) throw new WorkforceError(400, 'payment_in_future');
  const result = await recordRevenue(db, actor, {
    opportunityId: uuid(body.opportunityId),
    actionId: uuid(body.actionId),
    externalPaymentId: string(body.externalPaymentId),
    amountMinor: integer(body.amountMinor, 1, 2_147_483_647),
    currency: currency(body.currency),
    evidence: string(body.evidence, 2000),
    paidAt,
  });
  response.status(201).json(result);
});
workforceRouter.post('/jobs/:id/retry', async (request, response) => {
  const actor = principal(response.locals, 'agents:write');
  const id = uuid(request.params.id);
  const body = object(request.body);
  keys(body, ['reason']);
  const reason = string(body.reason, 1000);
  await tenantTransaction(db, actor.organizationId, async (tx) => {
    const updated = await tx.workforceJob.updateMany({
      where: { id, organizationId: actor.organizationId, status: 'dead' },
      data: {
        status: 'pending',
        attempts: 0,
        availableAt: new Date(),
        leaseToken: null,
        leasedUntil: null,
        lastErrorCode: null,
      },
    });
    if (!updated.count) throw new WorkforceError(409, 'job_not_dead_or_not_found');
    await audit(tx, actor.organizationId, actor.actor, 'job.requeued', id, { reason });
  });
  response.sendStatus(204);
});
workforceRouter.get('/revenue', async (_request, response) => {
  const actor = principal(response.locals, 'crm:read');
  response.json({
    attribution: 'operator_reported_assisted',
    totals: await db.workforceRevenue.groupBy({
      by: ['currency'],
      where: { organizationId: actor.organizationId },
      _sum: { amountMinor: true },
      _count: true,
    }),
  });
});

workforceRouter.use((_request, response) => {
  response.status(404).json({ error: 'not_found' });
});
const handleError: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  if (response.headersSent) {
    _next(error);
    return;
  }
  const bodyError =
    error && typeof error === 'object' ? (error as { type?: unknown; code?: unknown }) : {};
  const status =
    error instanceof WorkforceError
      ? error.status
      : bodyError.type === 'entity.too.large'
        ? 413
        : bodyError.type === 'entity.parse.failed'
          ? 400
          : ['P2002', 'P2003'].includes(String(bodyError.code))
            ? 409
            : 500;
  const code =
    error instanceof WorkforceError
      ? error.code
      : status === 409
        ? 'record_conflict'
        : status === 500
          ? 'workforce_operation_failed'
          : 'invalid_body';
  response.status(status).json({ error: code });
};
workforceRouter.use(handleError);
