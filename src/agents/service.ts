import { randomUUID } from 'node:crypto';
import { audit } from '../workforce/audit/service.js';
import { authorize, type Principal, type Scope } from '../workforce/tenancy/service.js';
import {
  hash,
  json,
  object,
  keys,
  string,
  uuid,
  boolean,
  integer,
  tenantTransaction,
  WorkforceError,
  type Database,
  type Transaction,
} from '../workforce/shared.js';
import { parseDefinition, type Definition } from './contracts.js';
import { loadContext, eligible } from './context.js';
import { timestamp } from '../crm/validation.js';
import { resolveProvider } from './provider.js';
import { finishRun } from './runtime.js';

export async function authorizeCurrent(tx: Transaction, principal: Principal, scope: Scope) {
  authorize(principal, scope);
  const credential = await tx.workforceCredential.findFirst({
    where: { organizationId: principal.organizationId, id: principal.credentialId },
    include: { membership: true },
  });
  if (
    !credential ||
    credential.revokedAt ||
    credential.expiresAt <= new Date() ||
    !credential.membership?.active ||
    credential.membership.role !== principal.role ||
    !credential.scopes.includes(scope)
  )
    throw new WorkforceError(401, 'credential_changed');
}
async function saveVersion(
  tx: Transaction,
  organizationId: string,
  agentId: string,
  number: number,
  definition: Definition,
  actor: string,
) {
  const version = await tx.agentVersion.create({
    data: {
      organizationId,
      agentId,
      number,
      definition: json(definition),
      definitionHash: hash(definition),
      createdBy: actor,
    },
  });
  const base = { organizationId, versionId: version.id };
  await tx.agentGoal.create({
    data: {
      ...base,
      objective: definition.objective,
      successCriteria: json(definition.successCriteria),
    },
  });
  await tx.agentPolicy.create({
    data: {
      ...base,
      rules: json({
        mode: definition.mode,
        eligibility: definition.eligibility,
        restrictedActions: definition.restrictedActions,
        humanApprovalMode: definition.humanApprovalMode,
        limits: definition.limits,
      }),
    },
  });
  await tx.agentTrigger.createMany({
    data: definition.triggers.map((eventType) => ({ ...base, eventType })),
  });
  await tx.agentToolPermission.createMany({
    data: definition.permissions.map((p) => ({ ...base, ...p })),
  });
  await tx.agentEscalationRule.createMany({
    data: definition.escalationConditions.map((condition) => ({
      ...base,
      condition,
      outcome: 'stop_and_record',
    })),
  });
  await audit(tx, organizationId, actor, 'agent.version_created', version.id, {
    agentId,
    number,
    definitionHash: version.definitionHash,
  });
  return version;
}
/** Trusted DB-only entry points shared by the runtime API and reviewed blueprint activation.
 * Caller must authorize agents:write and hold the organization lock. */
export async function createAgentInTransaction(
  tx: Transaction,
  organizationId: string,
  definition: Definition,
  actor: string,
) {
  parseDefinition(definition);
  resolveProvider(definition.model.provider);
  if ((await tx.workforceAgent.count({ where: { organizationId, kind: 'universal' } })) >= 50)
    throw new WorkforceError(409, 'agent_limit');
  const agent = await tx.workforceAgent.create({
    data: {
      organizationId,
      name: definition.name,
      description: definition.description,
      kind: 'universal',
      config: json({ runtime: 'universal-v1' }),
      enabled: false,
    },
  });
  const version = await saveVersion(tx, organizationId, agent.id, 1, definition, actor);
  return { agent, version };
}
export async function appendAgentVersionInTransaction(
  tx: Transaction,
  organizationId: string,
  id: string,
  definition: Definition,
  actor: string,
) {
  parseDefinition(definition);
  resolveProvider(definition.model.provider);
  const agent = await tx.workforceAgent.findFirst({
    where: { organizationId, id, kind: 'universal' },
  });
  if (!agent) throw new WorkforceError(404, 'agent_not_found');
  if (agent.configVersion >= 100) throw new WorkforceError(409, 'version_limit');
  const version = await saveVersion(
    tx,
    organizationId,
    id,
    agent.configVersion + 1,
    definition,
    actor,
  );
  await tx.workforceAgent.update({
    where: { organizationId_id: { organizationId, id } },
    data: {
      name: definition.name,
      description: definition.description,
      configVersion: version.number,
      enabled: false,
    },
  });
  return version;
}
/** Logical Agent reuses WorkforceAgent identity. Legacy recovery rows are never rewritten. */
export class AgentService {
  constructor(
    private readonly database: Database,
    private readonly principal: Principal,
  ) {}
  private tx<T>(fn: (tx: Transaction, organizationId: string) => Promise<T>) {
    return tenantTransaction(this.database, this.principal.organizationId, async (tx) => {
      await authorizeCurrent(tx, this.principal, 'agents:write');
      return fn(tx, this.principal.organizationId);
    });
  }
  create(raw: unknown) {
    const definition = parseDefinition(raw);
    resolveProvider(definition.model.provider);
    return this.tx((tx, organizationId) =>
      createAgentInTransaction(tx, organizationId, definition, this.principal.actor),
    );
  }
  version(id: string, raw: unknown) {
    uuid(id);
    const definition = parseDefinition(raw);
    resolveProvider(definition.model.provider);
    return this.tx((tx, organizationId) =>
      appendAgentVersionInTransaction(tx, organizationId, id, definition, this.principal.actor),
    );
  }
  enable(id: string, value: unknown) {
    uuid(id);
    const enabled = boolean(value);
    return this.tx(async (tx, organizationId) => {
      const count = await tx.workforceAgent.updateMany({
        where: { organizationId, id, kind: 'universal' },
        data: { enabled },
      });
      if (!count.count) throw new WorkforceError(404, 'agent_not_found');
      await audit(
        tx,
        organizationId,
        this.principal.actor,
        enabled ? 'agent.enabled' : 'agent.disabled',
        id,
      );
      return { id, enabled };
    });
  }
  list() {
    return this.tx((tx, organizationId) =>
      tx.workforceAgent.findMany({
        where: { organizationId, kind: 'universal' },
        include: { versions: { orderBy: { number: 'desc' }, take: 1 } },
        take: 50,
        orderBy: { createdAt: 'desc' },
      }),
    );
  }
  runs() {
    return this.tx((tx, organizationId) =>
      tx.agentRun.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: { result: true },
      }),
    );
  }
  stop(id: string) {
    uuid(id);
    return this.tx(async (tx, organizationId) => {
      const run = await tx.agentRun.findFirst({ where: { organizationId, id } });
      if (!run) throw new WorkforceError(404, 'agent_run_not_found');
      if (!['pending', 'running', 'waiting_approval'].includes(run.status))
        return { id, status: run.status };
      await tx.humanApproval.updateMany({
        where: { organizationId, status: 'pending', action: { runId: id } },
        data: {
          status: 'rejected',
          reason: 'run_stopped_by_admin',
          decidedBy: this.principal.actor,
          decidedAt: new Date(),
        },
      });
      await tx.agentAction.updateMany({
        where: { organizationId, runId: id, status: 'pending_approval' },
        data: { status: 'blocked', errorCode: 'run_stopped_by_admin', completedAt: new Date() },
      });
      await tx.agentStep.updateMany({
        where: { organizationId, runId: id, status: 'planning' },
        data: { status: 'interrupted', errorCode: 'run_stopped_by_admin', completedAt: new Date() },
      });
      await finishRun(
        tx,
        run,
        'stopped',
        'Organization administrator stopped the run.',
        'run_stopped_by_admin',
      );
      await audit(tx, organizationId, this.principal.actor, 'agent.run_stopped', id);
      return { id, status: 'stopped' };
    });
  }
  detail(id: string) {
    uuid(id);
    return this.tx(async (tx, organizationId) => {
      const run = await tx.agentRun.findFirst({
        where: { organizationId, id },
        include: {
          version: true,
          steps: { orderBy: { sequence: 'asc' } },
          actions: { include: { approval: true }, orderBy: { sequence: 'asc' } },
          result: true,
        },
      });
      if (!run) throw new WorkforceError(404, 'agent_run_not_found');
      return run;
    });
  }
  start(agentId: string, raw: unknown) {
    uuid(agentId);
    const v = object(raw);
    keys(v, ['subjectId', 'idempotencyKey']);
    const subjectId = uuid(v.subjectId);
    const key = string(v.idempotencyKey, 100);
    return this.tx((tx, organizationId) =>
      enqueueRun(
        tx,
        organizationId,
        agentId,
        subjectId,
        `manual:${key}`,
        { system: 'manual', actor: this.principal.actor },
        new Date(),
      ),
    );
  }
  schedule(agentId: string, raw: unknown) {
    uuid(agentId);
    const v = object(raw);
    keys(v, ['subjectId', 'nextRunAt', 'intervalMinutes', 'remainingRuns']);
    const subjectId = uuid(v.subjectId);
    const nextRunAt = timestamp(v.nextRunAt);
    const intervalMinutes =
      v.intervalMinutes === null ? null : integer(v.intervalMinutes, 15, 525600);
    const remainingRuns = integer(v.remainingRuns, 1, 20);
    if (
      nextRunAt <= new Date() ||
      nextRunAt.getTime() > Date.now() + 366 * 86400000 ||
      (!intervalMinutes && remainingRuns !== 1)
    )
      throw new WorkforceError(400, 'invalid_schedule');
    return this.tx(async (tx, organizationId) => {
      const version = await currentVersion(tx, organizationId, agentId);
      const config = parseDefinition(version.definition);
      await loadContext(tx, organizationId, subjectId, config);
      if ((await tx.agentSchedule.count({ where: { organizationId, enabled: true } })) >= 100)
        throw new WorkforceError(409, 'schedule_limit');
      const schedule = await tx.agentSchedule.create({
        data: { organizationId, agentId, subjectId, nextRunAt, intervalMinutes, remainingRuns },
      });
      await audit(tx, organizationId, this.principal.actor, 'agent.schedule_created', schedule.id);
      return schedule;
    });
  }
  schedules() {
    return this.tx((tx, organizationId) =>
      tx.agentSchedule.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    );
  }
  cancelSchedule(id: string) {
    uuid(id);
    return this.tx(async (tx, organizationId) => {
      const result = await tx.agentSchedule.updateMany({
        where: { organizationId, id },
        data: { enabled: false },
      });
      if (!result.count) throw new WorkforceError(404, 'schedule_not_found');
      await audit(tx, organizationId, this.principal.actor, 'agent.schedule_cancelled', id);
      return { id, enabled: false };
    });
  }
}
export async function currentVersion(tx: Transaction, organizationId: string, agentId: string) {
  const agent = await tx.workforceAgent.findFirst({
    where: { organizationId, id: agentId, kind: 'universal' },
  });
  if (!agent) throw new WorkforceError(404, 'agent_not_found');
  return tx.agentVersion.findUniqueOrThrow({
    where: {
      organizationId_agentId_number: { organizationId, agentId, number: agent.configVersion },
    },
    include: { agent: true },
  });
}
export async function enqueueRun(
  tx: Transaction,
  organizationId: string,
  agentId: string,
  subjectId: string,
  triggerKey: string,
  trigger: unknown,
  now: Date,
  eventId?: string,
  correlationId: string = randomUUID(),
) {
  const prior = await tx.agentRun.findUnique({
    where: { organizationId_agentId_triggerKey: { organizationId, agentId, triggerKey } },
  });
  if (prior) {
    if (prior.subjectId !== subjectId) throw new WorkforceError(409, 'run_idempotency_conflict');
    return prior;
  }
  const version = await currentVersion(tx, organizationId, agentId);
  const config = parseDefinition(version.definition);
  if (!version.agent.enabled) throw new WorkforceError(409, 'agent_disabled');
  const context = await loadContext(tx, organizationId, subjectId, config);
  const daily = await tx.agentRun.count({
    where: { organizationId, agentId, createdAt: { gte: new Date(now.getTime() - 86400000) } },
  });
  if (daily >= config.limits.maxRunsPerDay) throw new WorkforceError(429, 'agent_daily_run_limit');
  // Tenant-wide ceiling also bounds event feedback across multiple agents.
  if (
    (await tx.agentRun.count({
      where: { organizationId, createdAt: { gte: new Date(now.getTime() - 86400000) } },
    })) >= 500
  )
    throw new WorkforceError(429, 'organization_agent_run_limit');
  const allowed = eligible(config, context, now);
  const run = await tx.agentRun.create({
    data: {
      organizationId,
      agentId,
      versionId: version.id,
      subjectId,
      eventId,
      triggerKey,
      trigger: json(trigger),
      correlationId,
      status: allowed ? 'pending' : 'skipped',
      deadlineAt: new Date(now.getTime() + config.limits.maxRunSeconds * 1000),
      ...(allowed ? {} : { completedAt: now }),
    },
  });
  if (!allowed)
    await tx.agentResult.create({
      data: {
        organizationId,
        runId: run.id,
        outcome: 'ineligible',
        summary: 'Server-side eligibility rules were not met.',
        evidence: {},
      },
    });
  await audit(tx, organizationId, `agent:${agentId}`, 'agent.run_created', run.id, {
    status: run.status,
    versionId: version.id,
  });
  return run;
}
