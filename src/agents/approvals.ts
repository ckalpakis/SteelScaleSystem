import { parseDecision, parseDefinition } from './contracts.js';
import { eligible, loadContext } from './context.js';
import { authorizeCurrent } from './service.js';
import { actionPolicy, checkReferences, finishRun } from './runtime.js';
import { executeTool, getTool, validateTool } from './tools.js';
import { audit } from '../workforce/audit/service.js';
import {
  json,
  string,
  tenantTransaction,
  uuid,
  WorkforceError,
  type Database,
} from '../workforce/shared.js';
import type { Principal } from '../workforce/tenancy/service.js';
import { publishCompletion } from './facts.js';

export async function decideApproval(
  database: Database,
  principal: Principal,
  id: string,
  decision: 'approve' | 'reject',
  reason: string,
) {
  uuid(id);
  string(reason, 1000);
  if (!['approve', 'reject'].includes(decision))
    throw new WorkforceError(400, 'invalid_approval_decision');
  return tenantTransaction(database, principal.organizationId, async (tx) => {
    await authorizeCurrent(tx, principal, 'approvals:write');
    const organizationId = principal.organizationId,
      now = new Date();
    const approval = await tx.humanApproval.findFirst({
      where: { organizationId, id },
      include: { action: { include: { run: { include: { version: true } } } } },
    });
    if (!approval) throw new WorkforceError(404, 'approval_not_found');
    const { action } = approval,
      { run } = action;
    if (
      approval.status !== 'pending' ||
      action.status !== 'pending_approval' ||
      run.status !== 'waiting_approval'
    )
      throw new WorkforceError(409, 'approval_already_decided');
    const config = parseDefinition(run.version.definition),
      tool = getTool(action.tool);
    const input = parseDecision({
      kind: 'tool',
      summary: 'Previously reviewed action',
      tool: action.tool,
      input: action.input,
    }).input;
    let blocked =
      approval.expiresAt <= now
        ? 'approval_expired'
        : decision === 'reject'
          ? 'human_rejected'
          : undefined;
    let result: unknown;
    let policy: unknown;
    if (!blocked) {
      try {
        const context = await loadContext(tx, organizationId, run.subjectId, config);
        if (context.fingerprint !== action.contextFingerprint || !eligible(config, context, now))
          throw new WorkforceError(409, 'approval_context_changed');
        validateTool(tool, input, context, config, now);
        await checkReferences(tx, organizationId, input, context);
        const evaluated = await actionPolicy(tx, run, config, tool, context, now, true, input);
        policy = evaluated;
        if (evaluated.outcome !== 'allow') blocked = evaluated.reason;
      } catch (error) {
        if (error instanceof WorkforceError) blocked = error.code;
        else throw error;
      }
    }
    // Execution is DB-only and atomic with the approval. Never catch SQL failures inside
    // a PostgreSQL transaction and pretend it committed: they roll everything back.
    if (!blocked)
      result = await executeTool(
        tx,
        database,
        organizationId,
        run.agentId,
        run.id,
        action.id,
        tool,
        input,
        await loadContext(tx, organizationId, run.subjectId, config),
      );
    const status = blocked === 'approval_expired' ? 'expired' : blocked ? 'rejected' : 'approved';
    await tx.humanApproval.update({
      where: { organizationId_id: { organizationId, id } },
      data: { status, decidedAt: now, decidedBy: principal.actor, reason },
    });
    await tx.agentAction.update({
      where: { organizationId_id: { organizationId, id: action.id } },
      data: {
        status: blocked ? 'blocked' : 'completed',
        completedAt: now,
        errorCode: blocked ?? null,
        policyResult: json(policy ?? { outcome: 'deny', reason: blocked }),
        ...(result ? { result: json(result) } : {}),
      },
    });
    await tx.agentStep.update({
      where: {
        organizationId_runId_sequence: { organizationId, runId: run.id, sequence: action.sequence },
      },
      data: {
        policyResult: json(policy ?? { outcome: 'deny', reason: blocked }),
        ...(result ? { result: json(result) } : {}),
      },
    });
    await audit(tx, organizationId, principal.actor, 'agent.approval_decided', id, {
      actionId: action.id,
      status,
      blocked,
    });
    if (blocked)
      await finishRun(
        tx,
        run,
        'stopped',
        'Human approval rejected, expired or no longer safe.',
        blocked,
      );
    else {
      await publishCompletion(tx, run, action.id, tool.name);
      await audit(tx, organizationId, principal.actor, 'agent.action_completed', action.id, {
        tool: tool.name,
      });
      await tx.agentRun.update({
        where: { organizationId_id: { organizationId, id: run.id } },
        data: {
          status: 'pending',
          availableAt: now,
          deadlineAt: new Date(now.getTime() + config.limits.maxRunSeconds * 1000),
        },
      });
    }
    return { status, executed: !blocked, result, blocked };
  });
}
