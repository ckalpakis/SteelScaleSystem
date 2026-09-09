import type { AgentRun } from '@prisma/client';
import type { ToolInput } from '../agents/contracts.js';
import {
  json,
  object,
  string,
  uuid,
  WorkforceError,
  type Transaction,
} from '../workforce/shared.js';
import { audit } from '../workforce/audit/service.js';
import { parseConfig } from './contracts.js';
import { normalizeDecision } from './decisions.js';
import { ensureHandoff, loadCase, messageGuard } from './lifecycle.js';
import { currentPublicClaim } from '../knowledge/retrieval.js';
import { recordRecoveryDispatch } from '../communications/ledger.js';

async function runCase(
  tx: Transaction,
  run: Pick<AgentRun, 'id' | 'organizationId' | 'agentId' | 'subjectId' | 'versionId' | 'trigger'>,
) {
  const trigger = object(object(run.trigger).recovery),
    row = await loadCase(tx, run.organizationId, uuid(trigger.caseId));
  if (
    process.env.REVENUE_RECOVERY_ENABLED !== 'true' ||
    row.program.agentId !== run.agentId ||
    row.opportunityId !== run.subjectId ||
    row.pendingRunId !== run.id ||
    row.program.runtimeVersionId !== run.versionId ||
    row.revision !== trigger.revision
  )
    throw new WorkforceError(409, 'recovery_context_changed');
  return { row, trigger };
}
export async function recoveryActionGuard(
  tx: Transaction,
  run: AgentRun,
  input?: ToolInput,
): Promise<string | null> {
  try {
    const { row } = await runCase(tx, run);
    if (input?.targetId !== row.opportunityId) return 'recovery_target_mismatch';
    return await messageGuard(tx, row, input.channel ?? '', new Date());
  } catch (error) {
    if (error instanceof WorkforceError) return error.code;
    throw error;
  }
}
export async function executeRecoveryTool(
  tx: Transaction,
  organizationId: string,
  agentId: string,
  runId: string,
  actionId: string,
  tool: string,
  input: ToolInput,
) {
  const run = await tx.agentRun.findFirstOrThrow({ where: { organizationId, id: runId, agentId } }),
    { row, trigger } = await runCase(tx, run);
  if (input.targetId !== row.opportunityId)
    throw new WorkforceError(403, 'recovery_target_mismatch');
  if (tool === 'record_recovery_decision') {
    const prior = await tx.recoveryDecision.findUnique({
      where: { organizationId_runId: { organizationId, runId } },
    });
    if (prior) return { decisionId: prior.id, decision: prior.decision };
    const inbound = trigger.inbound === null ? null : string(trigger.inbound, 1000);
    const config = parseConfig(row.program.runtimeVersion.specialization);
    const currentKnowledge = [];
    for (const knowledge of config.knowledge) {
      if (knowledge.versionId) {
        try {
          await currentPublicClaim(tx, organizationId, knowledge.versionId, knowledge.text);
          currentKnowledge.push(knowledge);
        } catch (error) {
          if (!(error instanceof WorkforceError)) throw error;
        }
      } else if (process.env.BUSINESS_KNOWLEDGE_ENABLED !== 'true')
        currentKnowledge.push(knowledge);
    }
    const decision = normalizeDecision(
      { ...config, knowledge: currentKnowledge },
      JSON.parse(input.text!) as unknown,
      inbound,
      row.attempts,
      new Date(),
    );
    const saved = await tx.recoveryDecision.create({
      data: {
        organizationId,
        caseId: row.id,
        runId,
        caseRevision: row.revision,
        decision: json(decision),
      },
    });
    // Observations may pause automation or create a human review record, never dispatch.
    if (inbound) {
      const state =
        decision.intent === 'opt_out'
          ? 'opted_out'
          : decision.intent === 'not_interested'
            ? 'declined'
            : 'handoff';
      await tx.recoveryCase.update({
        where: { organizationId_id: { organizationId, id: row.id } },
        data: { state, reason: decision.intent, nextDueAt: null },
      });
      if (decision.intent === 'opt_out') {
        await tx.contact.update({
          where: { organizationId_id: { organizationId, id: row.contactId } },
          data: { doNotContact: true },
        });
        await tx.recoveryConsent.updateMany({
          where: { organizationId, contactId: row.contactId },
          data: { granted: false, evidence: 'Customer opt-out', recordedBy: 'recovery-safety' },
        });
      }
      await ensureHandoff(tx, row, decision.intent, decision.reason);
    } else if (decision.recommended_action === 'handoff') {
      const reason =
        parseConfig(row.program.runtimeVersion.specialization).mode === 'ADVISORY'
          ? 'advisory_recommendation'
          : 'knowledge_missing';
      await tx.recoveryCase.update({
        where: { organizationId_id: { organizationId, id: row.id } },
        data: { state: 'handoff', reason, nextDueAt: null },
      });
      await ensureHandoff(tx, row, reason, decision.reason);
    }
    await audit(tx, organizationId, `agent:${agentId}`, 'recovery.classified', saved.id, {
      caseId: row.id,
      intent: decision.intent,
      humanRequired: decision.human_required,
      knowledgeVersionIds: currentKnowledge.flatMap((k) => (k.versionId ? [k.versionId] : [])),
    });
    return {
      decisionId: saved.id,
      decision,
      knowledgeVersionIds: currentKnowledge.flatMap((k) => (k.versionId ? [k.versionId] : [])),
    };
  }
  const decision = await tx.recoveryDecision.findFirst({
    where: { organizationId, id: uuid(input.text), caseId: row.id, runId },
  });
  if (!decision || decision.caseRevision !== row.revision)
    throw new WorkforceError(409, 'recovery_decision_changed');
  const data = object(decision.decision);
  if (data.recommended_action !== 'send_message' || typeof data.message_if_allowed !== 'string')
    throw new WorkforceError(403, 'recovery_message_not_allowed');
  const blocked = await messageGuard(tx, row, input.channel ?? '', new Date());
  if (blocked) throw new WorkforceError(409, blocked);
  // Exact-action approval is mandatory even if callers attempt direct tool execution.
  const approval = await tx.humanApproval.findFirst({
    where: { organizationId, actionId, status: 'pending' },
  });
  // decideApproval commits approved status after execution in the same tenant transaction.
  if (!approval) throw new WorkforceError(403, 'recovery_approval_required');
  const dispatch = await tx.recoveryDispatch.create({
    data: {
      organizationId,
      caseId: row.id,
      actionId,
      requestKey: `agent:${actionId}`,
      body: data.message_if_allowed,
      channel: input.channel!,
      actor: `agent:${agentId}`,
      caseRevision: row.revision,
      runtimeVersionId: run.versionId,
    },
  });
  await audit(tx, organizationId, `agent:${agentId}`, 'recovery.dispatch_queued', dispatch.id, {
    caseId: row.id,
    deliveryStatus: 'not_sent',
  });
  if (process.env.COMMUNICATIONS_ENABLED === 'true')
    await recordRecoveryDispatch(tx, organizationId, dispatch.id);
  return { dispatchId: dispatch.id, status: 'queued', deliveryStatus: 'not_sent' };
}
