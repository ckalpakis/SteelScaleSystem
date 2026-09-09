import type { RecoveryProgram } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { recoveryStatus } from '../communications/ledger.js';
import { enqueueRun } from '../agents/service.js';
import {
  tenantTransaction,
  WorkforceError,
  type Database,
  type Transaction,
} from '../workforce/shared.js';
import { parseConfig } from './contracts.js';
import { baseEligibility, ensureHandoff, loadCase, messageGuard, pauseCase } from './lifecycle.js';
import { audit } from '../workforce/audit/service.js';
import { EventPublisher } from '../events/publisher.js';

export async function enroll(
  tx: Transaction,
  program: RecoveryProgram,
  opportunityId: string,
  now: Date,
  anchor?: Date,
) {
  const organizationId = program.organizationId;
  const existing = await tx.recoveryCase.findUnique({
    where: { organizationId_opportunityId: { organizationId, opportunityId } },
  });
  if (existing) return existing;
  const version = await tx.agentVersion.findFirstOrThrow({
      where: { organizationId, id: program.runtimeVersionId },
    }),
    config = parseConfig(version.specialization);
  const opportunity = await tx.opportunity.findFirst({
    where: {
      organizationId,
      id: opportunityId,
      status: { in: ['open', 'estimate_sent'] },
      currency: config.currency,
      amountMinor: { gte: config.minimumValueMinor },
      record: { archivedAt: null },
      customer: { doNotContact: false, record: { archivedAt: null } },
      ...(config.pipelineIds.length ? { pipelineId: { in: config.pipelineIds } } : {}),
      ...(config.stageIds.length ? { stageId: { in: config.stageIds } } : {}),
    },
  });
  if (!opportunity) return null;
  if ((await tx.recoveryCase.count({ where: { organizationId } })) >= 10000)
    throw new WorkforceError(409, 'recovery_case_capacity');
  let conversation = await tx.conversation.findFirst({
    where: {
      organizationId,
      contactId: opportunity.customerId,
      channel: config.channels[0],
      status: 'open',
      record: { archivedAt: null },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!conversation) {
    const id = randomUUID();
    conversation = await tx.conversation.create({
      data: {
        id,
        organizationId,
        contactId: opportunity.customerId,
        channel: config.channels[0]!,
        subject: 'Revenue recovery',
      },
    });
    await new EventPublisher().publishInTransaction(
      tx,
      {
        organizationId,
        system: 'steel_scale_agent',
        provider: 'steel_scale',
        actor: `agent:${program.agentId}`,
      },
      {
        version: 2,
        type: 'conversation.created',
        entity: { type: 'conversation', id },
        occurredAt: now.toISOString(),
        idempotencyKey: `recovery-conversation:${id}`,
        relatedRecordIds: [opportunity.customerId, opportunityId],
        data: { changes: { channel: conversation.channel } },
      },
    );
  }
  const start = new Date(Math.max(opportunity.lastActivityAt.getTime(), anchor?.getTime() ?? 0));
  const row = await tx.recoveryCase.create({
    data: {
      organizationId,
      programId: program.id,
      opportunityId,
      contactId: opportunity.customerId,
      conversationId: conversation.id,
      baselineActivityAt: opportunity.lastActivityAt,
      monitoredValueMinor: opportunity.amountMinor,
      currency: opportunity.currency,
      nextDueAt: new Date(start.getTime() + config.delayMinutes * 60000),
      enrolledAt: now,
    },
  });
  await audit(tx, organizationId, `agent:${program.agentId}`, 'recovery.enrolled', row.id, {
    opportunityId,
    baselineActivityAt: opportunity.lastActivityAt,
    valueMinor: opportunity.amountMinor,
    currency: opportunity.currency,
  });
  return row;
}
export async function startCase(
  tx: Transaction,
  organizationId: string,
  id: string,
  now = new Date(),
  inbound = false,
) {
  const row = await loadCase(tx, organizationId, id),
    config = parseConfig(row.program.runtimeVersion.specialization);
  if (row.pendingRunId) {
    const run = await tx.agentRun.findFirst({ where: { organizationId, id: row.pendingRunId } });
    if (run && ['pending', 'running', 'waiting_approval'].includes(run.status)) return run;
    const finishedWithoutDispatch =
      run?.status === 'completed' &&
      !(await tx.recoveryDispatch.findFirst({
        where: { organizationId, caseId: row.id, action: { runId: run.id } },
      }));
    if (
      !inbound &&
      run &&
      (['failed', 'stopped'].includes(run.status) || finishedWithoutDispatch)
    ) {
      await pauseCase(tx, row, 'handoff', 'runtime_stopped', now);
      await ensureHandoff(
        tx,
        row,
        'runtime_stopped',
        'Runtime stopped safely; review before resuming.',
        now,
      );
      return null;
    }
  }
  const base = baseEligibility(config, row);
  if (base) {
    await pauseCase(
      tx,
      row,
      ['won', 'lost'].includes(base) ? base : base === 'opt_out' ? 'opted_out' : 'ineligible',
      base,
      now,
    );
    return null;
  }
  if (!inbound) {
    const blocked = await messageGuard(tx, row, config.channels[0]!, now);
    if (blocked) {
      if (
        [
          'outside_operating_hours',
          'not_due',
          'first_contact_delay',
          'duplicate_or_unresolved_dispatch',
        ].includes(blocked)
      )
        return null;
      await pauseCase(tx, row, blocked === 'attempt_limit' ? 'exhausted' : 'handoff', blocked, now);
      if (blocked !== 'attempt_limit')
        await ensureHandoff(
          tx,
          row,
          blocked,
          'Follow-up paused by the pre-message safety checks.',
          now,
        );
      return null;
    }
  }
  const key = `recovery:${row.id}:${row.revision}:${row.attempts}:${inbound ? row.latestResponseId : row.nextDueAt?.toISOString()}`;
  const run = await enqueueRun(
    tx,
    organizationId,
    row.program.agentId,
    row.opportunityId,
    key,
    {
      type: inbound ? 'customer.message_received' : 'recovery.scheduled',
      recovery: {
        caseId: row.id,
        revision: row.revision,
        channel: config.channels[0],
        inbound: inbound ? (row.latestResponse?.body.slice(0, 1000) ?? null) : null,
      },
    },
    now,
  );
  await tx.recoveryCase.update({
    where: { organizationId_id: { organizationId, id } },
    data: { pendingRunId: run.id, state: inbound ? 'awaiting_classification' : 'working' },
  });
  return run;
}
/** Bounded and cursor-based, so large pipelines do not repeatedly scan only their first page. */
export async function scanRecovery(database: Database, organizationId?: string, now = new Date()) {
  if (
    process.env.REVENUE_RECOVERY_ENABLED !== 'true' ||
    process.env.AGENT_RUNTIME_ENABLED !== 'true'
  )
    return 0;
  const programs = await database.recoveryProgram.findMany({
    where: {
      ...(organizationId ? { organizationId } : {}),
      nextScanAt: { lte: now },
    },
    orderBy: [{ nextScanAt: 'asc' }, { id: 'asc' }],
    take: 20,
  });
  let admitted = 0;
  for (const p of programs)
    await tenantTransaction(database, p.organizationId, async (tx) => {
      const program = await tx.recoveryProgram.findFirstOrThrow({
        where: { organizationId: p.organizationId, id: p.id },
        include: { runtimeVersion: true, agent: true, organization: true },
      });
      if (program.nextScanAt > now) return;
      await tx.recoveryProgram.update({
        where: { organizationId_id: { organizationId: p.organizationId, id: p.id } },
        data: { nextScanAt: new Date(now.getTime() + 60000) },
      });
      const expired = await tx.recoveryDispatch.findMany({
        where: {
          organizationId: p.organizationId,
          status: 'dispatching',
          claimedUntil: { lte: now },
        },
        take: 50,
      });
      for (const dispatch of expired) {
        await tx.recoveryDispatch.update({
          where: { organizationId_id: { organizationId: p.organizationId, id: dispatch.id } },
          data: { status: 'unknown', errorCode: 'delivery_outcome_unknown' },
        });
        const row = await loadCase(tx, p.organizationId, dispatch.caseId);
        if (process.env.COMMUNICATIONS_ENABLED === 'true')
          await recoveryStatus(
            tx,
            p.organizationId,
            dispatch.id,
            'unknown',
            null,
            'delivery_outcome_unknown',
            now,
          );
        await pauseCase(tx, row, 'handoff', 'delivery_outcome_unknown', now);
        await ensureHandoff(
          tx,
          row,
          'delivery_outcome_unknown',
          'Check the provider receipt. Do not resend without evidence that delivery did not occur.',
          now,
        );
      }
      if (!program.agent.enabled || !program.organization.active) return;
      const config = parseConfig(program.runtimeVersion.specialization);
      const opportunities = await tx.opportunity.findMany({
        where: {
          organizationId: p.organizationId,
          status: { in: ['open', 'estimate_sent'] },
          currency: config.currency,
          lastActivityAt: { lte: new Date(now.getTime() - config.delayMinutes * 60000) },
          ...(program.scanCursor ? { id: { gt: program.scanCursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: 50,
        select: { id: true },
      });
      for (const opportunity of opportunities) await enroll(tx, program, opportunity.id, now);
      await tx.recoveryProgram.update({
        where: { organizationId_id: { organizationId: p.organizationId, id: p.id } },
        data: {
          scanCursor: opportunities.length === 50 ? opportunities[49]!.id : null,
          nextScanAt: new Date(now.getTime() + 60000),
        },
      });
      // Dispatch leases have an unknown outcome, never an automatic resend.
      const due = await tx.recoveryCase.findMany({
        where: {
          organizationId: p.organizationId,
          state: { in: ['monitoring', 'working'] },
          nextDueAt: { lte: now },
          OR: [
            { pendingRunId: null },
            { pendingRun: { status: { in: ['completed', 'failed', 'stopped'] } } },
          ],
          dispatches: { none: { status: { in: ['pending', 'dispatching', 'unknown'] } } },
        },
        orderBy: [{ nextDueAt: 'asc' }, { id: 'asc' }],
        take: 50,
      });
      for (const row of due) {
        if (
          await tx.recoveryDispatch.findFirst({
            where: {
              organizationId: p.organizationId,
              caseId: row.id,
              status: { in: ['pending', 'dispatching', 'unknown'] },
            },
          })
        )
          continue;
        try {
          if (await startCase(tx, p.organizationId, row.id, now)) admitted++;
        } catch (error) {
          if (!(error instanceof WorkforceError)) throw error;
          await audit(
            tx,
            p.organizationId,
            'recovery-scheduler',
            'recovery.admission_blocked',
            row.id,
            { code: error.code },
          );
        }
      }
      await audit(
        tx,
        p.organizationId,
        'recovery-scheduler',
        'recovery.scan_completed',
        program.id,
        { scanned: opportunities.length, considered: due.length },
      );
    });
  return admitted;
}
