import type { AgentRun } from '@prisma/client';
import type { RunContext } from '../agents/context.js';

export function agentTrace(run: AgentRun, context?: RunContext) {
  return {
    organizationId: run.organizationId,
    agentId: run.agentId,
    runId: run.id,
    eventId: run.eventId ?? undefined,
    correlationId: run.correlationId,
    subjectId: run.subjectId,
    contactId: context?.records.find((r) => r.type === 'contact')?.id,
    opportunityId: context?.records.find((r) => r.type === 'opportunity')?.id,
  };
}
