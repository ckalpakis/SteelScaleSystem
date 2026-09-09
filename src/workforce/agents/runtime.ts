import type { BusinessEvent } from '../../events/contracts.js';
import { audit } from '../audit/service.js';
import { json, type Transaction } from '../shared.js';
import { evaluatePolicy } from '../policy/engine.js';
import { getTool } from '../tools/registry.js';
import { parseRecoveryConfig } from './config.js';

export async function evaluateEvent(
  tx: Transaction,
  event: BusinessEvent,
  now = new Date(),
): Promise<void> {
  if (
    !['opportunity.created', 'opportunity.updated', 'recovery.scan.requested'].includes(event.type)
  )
    return;
  const organizationId = event.organizationId;
  const agents = await tx.workforceAgent.findMany({
    where: { organizationId, enabled: true, kind: 'revenue_recovery' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 20,
  });
  let remainingBudget = 100;
  for (const agent of agents) {
    const prior = await tx.workforceRun.findUnique({
      where: {
        organizationId_agentId_eventId: { organizationId, agentId: agent.id, eventId: event.id },
      },
    });
    if (prior) continue;
    const config = parseRecoveryConfig(agent.config);
    const limit = Math.min(config.maxCandidates, remainingBudget);
    const cutoff = new Date(now.getTime() - config.staleAfterDays * 86_400_000);
    const candidates = await tx.opportunity.findMany({
      where: {
        organizationId,
        status: { in: ['open', 'estimate_sent'] },
        lastActivityAt: { lte: cutoff },
        record: { archivedAt: null },
        customer: { doNotContact: false, record: { archivedAt: null } },
        // One reviewed follow-up per opportunity in this foundation, across all recovery agents.
        // Later cadence work must explicitly define contact limits and re-entry conditions.
        actions: { none: { tool: 'recovery.prepare_handoff' } },
      },
      include: { customer: true },
      orderBy: [{ lastActivityAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    const run = await tx.workforceRun.create({
      data: {
        organizationId,
        agentId: agent.id,
        eventId: event.id,
        configVersion: agent.configVersion,
        configSnapshot: json(config),
        decision: json({
          engine: 'deterministic-recovery-v1',
          evaluatedAt: now.toISOString(),
          cutoff: cutoff.toISOString(),
          candidateIds: candidates.map(({ id }) => id),
          reason: 'Open or unsold, stale, not suppressed, and no previous recovery action.',
          limit,
          atLimit: candidates.length === limit,
          budgetExhausted: limit === 0,
        }),
      },
    });
    remainingBudget -= candidates.length;
    for (const opportunity of candidates) {
      const tool = getTool('recovery.prepare_handoff');
      const policy = evaluatePolicy({
        enabled: agent.enabled,
        tool: tool.name,
        config,
        doNotContact: opportunity.customer.doNotContact,
        opportunityStatus: opportunity.status,
      });
      const input = tool.validate({
        opportunityId: opportunity.id,
        customerId: opportunity.customerId,
        message: `Hi ${opportunity.customer.name}, following up on ${opportunity.title}. Would you like to discuss the estimate or the next steps?`,
      });
      const action = await tx.workforceAction.create({
        data: {
          organizationId,
          runId: run.id,
          opportunityId: opportunity.id,
          tool: tool.name,
          input: json(input),
          policyDecision: json(policy),
          status: policy.outcome === 'deny' ? 'blocked' : 'pending_approval',
        },
      });
      if (policy.outcome === 'require_approval')
        await tx.workforceApproval.create({
          data: {
            organizationId,
            actionId: action.id,
            expiresAt: new Date(now.getTime() + 7 * 86_400_000),
          },
        });
      await audit(tx, organizationId, `agent:${agent.id}`, 'action.proposed', action.id, policy);
    }
    await audit(tx, organizationId, `agent:${agent.id}`, 'agent.evaluated', run.id, {
      candidateCount: candidates.length,
    });
  }
}
