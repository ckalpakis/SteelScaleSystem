import type { AgentBlueprintVersion } from '@prisma/client';
import {
  authorizeCurrent,
  appendAgentVersionInTransaction,
  createAgentInTransaction,
} from '../agents/service.js';
import type { Principal } from '../workforce/tenancy/service.js';
import { audit } from '../workforce/audit/service.js';
import {
  hash,
  integer,
  json,
  keys,
  object,
  string,
  tenantTransaction,
  uuid,
  WorkforceError,
  type Database,
  type Transaction,
} from '../workforce/shared.js';
import { parseBlueprint, type AgentBlueprint } from './blueprint.js';
import { compile, compilerVersion, preview, scenario } from './compiler.js';
import { OpenAIBlueprintExtractor, type BlueprintExtractor } from './extractor.js';

export function changedFields(before: unknown, after: unknown) {
  const a = object(before),
    b = object(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (k) => hash(a[k] ?? null) !== hash(b[k] ?? null),
  );
}
export class BlueprintService {
  constructor(
    private readonly database: Database,
    private readonly principal: Principal,
    private readonly extractor: BlueprintExtractor = new OpenAIBlueprintExtractor(),
  ) {}
  private tx<T>(fn: (tx: Transaction, organizationId: string) => Promise<T>) {
    return tenantTransaction(this.database, this.principal.organizationId, async (tx) => {
      await authorizeCurrent(tx, this.principal, 'agents:write');
      return fn(tx, this.principal.organizationId);
    });
  }
  list() {
    return this.tx((tx, organizationId) =>
      tx.agentBlueprint.findMany({
        where: { organizationId },
        include: { agent: { select: { enabled: true, configVersion: true } } },
        orderBy: { updatedAt: 'desc' },
        take: 50,
      }),
    );
  }
  private async version(tx: Transaction, organizationId: string, id: string, number?: number) {
    const blueprint = await tx.agentBlueprint.findFirst({
      where: { organizationId, id },
      include: { agent: { select: { id: true, enabled: true, configVersion: true } } },
    });
    if (!blueprint) throw new WorkforceError(404, 'blueprint_not_found');
    const version = await tx.agentBlueprintVersion.findUnique({
      where: {
        organizationId_blueprintId_number: {
          organizationId,
          blueprintId: id,
          number: number ?? blueprint.currentVersion,
        },
      },
    });
    if (!version) throw new WorkforceError(404, 'blueprint_version_not_found');
    return { blueprint, version };
  }
  detail(id: string, number?: number) {
    uuid(id);
    if (number !== undefined) integer(number, 1, 100);
    return this.tx(async (tx, organizationId) => {
      const state = await this.version(tx, organizationId, id, number),
        specification = parseBlueprint(state.version.specification);
      const history = await tx.agentBlueprintVersion.findMany({
        where: { organizationId, blueprintId: id },
        orderBy: { number: 'desc' },
        take: 100,
      });
      const tests = await tx.agentBlueprintTest.findMany({
        where: { organizationId, versionId: state.version.id },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });
      return {
        ...state,
        specification,
        compilation: compile(specification),
        tests,
        history: history.map((v, i) => ({
          id: v.id,
          number: v.number,
          origin: v.origin,
          createdAt: v.createdAt,
          createdBy: v.createdBy,
          activatedAt: v.activatedAt,
          changedFields: history[i + 1]
            ? changedFields(history[i + 1]!.specification, v.specification)
            : ['Initial configuration'],
        })),
      };
    });
  }
  private async persist(
    tx: Transaction,
    organizationId: string,
    b: AgentBlueprint,
    source: {
      origin: 'manual' | 'ai';
      sourceText?: string | null;
      provider?: string;
      model?: string;
    },
    id?: string,
    expectedVersion?: number,
  ) {
    let previous: AgentBlueprintVersion | undefined;
    let blueprintId = id;
    if (id) {
      const state = await this.version(tx, organizationId, id);
      previous = state.version;
      if (state.blueprint.currentVersion !== expectedVersion)
        throw new WorkforceError(409, 'blueprint_version_conflict');
      if (state.blueprint.currentVersion >= 100)
        throw new WorkforceError(409, 'blueprint_version_limit');
    } else {
      if ((await tx.agentBlueprint.count({ where: { organizationId } })) >= 50)
        throw new WorkforceError(409, 'blueprint_limit');
      blueprintId = (
        await tx.agentBlueprint.create({
          data: { organizationId, name: b.name ?? 'Untitled agent' },
        })
      ).id;
    }
    const version = await tx.agentBlueprintVersion.create({
      data: {
        organizationId,
        blueprintId: blueprintId!,
        number: previous ? previous.number + 1 : 1,
        specification: json(b),
        specificationHash: hash(b),
        origin: source.origin,
        sourceText: source.sourceText ?? previous?.sourceText,
        provider: source.provider,
        model: source.model,
        createdBy: this.principal.actor,
      },
    });
    await tx.agentBlueprint.update({
      where: { organizationId_id: { organizationId, id: blueprintId! } },
      data: { name: b.name ?? 'Untitled agent', currentVersion: version.number },
    });
    await audit(tx, organizationId, this.principal.actor, 'blueprint.version_saved', version.id, {
      blueprintId,
      number: version.number,
      origin: source.origin,
      hash: version.specificationHash,
      changedFields: previous ? changedFields(previous.specification, b) : ['initial'],
    });
    return version;
  }
  save(raw: unknown, id?: string) {
    if (id) uuid(id);
    const v = object(raw);
    keys(v, ['specification', 'expectedVersion']);
    const b = parseBlueprint(v.specification);
    const expectedVersion = id ? integer(v.expectedVersion, 1, 100) : undefined;
    return this.tx((tx, organizationId) =>
      this.persist(tx, organizationId, b, { origin: 'manual' }, id, expectedVersion),
    );
  }
  async generate(raw: unknown) {
    const v = object(raw);
    keys(v, ['description', 'requestKey', 'blueprintId', 'expectedVersion']);
    const description = string(v.description, 6000),
      requestKey = string(v.requestKey, 100),
      id = v.blueprintId ? uuid(v.blueprintId) : undefined,
      expectedVersion = id ? integer(v.expectedVersion, 1, 100) : undefined;
    const requestHash = hash({ description, id, expectedVersion });
    const reservation = await this.tx(async (tx, organizationId) => {
      const existing = await tx.agentBlueprintGeneration.findUnique({
        where: { organizationId_requestKey: { organizationId, requestKey } },
      });
      if (existing) {
        if (existing.requestHash !== requestHash)
          throw new WorkforceError(409, 'generation_idempotency_conflict');
        if (existing.status === 'completed')
          return {
            version: await tx.agentBlueprintVersion.findFirstOrThrow({
              where: { organizationId, id: existing.versionId! },
            }),
          };
        if (existing.status === 'running' && existing.createdAt.getTime() < Date.now() - 60000)
          await tx.agentBlueprintGeneration.update({
            where: { id: existing.id },
            data: { status: 'failed', errorCode: 'generation_abandoned', completedAt: new Date() },
          });
        return {
          error:
            existing.status === 'failed' || existing.createdAt.getTime() < Date.now() - 60000
              ? 'generation_failed_start_new_request'
              : 'generation_in_progress',
        };
      }
      if (
        id &&
        (await this.version(tx, organizationId, id)).blueprint.currentVersion !== expectedVersion
      )
        throw new WorkforceError(409, 'blueprint_version_conflict');
      if (
        (await tx.agentBlueprintGeneration.count({
          where: { organizationId, createdAt: { gte: new Date(Date.now() - 86400000) } },
        })) >= 20
      )
        throw new WorkforceError(429, 'blueprint_generation_daily_limit');
      const job = await tx.agentBlueprintGeneration.create({
        data: { organizationId, requestKey, requestHash },
      });
      await audit(
        tx,
        organizationId,
        this.principal.actor,
        'blueprint.generation_requested',
        job.id,
        { requestHash },
      );
      return { job };
    });
    if (reservation.error) throw new WorkforceError(409, reservation.error);
    if (reservation.version) return reservation.version;
    const job = reservation.job;
    if (!job) throw new WorkforceError(500, 'generation_reservation_failed');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.extractor.extract(description, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new WorkforceError(504, 'blueprint_generation_timeout'));
          }, 30000);
        }),
      ]);
      const proposed = parseBlueprint(result);
      // Model output cannot approve sources, choose a paid runtime model, or grant automatic actions.
      proposed.knowledgeRequirements = proposed.knowledgeRequirements.map((k) => ({
        ...k,
        approved: false,
      }));
      proposed.automaticActions = [];
      proposed.runtimeModel = null;
      return await this.tx(async (tx, organizationId) => {
        const version = await this.persist(
          tx,
          organizationId,
          proposed,
          {
            origin: 'ai',
            sourceText: description,
            provider: this.extractor.provider,
            model: this.extractor.model,
          },
          id,
          expectedVersion,
        );
        await tx.agentBlueprintGeneration.update({
          where: { id: job.id },
          data: { status: 'completed', versionId: version.id, completedAt: new Date() },
        });
        return version;
      });
    } catch (error) {
      const code = error instanceof WorkforceError ? error.code : 'blueprint_generation_failed';
      // A revoked caller cannot save a result, but its already-owned generation receipt must
      // still reach a terminal state. No raw model/provider error is persisted.
      await tenantTransaction(this.database, this.principal.organizationId, async (tx) => {
        await tx.agentBlueprintGeneration.updateMany({
          where: {
            organizationId: this.principal.organizationId,
            id: job.id,
            status: 'running',
          },
          data: { status: 'failed', errorCode: code, completedAt: new Date() },
        });
        await audit(
          tx,
          this.principal.organizationId,
          this.principal.actor,
          'blueprint.generation_failed',
          job.id,
          { code },
        );
      });
      throw new WorkforceError(error instanceof WorkforceError ? error.status : 502, code);
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }
  test(id: string, raw: unknown) {
    uuid(id);
    const v = object(raw);
    keys(v, ['expectedVersion', 'scenario']);
    const expected = integer(v.expectedVersion, 1, 100),
      input = scenario(v.scenario);
    return this.tx(async (tx, organizationId) => {
      const { blueprint, version } = await this.version(tx, organizationId, id);
      if (blueprint.currentVersion !== expected)
        throw new WorkforceError(409, 'blueprint_version_conflict');
      if (
        (await tx.agentBlueprintTest.count({ where: { organizationId, versionId: version.id } })) >=
        100
      )
        throw new WorkforceError(409, 'blueprint_test_limit');
      const report = preview(parseBlueprint(version.specification), input);
      const result = await tx.agentBlueprintTest.create({
        data: {
          organizationId,
          versionId: version.id,
          specificationHash: version.specificationHash,
          compilerVersion,
          scenario: json(input),
          report: json(report),
          createdBy: this.principal.actor,
        },
      });
      await audit(tx, organizationId, this.principal.actor, 'blueprint.tested', version.id, {
        executable: report.executable,
        sideEffects: false,
      });
      return result;
    });
  }
  activate(id: string, raw: unknown) {
    uuid(id);
    const v = object(raw);
    keys(v, ['expectedVersion', 'specificationHash', 'expectedAgentVersion', 'reviewed']);
    const number = integer(v.expectedVersion, 1, 100),
      expectedAgentVersion = integer(v.expectedAgentVersion, 0, 100),
      fingerprint = string(v.specificationHash, 64);
    if (v.reviewed !== true) throw new WorkforceError(400, 'blueprint_review_required');
    return this.tx(async (tx, organizationId) => {
      const { blueprint, version } = await this.version(tx, organizationId, id);
      if (blueprint.currentVersion !== number || version.specificationHash !== fingerprint)
        throw new WorkforceError(409, 'blueprint_version_conflict');
      if (version.activatedAt)
        return {
          agentId: blueprint.agentId,
          runtimeVersionId: version.runtimeVersionId,
          duplicate: true,
        };
      if ((blueprint.agent?.configVersion ?? 0) !== expectedAgentVersion)
        throw new WorkforceError(409, 'runtime_version_conflict');
      const compiled = compile(version.specification);
      if (!compiled.definition) throw new WorkforceError(409, 'blueprint_requirements_unresolved');
      const tests = await tx.agentBlueprintTest.findMany({
        where: {
          organizationId,
          versionId: version.id,
          compilerVersion,
          specificationHash: fingerprint,
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      if (
        !tests.some((t) => {
          const r = object(t.report);
          return r.executable === true && r.definitionHash === compiled.definitionHash;
        })
      )
        throw new WorkforceError(409, 'blueprint_test_required');
      let agentId = blueprint.agentId;
      let runtimeVersion;
      if (agentId)
        runtimeVersion = await appendAgentVersionInTransaction(
          tx,
          organizationId,
          agentId,
          compiled.definition,
          this.principal.actor,
        );
      else {
        const created = await createAgentInTransaction(
          tx,
          organizationId,
          compiled.definition,
          this.principal.actor,
        );
        agentId = created.agent.id;
        runtimeVersion = created.version;
      }
      await tx.agentBlueprint.update({
        where: { organizationId_id: { organizationId, id } },
        data: { agentId },
      });
      await tx.agentBlueprintVersion.update({
        where: { organizationId_id: { organizationId, id: version.id } },
        data: {
          activatedAt: new Date(),
          activatedBy: this.principal.actor,
          runtimeVersionId: runtimeVersion.id,
        },
      });
      await tx.workforceAgent.update({
        where: { organizationId_id: { organizationId, id: agentId } },
        data: { enabled: true },
      });
      await audit(tx, organizationId, this.principal.actor, 'blueprint.activated', version.id, {
        agentId,
        runtimeVersionId: runtimeVersion.id,
        blueprintHash: fingerprint,
        definitionHash: compiled.definitionHash,
        compilerVersion,
      });
      return { agentId, runtimeVersionId: runtimeVersion.id, duplicate: false };
    });
  }
}
