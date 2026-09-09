import { randomUUID } from 'node:crypto';
import type { AgentRun } from '@prisma/client';
import { audit } from '../workforce/audit/service.js';
import {
  hash,
  json,
  tenantTransaction,
  WorkforceError,
  type Database,
  type Transaction,
} from '../workforce/shared.js';
import { parseDecision, parseDefinition, type Definition, type Decision } from './contracts.js';
import { eligible, loadContext, type RunContext } from './context.js';
import { evaluate, operatingNow, type PolicyResult } from './policy.js';
import { executeTool, getTool, validateTool, type Tool } from './tools.js';
import { resolveProvider, type DecisionProvider } from './provider.js';
import { publishCompletion } from './facts.js';
import { recoveryActionGuard } from '../recovery/tools.js';
import { agentTrace } from '../platform/trace.js';
import { logger } from '../utils/logger.js';

export async function finishRun(
  tx: Transaction,
  run: AgentRun,
  status: 'completed' | 'failed' | 'stopped' | 'skipped',
  summary: string,
  errorCode?: string,
) {
  const organizationId = run.organizationId;
  logger.info(
    { ...agentTrace(run), status, errorCode },
    'Agent completion requested; transaction audit is authoritative',
  );
  await tx.agentRun.update({
    where: { organizationId_id: { organizationId, id: run.id } },
    data: {
      status,
      completedAt: new Date(),
      leaseToken: null,
      leasedUntil: null,
      errorCode: errorCode ?? null,
    },
  });
  const actions = await tx.agentAction.findMany({
    where: { organizationId, runId: run.id },
    select: { id: true, tool: true, status: true, result: true },
    take: 6,
  });
  const version = await tx.agentVersion.findFirstOrThrow({
    where: { organizationId, id: run.versionId },
  });
  const config = parseDefinition(version.definition);
  const requiredTool = {
    recommendation: null,
    task_created: 'create_task',
    note_added: 'add_note',
    opportunity_updated: 'update_opportunity',
  }[config.successCriteria.kind];
  const criterionMet = requiredTool
    ? actions.some((a) => a.tool === requiredTool && a.status === 'completed')
    : status === 'completed';
  const escalationCondition =
    errorCode === 'customer_suppressed'
      ? 'customer_suppressed'
      : status === 'failed'
        ? 'model_error'
        : errorCode
          ? 'policy_denied'
          : undefined;
  const evidence = json({
    actions,
    financialSuccessVerified: false,
    criterion: { kind: config.successCriteria.kind, met: criterionMet },
    escalationRequired:
      !!escalationCondition && config.escalationConditions.includes(escalationCondition),
  });
  await tx.agentResult.upsert({
    where: { organizationId_runId: { organizationId, runId: run.id } },
    create: {
      organizationId,
      runId: run.id,
      outcome: status,
      summary,
      evidence,
    },
    update: {
      outcome: status,
      summary,
      evidence,
    },
  });
  await audit(tx, organizationId, `agent:${run.agentId}`, 'agent.run_finished', run.id, {
    status,
    errorCode,
  });
}
export async function checkReferences(
  tx: Transaction,
  organizationId: string,
  input: Decision['input'],
  context: RunContext,
) {
  if (
    input.memberId &&
    !(await tx.organizationMember.findFirst({
      where: { organizationId, id: input.memberId, active: true },
    }))
  )
    throw new WorkforceError(403, 'tool_member_not_found');
  if (input.stageId) {
    const stage = await tx.pipelineStage.findFirst({
      where: { organizationId, id: input.stageId, record: { archivedAt: null } },
    });
    if (
      !stage ||
      stage.pipelineId !== context.records.find((r) => r.id === input.targetId)?.data.pipelineId
    )
      throw new WorkforceError(403, 'tool_stage_not_allowed');
  }
}
export async function actionPolicy(
  tx: Transaction,
  run: AgentRun,
  config: Definition,
  tool: Tool,
  context: RunContext,
  now: Date,
  approved = false,
  input?: Decision['input'],
): Promise<PolicyResult> {
  if (tool.name === 'send_recovery_message') {
    const reason = await recoveryActionGuard(tx, run, input);
    if (reason) return { outcome: 'deny', reason, version: 'agent-policy-v1' };
  }
  const agent = await tx.workforceAgent.findFirstOrThrow({
    where: { organizationId: run.organizationId, id: run.agentId },
  });
  const version = await tx.agentVersion.findFirstOrThrow({
    where: { organizationId: run.organizationId, id: run.versionId },
  });
  const attempts = await tx.agentAction.count({
    where: {
      organizationId: run.organizationId,
      agentId: run.agentId,
      run: { subjectId: run.subjectId },
      ...(approved ? { NOT: { runId: run.id, sequence: run.stepCount } } : {}),
    },
  });
  return evaluate(config, {
    tool: tool.name,
    effect: tool.effect,
    enabled: agent.enabled,
    currentVersion: agent.configVersion === version.number,
    context,
    automaticAvailable: tool.available,
    actions: run.actionCount - (approved ? 1 : 0),
    attempts,
    now,
    approved,
    channel: input?.channel,
  });
}
async function resume(tx: Transaction, run: AgentRun) {
  await tx.agentRun.update({
    where: { organizationId_id: { organizationId: run.organizationId, id: run.id } },
    data: { status: 'pending', leaseToken: null, leasedUntil: null, availableAt: new Date() },
  });
}
/** One bounded model step per leased job. No model/network I/O inside tenant transactions. */
export async function runOnce(
  database: Database,
  providerOverride?: DecisionProvider,
  organizationId?: string,
): Promise<boolean> {
  if (process.env.AGENT_RUNTIME_ENABLED !== 'true') return false;
  if (!providerOverride && process.env.AGENT_MODEL_ENABLED !== 'true') return false;
  const now = new Date(),
    token = randomUUID();
  const rows = await database.$queryRaw<AgentRun[]>`
    UPDATE "AgentRun" SET status='running', "leaseToken"=${token}::uuid,"leasedUntil"=${new Date(now.getTime() + 120000)},"startedAt"=COALESCE("startedAt",${now})
    WHERE id=(SELECT id FROM "AgentRun" WHERE ((status='pending' AND "availableAt"<=${now}) OR (status='running' AND "leasedUntil"<=${now}))
    AND (${organizationId ?? null}::uuid IS NULL OR "organizationId"=${organizationId ?? null}::uuid)
    ORDER BY "availableAt",id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`;
  const claimed = rows[0];
  if (!claimed) return false;
  logger.info(agentTrace(claimed), 'Agent run claimed');
  let observedDecision: Decision | undefined;
  try {
    const prepared = await tenantTransaction(database, claimed.organizationId, async (tx) => {
      const run = await tx.agentRun.findFirst({
        where: {
          organizationId: claimed.organizationId,
          id: claimed.id,
          status: 'running',
          leaseToken: token,
        },
      });
      if (!run) return null;
      const version = await tx.agentVersion.findFirstOrThrow({
        where: { organizationId: run.organizationId, id: run.versionId },
        include: { agent: true },
      });
      const config = parseDefinition(version.definition);
      await tx.agentStep.updateMany({
        where: { organizationId: run.organizationId, runId: run.id, status: 'planning' },
        data: { status: 'interrupted', errorCode: 'lease_expired', completedAt: now },
      });
      if (!version.agent.enabled || version.agent.configVersion !== version.number) {
        await finishRun(
          tx,
          run,
          'stopped',
          'Agent disabled or configuration superseded.',
          'agent_changed',
        );
        return null;
      }
      if (run.stepCount >= config.limits.maxSteps || run.deadlineAt <= now) {
        await finishRun(tx, run, 'stopped', 'Run budget exhausted.', 'run_limit');
        return null;
      }
      if (!operatingNow(config, now)) {
        await tx.agentRun.update({
          where: { organizationId_id: { organizationId: run.organizationId, id: run.id } },
          data: {
            status: 'pending',
            leaseToken: null,
            leasedUntil: null,
            availableAt: new Date(now.getTime() + 60000),
            deadlineAt: new Date(run.deadlineAt.getTime() + 60000),
          },
        });
        return null;
      }
      const context = await loadContext(tx, run.organizationId, run.subjectId, config);
      logger.info(
        { ...agentTrace(run, context), step: run.stepCount + 1 },
        'Agent context selected',
      );
      if (!eligible(config, context, now)) {
        await finishRun(tx, run, 'skipped', 'Current eligibility rules were not met.');
        return null;
      }
      const history = await tx.agentStep.findMany({
        where: { organizationId: run.organizationId, runId: run.id, status: 'completed' },
        select: { decision: true, policyResult: true, result: true },
        orderBy: { sequence: 'asc' },
        take: 12,
      });
      const updated = await tx.agentRun.update({
        where: { organizationId_id: { organizationId: run.organizationId, id: run.id } },
        data: { stepCount: { increment: 1 } },
      });
      await tx.agentStep.create({
        data: {
          organizationId: run.organizationId,
          runId: run.id,
          sequence: updated.stepCount,
          context: json(context),
          provider: config.model.provider,
          model: config.model.model,
        },
      });
      return { run: updated, config, context, history };
    });
    if (!prepared) return true;
    const provider = providerOverride ?? resolveProvider(prepared.config.model.provider);
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let raw: unknown;
    try {
      raw = await Promise.race([
        provider.decide(
          {
            definition: prepared.config,
            context: prepared.context,
            history: prepared.history,
            trigger: prepared.run.trigger,
          },
          controller.signal,
        ),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new WorkforceError(504, 'agent_model_timeout'));
          }, 30000);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      controller.abort();
    }
    const decision = parseDecision(raw);
    observedDecision = decision;
    await tenantTransaction(database, claimed.organizationId, async (tx) => {
      const run = await tx.agentRun.findFirst({
        where: {
          organizationId: claimed.organizationId,
          id: claimed.id,
          status: 'running',
          leaseToken: token,
          leasedUntil: { gt: new Date() },
        },
      });
      if (!run) return;
      if (run.deadlineAt <= new Date()) {
        await finishRun(tx, run, 'stopped', 'Run deadline expired.', 'run_limit');
        return;
      }
      const stepWhere = {
        organizationId_runId_sequence: {
          organizationId: run.organizationId,
          runId: run.id,
          sequence: run.stepCount,
        },
      };
      await tx.agentStep.update({ where: stepWhere, data: { decision: json(decision) } });
      const context = await loadContext(tx, run.organizationId, run.subjectId, prepared.config);
      if (context.fingerprint !== prepared.context.fingerprint)
        throw new WorkforceError(409, 'agent_context_changed');
      if (decision.kind === 'finish') {
        await tx.agentStep.update({
          where: stepWhere,
          data: { status: 'completed', completedAt: new Date() },
        });
        await finishRun(tx, run, 'completed', decision.summary);
        return;
      }
      const tool = getTool(decision.tool!);
      validateTool(tool, decision.input, context, prepared.config, new Date());
      await checkReferences(tx, run.organizationId, decision.input, context);
      const policy = await actionPolicy(
        tx,
        run,
        prepared.config,
        tool,
        context,
        new Date(),
        false,
        decision.input,
      );
      await tx.agentStep.update({
        where: stepWhere,
        data: { policyResult: json(policy), status: 'completed', completedAt: new Date() },
      });
      if (
        tool.effect === 'read' ||
        tool.effect === 'observation' ||
        tool.name === 'stop_agent_run'
      ) {
        if (policy.outcome !== 'allow') {
          await finishRun(tx, run, 'stopped', policy.reason, policy.reason);
          return;
        }
        const result = await executeTool(
          tx,
          database,
          run.organizationId,
          run.agentId,
          run.id,
          randomUUID(),
          tool,
          decision.input,
          context,
        );
        await tx.agentStep.update({ where: stepWhere, data: { result: json(result) } });
        await audit(tx, run.organizationId, `agent:${run.agentId}`, 'agent.tool_executed', run.id, {
          tool: tool.name,
          sequence: run.stepCount,
        });
        if (tool.name === 'stop_agent_run') await finishRun(tx, run, 'stopped', decision.summary);
        else await resume(tx, run);
        return;
      }
      const deduplicationKey = hash({
        subjectId: run.subjectId,
        tool: tool.name,
        input: decision.input,
      });
      const prior = await tx.agentAction.findUnique({
        where: {
          organizationId_agentId_deduplicationKey: {
            organizationId: run.organizationId,
            agentId: run.agentId,
            deduplicationKey,
          },
        },
      });
      if (prior) {
        await tx.agentStep.update({
          where: stepWhere,
          data: { result: { duplicateActionId: prior.id } },
        });
        await finishRun(tx, run, 'stopped', 'Duplicate action suppressed.', 'duplicate_action');
        return;
      }
      // Denied proposals are recorded but cannot exceed the hard action budget.
      if (run.actionCount >= prepared.config.limits.maxActions) {
        await finishRun(tx, run, 'stopped', 'Action budget exhausted.', 'action_limit');
        return;
      }
      const action = await tx.agentAction.create({
        data: {
          organizationId: run.organizationId,
          agentId: run.agentId,
          runId: run.id,
          sequence: run.stepCount,
          tool: tool.name,
          input: json(decision.input),
          deduplicationKey,
          subjectVersion: context.records[0]!.version,
          contextFingerprint: context.fingerprint,
          policyResult: json(policy),
          status:
            policy.outcome === 'deny'
              ? 'blocked'
              : policy.outcome === 'recommend'
                ? 'recommended'
                : policy.outcome === 'require_approval'
                  ? 'pending_approval'
                  : 'completed',
        },
      });
      await tx.agentRun.update({
        where: { organizationId_id: { organizationId: run.organizationId, id: run.id } },
        data: { actionCount: { increment: 1 } },
      });
      await audit(
        tx,
        run.organizationId,
        `agent:${run.agentId}`,
        'agent.action_proposed',
        action.id,
        { tool: tool.name, policy },
      );
      if (policy.outcome === 'deny' || policy.outcome === 'recommend') {
        await finishRun(
          tx,
          run,
          policy.outcome === 'deny' ? 'stopped' : 'completed',
          decision.summary,
          policy.outcome === 'deny' ? policy.reason : undefined,
        );
        return;
      }
      if (policy.outcome === 'require_approval') {
        await tx.humanApproval.create({
          data: {
            organizationId: run.organizationId,
            actionId: action.id,
            expiresAt: new Date(Date.now() + 86400000),
          },
        });
        await tx.agentRun.update({
          where: { organizationId_id: { organizationId: run.organizationId, id: run.id } },
          data: { status: 'waiting_approval', leaseToken: null, leasedUntil: null },
        });
        return;
      }
      const result = await executeTool(
        tx,
        database,
        run.organizationId,
        run.agentId,
        run.id,
        action.id,
        tool,
        decision.input,
        context,
      );
      await tx.agentAction.update({
        where: { organizationId_id: { organizationId: run.organizationId, id: action.id } },
        data: { result: json(result), completedAt: new Date() },
      });
      await tx.agentStep.update({ where: stepWhere, data: { result: json(result) } });
      await publishCompletion(tx, run, action.id, tool.name);
      await audit(
        tx,
        run.organizationId,
        `agent:${run.agentId}`,
        'agent.action_completed',
        action.id,
        { tool: tool.name },
      );
      await resume(tx, run);
    });
  } catch (error) {
    const code = error instanceof WorkforceError ? error.code : 'agent_execution_failed';
    await tenantTransaction(database, claimed.organizationId, async (tx) => {
      const run = await tx.agentRun.findFirst({
        where: {
          organizationId: claimed.organizationId,
          id: claimed.id,
          status: 'running',
          leaseToken: token,
        },
      });
      if (!run) return;
      await tx.agentStep.updateMany({
        where: { organizationId: run.organizationId, runId: run.id, sequence: run.stepCount },
        data: {
          status: 'failed',
          errorCode: code,
          completedAt: new Date(),
          ...(observedDecision
            ? {
                decision: json(observedDecision),
                policyResult: json({ outcome: 'deny', reason: code, version: 'agent-policy-v1' }),
              }
            : {}),
        },
      });
      await finishRun(tx, run, 'failed', 'Execution stopped safely; inspect the error code.', code);
    });
  }
  return true;
}
