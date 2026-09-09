import type { AgentRun } from '@prisma/client';
import { EventPublisher } from '../events/publisher.js';
import type { Transaction } from '../workforce/shared.js';

/** A committed internal action receipt, not a provider delivery or financial claim. */
export async function publishCompletion(
  tx: Transaction,
  run: AgentRun,
  actionId: string,
  tool: string,
) {
  const record = await tx.crmRecord.findFirstOrThrow({
    where: { organizationId: run.organizationId, id: run.subjectId },
  });
  return new EventPublisher().publishInTransaction(
    tx,
    {
      organizationId: run.organizationId,
      system: 'steel_scale_agent',
      provider: 'steel_scale',
      actor: `agent:${run.agentId}`,
    },
    {
      version: 2,
      type: 'agent.action_completed',
      entity: { type: record.entityType, id: record.id },
      occurredAt: new Date().toISOString(),
      idempotencyKey: `agent:${actionId}:completed`,
      correlationId: run.correlationId,
      ...(run.eventId ? { causationId: run.eventId } : {}),
      relatedRecordIds: [record.id],
      data: { changes: { actionId, runId: run.id, tool, deliveryStatus: 'internal_only' } },
    },
  );
}
