import { audit } from '../audit/service.js';
import { tenantTransaction, WorkforceError, type Database } from '../shared.js';
import { authorize, type Principal } from '../tenancy/service.js';
import { publishAgentFact } from '../events/facts.js';

export interface RevenueEvidence {
  opportunityId: string;
  actionId: string;
  externalPaymentId: string;
  amountMinor: number;
  currency: string;
  evidence: string;
  paidAt: Date;
}

export async function recordRevenue(
  database: Database,
  principal: Principal,
  input: RevenueEvidence,
) {
  authorize(principal, 'revenue:write');
  const organizationId = principal.organizationId;
  return tenantTransaction(database, organizationId, async (tx) => {
    const action = await tx.workforceAction.findUnique({
      where: {
        organizationId_id: { organizationId, id: input.actionId },
      },
      include: { opportunity: true },
    });
    if (!action || action.opportunityId !== input.opportunityId)
      throw new WorkforceError(404, 'action_not_found');
    if (
      action.status !== 'completed' ||
      !action.completedAt ||
      action.completedAt > input.paidAt ||
      action.opportunity.status !== 'won' ||
      action.opportunity.currency !== input.currency
    ) {
      throw new WorkforceError(409, 'revenue_evidence_conflict');
    }
    const existing = await tx.workforceRevenue.findUnique({
      where: {
        organizationId_externalPaymentId: {
          organizationId,
          externalPaymentId: input.externalPaymentId,
        },
      },
    });
    if (existing) {
      if (
        existing.actionId !== input.actionId ||
        existing.amountMinor !== input.amountMinor ||
        existing.currency !== input.currency ||
        existing.evidence !== input.evidence ||
        existing.paidAt.getTime() !== input.paidAt.getTime()
      ) {
        throw new WorkforceError(409, 'payment_id_reused');
      }
      return existing;
    }
    const revenue = await tx.workforceRevenue.create({
      data: { organizationId, ...input, recordedBy: principal.actor },
    });
    await audit(tx, organizationId, principal.actor, 'revenue.recorded', revenue.id, {
      attribution: 'operator_reported_assisted',
      actionId: action.id,
      amountMinor: input.amountMinor,
      currency: input.currency,
    });
    await publishAgentFact(
      tx,
      organizationId,
      principal.actor,
      'opportunity.recovered',
      input.opportunityId,
      revenue.id,
      {
        revenueId: revenue.id,
        actionId: action.id,
        amountMinor: input.amountMinor,
        currency: input.currency,
      },
    );
    return revenue;
  });
}
