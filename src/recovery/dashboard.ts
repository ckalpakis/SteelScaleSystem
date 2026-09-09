import { RecoveryService } from './service.js';
export class RecoveryDashboardService extends RecoveryService {
  dashboard() {
    return this.tx(async (tx, organizationId) => {
      const [
        program,
        unsold,
        monitored,
        working,
        engaged,
        responses,
        outcomes,
        handoffs,
        activity,
        approvals,
        dispatchErrors,
        simulations,
      ] = await Promise.all([
        tx.recoveryProgram.findUnique({
          where: { organizationId },
          include: {
            agent: { select: { id: true, enabled: true, configVersion: true } },
            runtimeVersion: { select: { number: true, specialization: true } },
          },
        }),
        tx.opportunity.groupBy({
          by: ['currency'],
          where: {
            organizationId,
            status: { in: ['open', 'estimate_sent'] },
            record: { archivedAt: null },
          },
          _count: true,
          _sum: { amountMinor: true },
        }),
        tx.recoveryCase.groupBy({
          by: ['currency'],
          where: { organizationId },
          _count: true,
          _sum: { monitoredValueMinor: true },
        }),
        tx.recoveryCase.count({
          where: { organizationId, state: { in: ['monitoring', 'working'] } },
        }),
        tx.recoveryCase.findMany({
          where: { organizationId, engagedAt: { not: null } },
          distinct: ['contactId'],
          select: { contactId: true },
        }),
        tx.$queryRaw<
          Array<{ count: bigint }>
        >`SELECT count(DISTINCT m.id) AS count FROM "Message" m JOIN "Conversation" c ON c.id=m."conversationId" AND c."organizationId"=m."organizationId" JOIN "RecoveryCase" r ON r."contactId"=c."contactId" AND r."organizationId"=c."organizationId" WHERE m."organizationId"=${organizationId}::uuid AND m.direction='inbound' AND r."firstDeliveredAt" IS NOT NULL AND m."occurredAt">=r."firstDeliveredAt"`,
        tx.recoveryAttribution.groupBy({
          by: ['kind', 'status', 'currency'],
          where: { organizationId },
          _count: true,
          _sum: { amountMinor: true },
        }),
        tx.recoveryHandoff.findMany({
          where: { organizationId, status: { in: ['open', 'owned'] } },
          include: {
            assignedMember: { select: { id: true, displayName: true } },
            case: {
              include: {
                contact: { select: { name: true } },
                opportunity: { select: { title: true, amountMinor: true, currency: true } },
              },
            },
          },
          orderBy: { updatedAt: 'desc' },
          take: 50,
        }),
        tx.auditLog.findMany({
          where: { organizationId, type: { startsWith: 'recovery.' } },
          orderBy: { createdAt: 'desc' },
          take: 30,
        }),
        tx.humanApproval.findMany({
          where: { organizationId, status: 'pending', action: { tool: 'send_recovery_message' } },
          include: {
            action: { select: { id: true, input: true, run: { select: { subjectId: true } } } },
          },
          orderBy: { createdAt: 'asc' },
          take: 50,
        }),
        tx.recoveryDispatch.findMany({
          where: { organizationId, status: { in: ['failed', 'unknown', 'cancelled'] } },
          select: { id: true, caseId: true, status: true, errorCode: true, updatedAt: true },
          orderBy: { updatedAt: 'desc' },
          take: 30,
        }),
        tx.recoverySimulation.findMany({
          where: { organizationId },
          select: { id: true, scenarioKey: true, result: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 5,
        }),
      ]);
      const needsHuman = await tx.recoveryHandoff.count({
        where: { organizationId, status: { in: ['open', 'owned'] } },
      });
      return {
        program,
        metrics: {
          unsoldPipeline: unsold,
          monitoredPipeline: monitored,
          currentlyWorked: working,
          contactsEngaged: engaged.length,
          responsesGenerated: Number(responses[0]?.count ?? 0),
          needsHumanAttention: needsHuman,
          appointmentsRecovered: outcomes
            .filter((o) => o.kind === 'appointment' && o.status === 'AI_RECOVERED')
            .reduce((n, o) => n + o._count, 0),
          dealsRecovered: outcomes
            .filter((o) => o.kind === 'opportunity' && o.status === 'AI_RECOVERED')
            .reduce((n, o) => n + o._count, 0),
          recoveredRevenue: outcomes
            .filter((o) => o.kind === 'opportunity' && o.status === 'AI_RECOVERED')
            .map((o) => ({ currency: o.currency, amountMinor: o._sum.amountMinor ?? 0 })),
          attributionBreakdown: outcomes,
        },
        handoffs,
        approvals,
        dispatchErrors,
        activity,
        simulations,
      };
    }, 'crm:read');
  }
}
