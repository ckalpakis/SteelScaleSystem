import { Router } from 'express';
import { requireAdminAuth } from '../middleware/admin-auth.js';
import { db } from '../db/client.js';

// Platform-operator only, not an organization-admin endpoint. Read-only; no replay buttons.
export const operationsRouter = Router();
operationsRouter.use(requireAdminAuth);
operationsRouter.get('/', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const [events, agents, integrations, communications, background, failures, oldestPending] =
      await Promise.all([
        db.workforceJob.groupBy({ by: ['status'], _count: true }),
        db.agentRun.groupBy({ by: ['status'], _count: true }),
        db.outboundDelivery.groupBy({ by: ['status'], _count: true }),
        db.communicationDelivery.groupBy({ by: ['status'], _count: true }),
        db.backgroundTask.groupBy({ by: ['status'], _count: true }),
        db.backgroundTask.findMany({
          where: { status: { in: ['dead', 'unknown'] } },
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: {
            id: true,
            kind: true,
            organizationId: true,
            clientId: true,
            correlationId: true,
            status: true,
            attempts: true,
            lastErrorCode: true,
            createdAt: true,
          },
        }),
        db.workforceJob.findFirst({
          where: { status: 'pending' },
          orderBy: { availableAt: 'asc' },
          select: { availableAt: true },
        }),
      ]);
    res.json({
      events,
      agents,
      integrations,
      communications,
      background,
      failures,
      oldestPendingEventAt: oldestPending?.availableAt ?? null,
    });
  } catch {
    res.status(503).json({ error: 'operations_unavailable' });
  }
});
