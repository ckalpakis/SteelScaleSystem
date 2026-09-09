import type { Transaction } from '../workforce/shared.js';
import { WorkforceError } from '../workforce/shared.js';
import { audit } from '../workforce/audit/service.js';
import { parseConfig, type RecoveryConfig } from './contracts.js';
import { EventPublisher } from '../events/publisher.js';
import { operatingNow } from '../agents/policy.js';
import { safetyIntent } from './decisions.js';
import { currentPublicClaim } from '../knowledge/retrieval.js';
import { assertContactAllowed } from '../communications/safety.js';
import { recoveryStatus } from '../communications/ledger.js';

export const liveStates = ['monitoring', 'working', 'awaiting_classification'];
export async function loadCase(tx: Transaction, organizationId: string, id: string) {
  const row = await tx.recoveryCase.findFirst({
    where: { organizationId, id },
    include: {
      program: {
        include: { agent: true, runtimeVersion: true, organization: true, connection: true },
      },
      opportunity: {
        include: {
          record: true,
          stage: { include: { record: true, pipeline: { include: { record: true } } } },
        },
      },
      contact: { include: { record: true } },
      conversation: { include: { record: true } },
      latestResponse: true,
      handoff: true,
    },
  });
  if (!row) throw new WorkforceError(404, 'recovery_case_not_found');
  return row;
}
export type CaseSnapshot = Awaited<ReturnType<typeof loadCase>>;
export function baseEligibility(config: RecoveryConfig, row: CaseSnapshot): string | null {
  const o = row.opportunity;
  if (!row.program.organization.active) return 'organization_inactive';
  if (!row.program.agent.enabled) return 'agent_disabled';
  if (row.program.agent.configVersion !== row.program.runtimeVersion.number)
    return 'recovery_version_changed';
  if (row.contact.id !== o.customerId || row.contact.record.archivedAt || o.record.archivedAt)
    return 'record_ineligible';
  if (row.contact.doNotContact) return 'opt_out';
  if (!['open', 'estimate_sent'].includes(o.status)) return o.status;
  if (o.currency !== config.currency || o.amountMinor < config.minimumValueMinor)
    return 'value_ineligible';
  if (o.stage?.pipeline.record.archivedAt) return 'pipeline_ineligible';
  if (config.pipelineIds.length && (!o.pipelineId || !config.pipelineIds.includes(o.pipelineId)))
    return 'pipeline_ineligible';
  if (config.stageIds.length && (!o.stageId || !config.stageIds.includes(o.stageId)))
    return 'stage_ineligible';
  if (o.stage && (o.stage.outcome !== 'open' || o.stage.record.archivedAt))
    return 'stage_ineligible';
  return null;
}
export function windowOpen(config: RecoveryConfig, now: Date) {
  return operatingNow({ operatingHours: config.workingHours }, now);
}
export async function messageGuard(
  tx: Transaction,
  row: CaseSnapshot,
  channel: string,
  now: Date,
  options: {
    human?: boolean;
    dispatchId?: string;
    ignoreDue?: boolean;
    reservedAttempt?: boolean;
  } = {},
) {
  const config = parseConfig(row.program.runtimeVersion.specialization);
  const base = baseEligibility(config, row);
  if (base) return base;
  if (process.env.COMMUNICATIONS_ENABLED === 'true') {
    try {
      await assertContactAllowed(tx, row.organizationId, row.contactId, channel);
    } catch (error) {
      if (error instanceof WorkforceError) return error.code;
      throw error;
    }
  }
  if (!options.human) {
    for (const knowledge of config.knowledge) {
      if (!knowledge.versionId && process.env.BUSINESS_KNOWLEDGE_ENABLED === 'true')
        return 'approved_knowledge_version_required';
      if (knowledge.versionId) {
        try {
          await currentPublicClaim(tx, row.organizationId, knowledge.versionId, knowledge.text);
        } catch (error) {
          if (error instanceof WorkforceError) return error.code;
          throw error;
        }
      }
    }
  }
  if (!options.human && !['monitoring', 'working'].includes(row.state)) return 'recovery_paused';
  if (
    row.conversation &&
    (row.conversation.status !== 'open' ||
      row.conversation.record.archivedAt ||
      row.conversation.contactId !== row.contactId)
  )
    return 'conversation_ineligible';
  if (!config.channels.some((c) => c === channel)) return 'channel_not_allowed';
  const destination = channel === 'sms' ? row.contact.phone : row.contact.email;
  if (
    !destination ||
    (channel === 'sms'
      ? !/^\+[1-9]\d{7,14}$/.test(destination)
      : !/^\S+@\S+\.\S+$/.test(destination))
  )
    return 'destination_missing_or_invalid';
  if (
    !(
      await tx.recoveryConsent.findUnique({
        where: {
          organizationId_contactId_channel: {
            organizationId: row.organizationId,
            contactId: row.contactId,
            channel,
          },
        },
      })
    )?.granted
  )
    return 'consent_required';
  if (!windowOpen(config, now)) return 'outside_operating_hours';
  // Employee-written dispatches must not overtake an unprocessed STOP either.
  if (options.human) {
    const unseen = await tx.message.findMany({
      where: {
        organizationId: row.organizationId,
        direction: 'inbound',
        conversation: { contactId: row.contactId },
        createdAt: { gte: row.latestResponse?.createdAt ?? row.baselineActivityAt },
        ...(row.latestResponseId ? { NOT: { id: row.latestResponseId } } : {}),
        record: { archivedAt: null },
      },
      select: { body: true },
      take: 101,
    });
    if (unseen.length > 100 || unseen.some((m) => safetyIntent(m.body) === 'opt_out'))
      return 'unprocessed_opt_out';
  }
  if (!options.human && row.attempts - (options.reservedAttempt ? 1 : 0) >= config.maximumAttempts)
    return 'attempt_limit';
  if (!options.human && !options.ignoreDue && (!row.nextDueAt || row.nextDueAt > now))
    return 'not_due';
  if (
    !options.human &&
    row.attempts === 0 &&
    row.opportunity.lastActivityAt.getTime() + config.delayMinutes * 60000 > now.getTime()
  )
    return 'first_contact_delay';
  if (
    await tx.estimate.findFirst({
      where: {
        organizationId: row.organizationId,
        opportunityId: row.opportunityId,
        status: { in: ['accepted', 'declined'] },
        record: { archivedAt: null },
      },
    })
  )
    return 'estimate_ineligible';
  if (
    await tx.appointment.findFirst({
      where: {
        organizationId: row.organizationId,
        opportunityId: row.opportunityId,
        status: { in: ['scheduled', 'completed'] },
        createdAt: { gte: row.enrolledAt },
        record: { archivedAt: null },
      },
    })
  )
    return 'appointment_booked';
  if (!options.human) {
    if (
      await tx.recoveryCase.findFirst({
        where: {
          organizationId: row.organizationId,
          contactId: row.contactId,
          state: { in: ['human_owned', 'handoff', 'awaiting_classification', 'engaged'] },
          NOT: { id: row.id },
        },
      })
    )
      return 'contact_human_controlled';
    if (row.handoff && ['open', 'owned'].includes(row.handoff.status)) return 'human_handoff';
    const quietSince = new Date(now.getTime() - config.employeeQuietMinutes * 60000);
    if (row.employeeActionAt && row.employeeActionAt >= quietSince) return 'recent_employee_action';
    // Read canonical facts directly: do not wait for the async event handler to catch up.
    if (
      await tx.businessEvent.findFirst({
        where: {
          organizationId: row.organizationId,
          receivedAt: { gte: quietSince },
          actor: { startsWith: 'member:' },
          OR: [
            {
              entityId: {
                in: [
                  row.opportunityId,
                  row.contactId,
                  ...(row.conversationId ? [row.conversationId] : []),
                ],
              },
            },
            {
              links: {
                some: {
                  recordId: {
                    in: [
                      row.opportunityId,
                      row.contactId,
                      ...(row.conversationId ? [row.conversationId] : []),
                    ],
                  },
                },
              },
            },
          ],
        },
      })
    )
      return 'recent_employee_action';
    const response = await tx.message.findFirst({
      where: {
        organizationId: row.organizationId,
        direction: 'inbound',
        conversation: { contactId: row.contactId },
        createdAt: { gte: row.latestResponse?.createdAt ?? row.baselineActivityAt },
        ...(row.latestResponseId ? { NOT: { id: row.latestResponseId } } : {}),
        record: { archivedAt: null },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (response) return 'unprocessed_customer_response';
    // Unknown external outbound activity is treated as employee contact unless it is our
    // own receipt (identified by the canonical agent actor), not guessed from message text.
    if (
      await tx.businessEvent.findFirst({
        where: {
          organizationId: row.organizationId,
          type: 'message.created',
          receivedAt: { gte: quietSince },
          NOT: { actor: { startsWith: 'agent:' } },
          links: { some: { recordId: row.conversationId ?? row.contactId } },
        },
      })
    )
      return 'recent_conversation_activity';
  }
  if (
    await tx.recoveryDispatch.findFirst({
      where: {
        organizationId: row.organizationId,
        case: { contactId: row.contactId },
        status: { in: ['pending', 'dispatching', 'unknown'] },
        ...(options.dispatchId ? { NOT: { id: options.dispatchId } } : {}),
      },
    })
  )
    return 'duplicate_or_unresolved_dispatch';
  return null;
}
export async function pauseCase(
  tx: Transaction,
  row: Pick<CaseSnapshot, 'organizationId' | 'id' | 'pendingRunId'>,
  state: string,
  reason: string,
  now = new Date(),
) {
  await tx.recoveryCase.update({
    where: { organizationId_id: { organizationId: row.organizationId, id: row.id } },
    data: { state, reason, revision: { increment: 1 }, nextDueAt: null },
  });
  await tx.recoveryDispatch.updateMany({
    where: { organizationId: row.organizationId, caseId: row.id, status: 'pending' },
    data: { status: 'cancelled', errorCode: reason },
  });
  if (process.env.COMMUNICATIONS_ENABLED === 'true') {
    const deliveries = await tx.communicationDelivery.findMany({
      where: {
        organizationId: row.organizationId,
        recoveryDispatch: { caseId: row.id, status: 'cancelled' },
        status: 'awaiting_provider',
      },
      select: { recoveryDispatchId: true },
    });
    for (const delivery of deliveries)
      await recoveryStatus(
        tx,
        row.organizationId,
        delivery.recoveryDispatchId!,
        'cancelled',
        null,
        reason,
        now,
      );
  }
  if (row.pendingRunId) {
    await tx.agentRun.updateMany({
      where: {
        organizationId: row.organizationId,
        id: row.pendingRunId,
        status: { in: ['pending', 'running', 'waiting_approval'] },
      },
      data: {
        status: 'stopped',
        completedAt: now,
        errorCode: reason,
        leaseToken: null,
        leasedUntil: null,
      },
    });
    await tx.humanApproval.updateMany({
      where: {
        organizationId: row.organizationId,
        status: 'pending',
        action: { runId: row.pendingRunId },
      },
      data: { status: 'rejected', reason, decidedBy: 'recovery-safety', decidedAt: now },
    });
    await tx.agentAction.updateMany({
      where: {
        organizationId: row.organizationId,
        runId: row.pendingRunId,
        status: 'pending_approval',
      },
      data: { status: 'blocked', errorCode: reason, completedAt: now },
    });
  }
}
export async function ensureHandoff(
  tx: Transaction,
  row: CaseSnapshot,
  reason: string,
  summary: string,
  now = new Date(),
) {
  const handoff = await tx.recoveryHandoff.upsert({
    where: { organizationId_caseId: { organizationId: row.organizationId, caseId: row.id } },
    create: {
      organizationId: row.organizationId,
      caseId: row.id,
      assignedMemberId: row.opportunity.record.assignedMemberId,
      reason,
      summary,
    },
    update: {
      reason,
      summary,
      ...(row.handoff?.status === 'owned' ? {} : { status: 'open' }),
      revision: { increment: 1 },
    },
  });
  await audit(tx, row.organizationId, 'recovery-safety', 'recovery.handoff_created', handoff.id, {
    caseId: row.id,
    reason,
  });
  await new EventPublisher().publishInTransaction(
    tx,
    {
      organizationId: row.organizationId,
      system: 'steel_scale_agent',
      provider: 'steel_scale',
      actor: `agent:${row.program.agentId}`,
    },
    {
      version: 2,
      type: 'agent.handoff_created',
      entity: { type: 'opportunity', id: row.opportunityId },
      occurredAt: now.toISOString(),
      idempotencyKey: `recovery-handoff:${handoff.id}:${handoff.revision}`,
      data: { changes: { handoffId: handoff.id, reason } },
      relatedRecordIds: [row.opportunityId, row.contactId],
    },
  );
  return handoff;
}
