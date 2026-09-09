import {
  appendAgentVersionInTransaction,
  authorizeCurrent,
  createAgentInTransaction,
} from '../agents/service.js';
import { parseDefinition } from '../agents/contracts.js';
import { audit } from '../workforce/audit/service.js';
import type { Principal } from '../workforce/tenancy/service.js';
import {
  boolean,
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
import { parseConfig, validateActivation, type RecoveryConfig } from './contracts.js';
import { enroll } from './orchestrator.js';
import { loadCase } from './lifecycle.js';
import { currentPublicClaim } from '../knowledge/retrieval.js';
import { recoveryStatus } from '../communications/ledger.js';

export function runtimeDefinition(config: RecoveryConfig) {
  return parseDefinition({
    version: 1,
    name: config.name,
    description:
      'Domain-agnostic revenue recovery with reviewed communication and evidence-based attribution.',
    objective:
      'Monitor unsold opportunities, propose approved follow-ups, and hand customer responses to a person.',
    businessContext:
      'Use only approved recovery knowledge. Never invent business facts or claim delivery or revenue without receipts.',
    communicationStyle: 'Use exact organization-approved text.',
    mode: config.mode,
    model: { provider: 'revenue_recovery', model: config.model },
    triggers: [],
    eligibility: {
      entityTypes: ['opportunity'],
      statuses: ['open', 'estimate_sent'],
      staleAfterDays: 0,
    },
    permissions: [
      { tool: 'record_recovery_decision', automatic: true },
      { tool: 'send_recovery_message', automatic: false },
    ],
    restrictedActions: ['send_message', 'book_appointment', 'update_opportunity'],
    escalationConditions: ['policy_denied', 'customer_suppressed', 'model_error'],
    successCriteria: {
      kind: 'recommendation',
      description:
        'A structured decision is recorded; financial results require separate evidence.',
    },
    followupStrategy: { enabled: false, delayMinutes: 15 },
    maximumAttempts: 20,
    operatingHours: config.workingHours,
    enabledChannels: config.channels,
    humanApprovalMode: 'all_mutations',
    context: { includeContactDetails: false, includeMessageContent: false },
    limits: {
      maxSteps: 3,
      maxActions: 1,
      maxRunSeconds: 300,
      maxRunsPerDay: 100,
      maxOutputTokens: 1024,
    },
  });
}
export class RecoveryService {
  constructor(
    readonly database: Database,
    readonly principal: Principal,
  ) {}
  tx<T>(
    fn: (tx: Transaction, organizationId: string) => Promise<T>,
    scope: 'crm:read' | 'crm:write' | 'agents:write' | 'revenue:write' = 'agents:write',
  ) {
    return tenantTransaction(this.database, this.principal.organizationId, async (tx) => {
      await authorizeCurrent(tx, this.principal, scope);
      return fn(tx, this.principal.organizationId);
    });
  }
  configure(raw: unknown) {
    const v = object(raw);
    keys(v, ['config', 'connectionId', 'expectedVersion', 'reviewed']);
    if (v.reviewed !== true) throw new WorkforceError(400, 'recovery_review_required');
    const config = parseConfig(v.config);
    validateActivation(config);
    const expected = integer(v.expectedVersion, 0, 100),
      connectionId = v.connectionId === null ? null : uuid(v.connectionId);
    return this.tx(async (tx, organizationId) => {
      const existing = await tx.recoveryProgram.findUnique({
        where: { organizationId },
        include: { runtimeVersion: true, agent: true },
      });
      for (const knowledge of config.knowledge) {
        if (knowledge.versionId)
          await currentPublicClaim(tx, organizationId, knowledge.versionId, knowledge.text);
        else if (process.env.BUSINESS_KNOWLEDGE_ENABLED === 'true')
          throw new WorkforceError(400, 'approved_knowledge_version_required');
      }
      if (
        (existing?.runtimeVersion.number ?? 0) !== expected ||
        (existing && existing.agent.configVersion !== expected)
      )
        throw new WorkforceError(409, 'recovery_version_conflict');
      if (
        connectionId &&
        !(await tx.externalConnection.findFirst({
          where: { organizationId, id: connectionId, enabled: true },
        }))
      )
        throw new WorkforceError(404, 'recovery_connection_not_found');
      for (const id of config.pipelineIds)
        if (
          !(await tx.pipeline.findFirst({
            where: { organizationId, id, record: { archivedAt: null } },
          }))
        )
          throw new WorkforceError(404, 'recovery_pipeline_not_found');
      for (const id of config.stageIds) {
        const stage = await tx.pipelineStage.findFirst({
          where: { organizationId, id, outcome: 'open', record: { archivedAt: null } },
        });
        if (!stage || (config.pipelineIds.length && !config.pipelineIds.includes(stage.pipelineId)))
          throw new WorkforceError(404, 'recovery_stage_not_found');
      }
      const definition = runtimeDefinition(config);
      let agentId: string, version;
      if (existing) {
        agentId = existing.agentId;
        version = await appendAgentVersionInTransaction(
          tx,
          organizationId,
          agentId,
          definition,
          this.principal.actor,
        );
      } else {
        const created = await createAgentInTransaction(
          tx,
          organizationId,
          definition,
          this.principal.actor,
        );
        agentId = created.agent.id;
        version = created.version;
      }
      await tx.agentVersion.update({
        where: { organizationId_id: { organizationId, id: version.id } },
        data: { specialization: json(config) },
      });
      const program = await tx.recoveryProgram.upsert({
        where: { organizationId },
        create: { organizationId, agentId, runtimeVersionId: version.id, connectionId },
        update: {
          runtimeVersionId: version.id,
          connectionId,
          nextScanAt: new Date(),
          scanCursor: null,
        },
      });
      // Configuration changes never silently reactivate cases or pending deliveries.
      const cases = await tx.recoveryCase.findMany({
        where: {
          organizationId,
          state: { in: ['monitoring', 'working', 'awaiting_classification'] },
        },
        include: { opportunity: { select: { record: { select: { assignedMemberId: true } } } } },
      });
      // Bounded bulk operations keep reconfiguration atomic without thousands of
      // per-case transactions/round trips. Already claimed deliveries remain evidence.
      const caseIds = cases.map((row) => row.id),
        runIds = cases.flatMap((row) => (row.pendingRunId ? [row.pendingRunId] : [])),
        now = new Date();
      await tx.humanApproval.updateMany({
        where: { organizationId, status: 'pending', action: { runId: { in: runIds } } },
        data: {
          status: 'rejected',
          reason: 'configuration_changed',
          decidedBy: 'recovery-safety',
          decidedAt: now,
        },
      });
      await tx.agentAction.updateMany({
        where: { organizationId, runId: { in: runIds }, status: 'pending_approval' },
        data: { status: 'blocked', errorCode: 'configuration_changed', completedAt: now },
      });
      await tx.agentRun.updateMany({
        where: {
          organizationId,
          id: { in: runIds },
          status: { in: ['pending', 'running', 'waiting_approval'] },
        },
        data: {
          status: 'stopped',
          completedAt: now,
          errorCode: 'configuration_changed',
          leaseToken: null,
          leasedUntil: null,
        },
      });
      await tx.recoveryDispatch.updateMany({
        where: { organizationId, caseId: { in: caseIds }, status: 'pending' },
        data: { status: 'cancelled', errorCode: 'configuration_changed' },
      });
      if (process.env.COMMUNICATIONS_ENABLED === 'true') {
        const deliveries = await tx.communicationDelivery.findMany({
          where: {
            organizationId,
            recoveryDispatch: { caseId: { in: caseIds }, status: 'cancelled' },
            status: 'awaiting_provider',
          },
          select: { recoveryDispatchId: true },
        });
        for (const delivery of deliveries)
          await recoveryStatus(
            tx,
            organizationId,
            delivery.recoveryDispatchId!,
            'cancelled',
            null,
            'configuration_changed',
            now,
          );
      }
      await tx.recoveryCase.updateMany({
        where: { organizationId, id: { in: caseIds } },
        data: {
          state: 'handoff',
          reason: 'configuration_changed',
          revision: { increment: 1 },
          nextDueAt: null,
        },
      });
      await tx.recoveryHandoff.createMany({
        data: cases.map((row) => ({
          organizationId,
          caseId: row.id,
          assignedMemberId: row.opportunity.record.assignedMemberId,
          reason: 'configuration_changed',
          summary: 'Configuration changed. Review this opportunity before returning it to AI.',
        })),
        skipDuplicates: true,
      });
      await tx.recoveryHandoff.updateMany({
        where: { organizationId, caseId: { in: caseIds }, status: { not: 'owned' } },
        data: {
          status: 'open',
          reason: 'configuration_changed',
          summary: 'Configuration changed. Review before returning to AI.',
          revision: { increment: 1 },
        },
      });
      await audit(tx, organizationId, this.principal.actor, 'recovery.configured', program.id, {
        runtimeVersionId: version.id,
        version: version.number,
      });
      return program;
    });
  }
  enable(value: unknown) {
    const enabled = boolean(value);
    return this.tx(async (tx, organizationId) => {
      const program = await tx.recoveryProgram.findUnique({
        where: { organizationId },
        include: { runtimeVersion: true, agent: true, organization: true },
      });
      if (!program) throw new WorkforceError(404, 'recovery_not_configured');
      if (enabled) {
        validateActivation(parseConfig(program.runtimeVersion.specialization));
        if (!program.organization.active) throw new WorkforceError(409, 'organization_inactive');
        if (program.agent.configVersion !== program.runtimeVersion.number)
          throw new WorkforceError(409, 'recovery_version_changed');
      }
      await tx.workforceAgent.update({
        where: { organizationId_id: { organizationId, id: program.agentId } },
        data: { enabled },
      });
      await audit(tx, organizationId, this.principal.actor, 'recovery.enabled', program.id, {
        enabled,
      });
      return { enabled };
    });
  }
  enroll(opportunityId: string) {
    uuid(opportunityId);
    return this.tx(async (tx, organizationId) => {
      const program = await tx.recoveryProgram.findUnique({ where: { organizationId } });
      if (!program) throw new WorkforceError(404, 'recovery_not_configured');
      const result = await enroll(tx, program, opportunityId, new Date());
      if (!result) throw new WorkforceError(404, 'eligible_opportunity_not_found');
      return result;
    });
  }
  consent(raw: unknown) {
    const v = object(raw);
    keys(v, ['contactId', 'channel', 'granted', 'evidence']);
    const contactId = uuid(v.contactId),
      channel = string(v.channel, 10),
      granted = boolean(v.granted),
      evidence = string(v.evidence, 1000);
    if (!['sms', 'email'].includes(channel)) throw new WorkforceError(400, 'invalid_channel');
    return this.tx(async (tx, organizationId) => {
      const contact = await tx.contact.findFirst({
        where: { organizationId, id: contactId, record: { archivedAt: null } },
      });
      if (!contact) throw new WorkforceError(404, 'contact_not_found');
      if (granted && contact.doNotContact) throw new WorkforceError(409, 'contact_opted_out');
      const result = await tx.recoveryConsent.upsert({
        where: { organizationId_contactId_channel: { organizationId, contactId, channel } },
        create: {
          organizationId,
          contactId,
          channel,
          granted,
          evidence,
          recordedBy: this.principal.actor,
        },
        update: { granted, evidence, recordedBy: this.principal.actor },
      });
      await audit(
        tx,
        organizationId,
        this.principal.actor,
        'recovery.consent_recorded',
        contactId,
        { channel, granted },
      );
      return result;
    });
  }
  detail(id: string) {
    uuid(id);
    return this.tx(async (tx, organizationId) => {
      const row = await loadCase(tx, organizationId, id);
      const [decisions, dispatches, attributions, activity] = await Promise.all([
        tx.recoveryDecision.findMany({
          where: { organizationId, caseId: id },
          orderBy: { createdAt: 'desc' },
          take: 30,
        }),
        tx.recoveryDispatch.findMany({
          where: { organizationId, caseId: id },
          select: {
            id: true,
            status: true,
            body: true,
            channel: true,
            actor: true,
            deliveredAt: true,
            errorCode: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 30,
        }),
        tx.recoveryAttribution.findMany({ where: { organizationId, caseId: id } }),
        tx.auditLog.findMany({
          where: { organizationId, subjectId: id },
          orderBy: { createdAt: 'desc' },
          take: 30,
        }),
      ]);
      return {
        case: {
          id: row.id,
          opportunity: row.opportunity,
          contact: row.contact,
          state: row.state,
          reason: row.reason,
          attempts: row.attempts,
          nextDueAt: row.nextDueAt,
          revision: row.revision,
          latestResponse: row.latestResponse,
        },
        handoff: row.handoff,
        decisions,
        dispatches,
        attributions,
        activity,
      };
    }, 'crm:read');
  }
}
