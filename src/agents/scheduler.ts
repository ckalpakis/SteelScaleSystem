import { audit } from '../workforce/audit/service.js';
import { tenantTransaction, WorkforceError, type Database } from '../workforce/shared.js';
import { enqueueRun } from './service.js';
import { finishRun } from './runtime.js';

export async function scheduleAgents(
  database: Database,
  now = new Date(),
  organizationId?: string,
) {
  if (process.env.AGENT_RUNTIME_ENABLED !== 'true') return;
  const schedules = await database.agentSchedule.findMany({
    where: {
      enabled: true,
      nextRunAt: { lte: now },
      ...(organizationId ? { organizationId } : {}),
    },
    orderBy: { nextRunAt: 'asc' },
    take: 100,
  });
  for (const candidate of schedules)
    await tenantTransaction(database, candidate.organizationId, async (tx) => {
      const schedule = await tx.agentSchedule.findFirst({
        where: {
          organizationId: candidate.organizationId,
          id: candidate.id,
          enabled: true,
          nextRunAt: { lte: now },
        },
      });
      if (!schedule) return;
      try {
        await enqueueRun(
          tx,
          schedule.organizationId,
          schedule.agentId,
          schedule.subjectId,
          `schedule:${schedule.id}:${schedule.nextRunAt.toISOString()}`,
          { system: 'schedule', scheduleId: schedule.id },
          now,
        );
      } catch (error) {
        if (!(error instanceof WorkforceError)) throw error;
        await audit(
          tx,
          schedule.organizationId,
          'agent-scheduler',
          'agent.schedule_blocked',
          schedule.id,
          { code: error.code },
        );
        if (error.status === 429) {
          await tx.agentSchedule.update({
            where: {
              organizationId_id: { organizationId: schedule.organizationId, id: schedule.id },
            },
            data: { nextRunAt: new Date(now.getTime() + 3600000) },
          });
          return;
        }
        await tx.agentSchedule.update({
          where: {
            organizationId_id: { organizationId: schedule.organizationId, id: schedule.id },
          },
          data: { enabled: false },
        });
        return;
      }
      const remaining = schedule.remainingRuns - 1;
      await tx.agentSchedule.update({
        where: { organizationId_id: { organizationId: schedule.organizationId, id: schedule.id } },
        data: {
          remainingRuns: remaining,
          enabled: remaining > 0 && schedule.intervalMinutes !== null,
          nextRunAt: new Date(now.getTime() + (schedule.intervalMinutes ?? 15) * 60000),
        },
      });
    });
  const approvals = await database.humanApproval.findMany({
    where: {
      status: 'pending',
      expiresAt: { lte: now },
      ...(organizationId ? { organizationId } : {}),
    },
    take: 100,
    orderBy: { expiresAt: 'asc' },
  });
  for (const candidate of approvals)
    await tenantTransaction(database, candidate.organizationId, async (tx) => {
      const approval = await tx.humanApproval.findFirst({
        where: {
          organizationId: candidate.organizationId,
          id: candidate.id,
          status: 'pending',
          expiresAt: { lte: now },
        },
        include: { action: { include: { run: true } } },
      });
      if (!approval) return;
      await tx.humanApproval.update({
        where: {
          organizationId_id: { organizationId: candidate.organizationId, id: candidate.id },
        },
        data: {
          status: 'expired',
          decidedAt: now,
          reason: 'approval_expired',
          decidedBy: 'agent-scheduler',
        },
      });
      await tx.agentAction.update({
        where: {
          organizationId_id: { organizationId: candidate.organizationId, id: approval.actionId },
        },
        data: { status: 'blocked', errorCode: 'approval_expired', completedAt: now },
      });
      await finishRun(
        tx,
        approval.action.run,
        'stopped',
        'Human approval expired.',
        'approval_expired',
      );
    });
}
