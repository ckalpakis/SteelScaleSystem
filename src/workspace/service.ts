import type { Prisma } from '@prisma/client';
import { authorizeCurrent } from '../agents/service.js';
import { currentPublicClaim } from '../knowledge/retrieval.js';
import { parseConfig, validateActivation } from '../recovery/contracts.js';
import { json, tenantTransaction, WorkforceError, type Database } from '../workforce/shared.js';
import type { Principal } from '../workforce/tenancy/service.js';

export type QueueFilter = 'all' | 'mine' | 'unassigned';
export function workspaceFilters(days: unknown, queue: unknown, role?: string) {
  if (days !== undefined && (typeof days !== 'string' || !['7', '30', '90'].includes(days)))
    throw new WorkforceError(400, 'choose_7_30_or_90_days');
  if (
    queue !== undefined &&
    (typeof queue !== 'string' || !['all', 'mine', 'unassigned'].includes(queue))
  )
    throw new WorkforceError(400, 'choose_all_mine_or_unassigned');
  return {
    days: days === undefined ? 30 : Number(days),
    queue: (queue ?? (role === 'member' ? 'mine' : 'all')) as QueueFilter,
  };
}

export interface SetupCheck {
  key: string;
  title: string;
  complete: boolean;
  detail: string;
  href: string;
  action: string;
}

/** A bounded, tenant-scoped projection. Never enables agents or sends communication. */
export class WorkspaceService {
  constructor(
    readonly database: Database,
    readonly principal: Principal,
  ) {}

  overview(rawDays?: unknown, rawQueue?: unknown, now = new Date()) {
    const filters = workspaceFilters(rawDays, rawQueue, this.principal.role);
    const from = new Date(now.getTime() - filters.days * 86400000);
    const sinceYesterday = new Date(now.getTime() - 86400000);
    const organizationId = this.principal.organizationId;
    const memberId = this.principal.actor.startsWith('member:')
      ? this.principal.actor.slice(7)
      : '';
    const handoffWhere: Prisma.RecoveryHandoffWhereInput = {
      organizationId,
      status: { in: ['open', 'owned'] },
      ...(filters.queue === 'mine'
        ? { assignedMemberId: memberId }
        : filters.queue === 'unassigned'
          ? { assignedMemberId: null }
          : {}),
    };
    const outcomeWhere = { organizationId, occurredAt: { gte: from, lte: now } };
    // Financial totals require the existing attribution review AND its payment evidence.
    const verified = {
      ...outcomeWhere,
      status: 'AI_RECOVERED',
      reviewedAt: { not: null },
      reviewedBy: { not: null },
    };
    return tenantTransaction(this.database, organizationId, async (tx) => {
      await authorizeCurrent(tx, this.principal, 'crm:read');
      const [
        organization,
        program,
        contacts,
        opportunities,
        handoffs,
        queueCount,
        agingCount,
        approvals,
        expiredApprovals,
        uncertainDeliveries,
        failedDeliveries,
        outboundFailures,
        working,
        pipeline,
        revenue,
        recoveredAppointments,
        pendingEvidence,
        outcomes,
        evidence,
        consentCount,
        lastDelivery,
      ] = await Promise.all([
        tx.organization.findUniqueOrThrow({
          where: { id: organizationId },
          select: { name: true, active: true },
        }),
        tx.recoveryProgram.findUnique({
          where: { organizationId },
          include: {
            agent: { select: { enabled: true, configVersion: true } },
            runtimeVersion: { select: { number: true, specialization: true, createdAt: true } },
            connection: { select: { enabled: true, name: true } },
          },
        }),
        tx.contact.count({ where: { organizationId, record: { archivedAt: null } } }),
        tx.opportunity.count({ where: { organizationId, record: { archivedAt: null } } }),
        tx.recoveryHandoff.findMany({
          where: handoffWhere,
          orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
          take: 30,
          select: {
            id: true,
            caseId: true,
            status: true,
            reason: true,
            updatedAt: true,
            assignedMember: { select: { displayName: true } },
            case: {
              select: {
                contact: { select: { name: true } },
                opportunity: { select: { title: true, currency: true, amountMinor: true } },
              },
            },
          },
        }),
        tx.recoveryHandoff.count({ where: handoffWhere }),
        tx.recoveryHandoff.count({
          where: { ...handoffWhere, updatedAt: { lte: sinceYesterday } },
        }),
        tx.humanApproval.count({
          where: {
            organizationId,
            status: 'pending',
            expiresAt: { gt: now },
            action: { tool: 'send_recovery_message' },
          },
        }),
        tx.humanApproval.count({
          where: {
            organizationId,
            status: 'pending',
            expiresAt: { lte: now },
            action: { tool: 'send_recovery_message' },
          },
        }),
        tx.recoveryDispatch.count({ where: { organizationId, status: 'unknown' } }),
        tx.recoveryDispatch.count({ where: { organizationId, status: 'failed' } }),
        tx.outboundDelivery.count({ where: { organizationId, status: 'dead' } }),
        tx.recoveryCase.count({
          where: { organizationId, state: { in: ['monitoring', 'working'] } },
        }),
        tx.opportunity.groupBy({
          by: ['currency'],
          where: {
            organizationId,
            record: { archivedAt: null },
            status: { in: ['open', 'estimate_sent'] },
          },
          _sum: { amountMinor: true },
          _count: true,
        }),
        tx.recoveryAttribution.groupBy({
          by: ['currency'],
          where: {
            ...verified,
            kind: 'opportunity',
            paymentReference: { not: null },
            amountMinor: { gt: 0 },
          },
          _sum: { amountMinor: true },
          _count: true,
        }),
        tx.recoveryAttribution.count({ where: { ...verified, kind: 'appointment' } }),
        tx.recoveryAttribution.count({ where: { ...outcomeWhere, reviewedAt: null } }),
        tx.recoveryAttribution.groupBy({ by: ['status'], where: outcomeWhere, _count: true }),
        tx.recoveryAttribution.findMany({
          where: outcomeWhere,
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
          take: 20,
          select: {
            id: true,
            caseId: true,
            status: true,
            kind: true,
            occurredAt: true,
            reviewedAt: true,
            case: { select: { opportunity: { select: { title: true } } } },
          },
        }),
        tx.recoveryConsent.count({
          where: {
            organizationId,
            granted: true,
            contact: { doNotContact: false, record: { archivedAt: null } },
          },
        }),
        tx.recoveryDispatch.findFirst({
          where: { organizationId, status: 'delivered', deliveredAt: { not: null } },
          orderBy: { deliveredAt: 'desc' },
          select: { deliveredAt: true },
        }),
      ]);
      let configValid = false,
        knowledgeCurrent = false,
        simulationCount = 0;
      if (program) {
        try {
          const config = parseConfig(program.runtimeVersion.specialization);
          validateActivation(config);
          configValid = program.agent.configVersion === program.runtimeVersion.number;
          simulationCount = await tx.recoverySimulation.count({
            where: {
              organizationId,
              createdAt: { gte: program.runtimeVersion.createdAt },
              input: { path: ['config'], equals: json(config) },
            },
          });
          if (process.env.BUSINESS_KNOWLEDGE_ENABLED === 'true') {
            for (const entry of config.knowledge) {
              if (!entry.versionId) throw new WorkforceError(409, 'knowledge_version_required');
              await currentPublicClaim(tx, organizationId, entry.versionId, entry.text);
            }
            knowledgeCurrent = true;
          }
        } catch (error) {
          if (!(error instanceof WorkforceError)) throw error;
          // Expected stale/invalid configuration is a visible checklist gap, not a 500.
        }
      }
      const features = {
        crm: process.env.CRM_ENABLED === 'true',
        recovery:
          process.env.REVENUE_RECOVERY_ENABLED === 'true' &&
          process.env.AGENT_RUNTIME_ENABLED === 'true',
        knowledge: process.env.BUSINESS_KNOWLEDGE_ENABLED === 'true',
      };
      const checks: SetupCheck[] = [
        {
          key: 'records',
          title: 'Bring in your business data',
          complete: contacts > 0 && opportunities > 0,
          detail: `${contacts} contacts and ${opportunities} opportunities. Use the built-in CRM or import from your existing system; a CRM integration is optional.`,
          href: features.crm ? '/workspace/crm/contacts' : '/integrations',
          action: features.crm ? 'Open CRM' : 'Connect your CRM',
        },
        {
          key: 'configuration',
          title: 'Review Recovery rules',
          complete: configValid,
          detail: configValid
            ? `Reviewed configuration version ${program!.runtimeVersion.number}. Changes require review again.`
            : 'Review eligibility, cadence, working hours, channels, and an allowed model. Saving rules does not enable the agent.',
          href: '/revenue-recovery',
          action: 'Review configuration',
        },
        {
          key: 'knowledge',
          title: 'Verify the exact customer-facing text',
          complete: knowledgeCurrent,
          detail: knowledgeCurrent
            ? 'Every configured message references current, approved, public, general-risk knowledge. Knowledge does not grant action permissions.'
            : 'Recovery text needs current approved knowledge versions. Inactive, edited, internal, or high-risk sources do not qualify. Legacy inline text is not version-verified here.',
          href: features.knowledge ? '/business-knowledge' : '/revenue-recovery',
          action: features.knowledge
            ? 'Review business knowledge'
            : 'Ask your operator to enable Business Knowledge',
        },
        {
          key: 'consent',
          title: 'Record permission to contact customers',
          complete: consentCount > 0,
          detail: `${consentCount} granted channel-consent records on non-DND, active contacts. This is not coverage for every opportunity; each send rechecks consent and suppression.`,
          href: '/revenue-recovery',
          action: 'Review consent',
        },
        {
          key: 'simulation',
          title: 'Test this configuration without sending',
          complete: simulationCount > 0,
          detail: simulationCount
            ? `${simulationCount} offline simulations recorded since this version was saved, using this exact configuration. These test scenarios, not live delivery or model quality.`
            : 'Run an offline scenario with the saved configuration. Tests of older or edited drafts do not count for this version.',
          href: '/revenue-recovery',
          action: 'Run a simulation',
        },
        {
          key: 'delivery',
          title: 'Check the delivery path with your operator',
          complete: !!program?.connection?.enabled,
          detail: program?.connection?.enabled
            ? `Connection configured: ${program.connection.name}. This is configuration only—not proof that the provider or worker is running.`
            : 'Choose an enabled delivery connection. An inbound Zapier connection alone does not implement customer messaging.',
          href: '/integrations',
          action: 'Review integrations',
        },
      ];
      return {
        filters,
        from,
        now,
        organization,
        features,
        checks,
        agentEnabled: program?.agent.enabled ?? false,
        deliverySwitch: process.env.REVENUE_RECOVERY_DELIVERY_ENABLED === 'true',
        modelSwitch: process.env.AGENT_MODEL_ENABLED === 'true',
        handoffs,
        queueCount,
        agingCount,
        approvals,
        expiredApprovals,
        uncertainDeliveries,
        failedDeliveries,
        outboundFailures,
        working,
        pipeline,
        revenue,
        recoveredAppointments,
        pendingEvidence,
        outcomes,
        evidence,
        lastDelivery: lastDelivery?.deliveredAt ?? null,
      };
    });
  }
}

export type WorkspaceOverview = Awaited<ReturnType<WorkspaceService['overview']>>;
