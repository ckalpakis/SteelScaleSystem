import { audit } from '../audit/service.js';
import { parseRecoveryConfig } from '../agents/config.js';
import { evaluatePolicy } from '../policy/engine.js';
import { json, tenantTransaction, WorkforceError, type Database } from '../shared.js';
import { authorize, type Principal } from '../tenancy/service.js';
import { getTool } from '../tools/registry.js';
import { publishAgentFact } from '../events/facts.js';

export async function decideApproval(
  database: Database,
  principal: Principal,
  approvalId: string,
  decision: 'approve' | 'reject',
  reason: string,
  now = new Date(),
) {
  authorize(principal, 'approvals:write');
  return tenantTransaction(database, principal.organizationId, async (tx) => {
    const organizationId = principal.organizationId;
    const approval = await tx.workforceApproval.findUnique({
      where: {
        organizationId_id: { organizationId, id: approvalId },
      },
      include: {
        action: {
          include: {
            run: { include: { agent: true } },
            opportunity: { include: { customer: true } },
          },
        },
      },
    });
    if (!approval) throw new WorkforceError(404, 'approval_not_found');
    if (approval.status !== 'pending') throw new WorkforceError(409, 'approval_already_decided');
    const { action } = approval;
    const { agent } = action.run;
    const config = parseRecoveryConfig(agent.config);
    const policy = evaluatePolicy({
      enabled: agent.enabled,
      tool: action.tool,
      config,
      doNotContact: action.opportunity.customer.doNotContact,
      opportunityStatus: action.opportunity.status,
    });
    const expired = approval.expiresAt <= now;
    const stale =
      agent.configVersion !== action.run.configVersion ||
      action.opportunity.lastActivityAt.getTime() >
        now.getTime() - config.staleAfterDays * 86_400_000 ||
      action.opportunity.updatedAt > action.createdAt ||
      action.opportunity.customer.updatedAt > action.createdAt;
    const archived = await tx.crmRecord.count({
      where: {
        organizationId,
        id: { in: [action.opportunityId, action.opportunity.customerId] },
        archivedAt: { not: null },
      },
    });
    const blocked = policy.outcome === 'deny' || stale || archived > 0;
    const approved = decision === 'approve' && !expired && !blocked;
    const tool = getTool(action.tool);
    const input = tool.validate(action.input);
    if (
      input.opportunityId !== action.opportunityId ||
      input.customerId !== action.opportunity.customerId
    ) {
      throw new WorkforceError(409, 'action_input_conflict');
    }
    const result = approved ? tool.execute(input) : undefined;
    const updated = await tx.workforceApproval.update({
      where: { organizationId_id: { organizationId, id: approvalId } },
      data: {
        status: expired ? 'expired' : approved ? 'approved' : 'rejected',
        decidedAt: now,
        decidedBy: principal.actor,
        reason,
      },
    });
    await tx.workforceAction.update({
      where: { organizationId_id: { organizationId, id: action.id } },
      data: {
        status: approved ? 'completed' : expired || blocked ? 'blocked' : 'rejected',
        result: result ? json(result) : undefined,
        completedAt: now,
        policyDecision: json({ ...policy, expired, stale, requestedDecision: decision }),
      },
    });
    await audit(tx, organizationId, principal.actor, 'approval.decided', approvalId, {
      status: updated.status,
      actionId: action.id,
      expired,
      stale,
      policy,
    });
    if (approved) {
      await publishAgentFact(
        tx,
        organizationId,
        principal.actor,
        'agent.handoff_created',
        action.opportunityId,
        action.id,
        {
          actionId: action.id,
          customerId: action.opportunity.customerId,
          deliveryStatus: 'not_sent',
        },
      );
      await publishAgentFact(
        tx,
        organizationId,
        principal.actor,
        'agent.action_completed',
        action.opportunityId,
        action.id,
        { actionId: action.id, deliveryStatus: 'not_sent' },
      );
      await audit(tx, organizationId, principal.actor, 'action.completed', action.id, {
        deliveryStatus: 'not_sent',
      });
    }
    return { approval: updated, executed: approved, result };
  });
}
