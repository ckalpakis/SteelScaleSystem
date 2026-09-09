import { randomBytes } from 'node:crypto';
import { recoveryStatus } from '../communications/ledger.js';
import { evaluate } from '../agents/policy.js';
import { loadContext } from '../agents/context.js';
import { parseDefinition } from '../agents/contracts.js';
import { CrmService } from '../crm/service.js';
import { audit } from '../workforce/audit/service.js';
import { authorize, tokenHash, type Principal } from '../workforce/tenancy/service.js';
import {
  date,
  hash,
  keys,
  object,
  string,
  tenantTransaction,
  uuid,
  WorkforceError,
  type Database,
  type Transaction,
} from '../workforce/shared.js';
import { ensureHandoff, loadCase, messageGuard, pauseCase } from './lifecycle.js';
import { parseConfig, one } from './contracts.js';

async function authorizeAdapter(tx: Transaction, principal: Principal) {
  authorize(principal, 'events:write');
  const credential = await tx.workforceCredential.findFirst({
    where: { organizationId: principal.organizationId, id: principal.credentialId },
    include: { integration: true },
  });
  if (
    !credential ||
    credential.revokedAt ||
    credential.expiresAt <= new Date() ||
    !credential.integration?.enabled ||
    credential.integrationId !== principal.integrationId ||
    !credential.scopes.includes('events:write')
  )
    throw new WorkforceError(401, 'credential_changed');
  const program = await tx.recoveryProgram.findUnique({
    where: { organizationId: principal.organizationId },
  });
  if (!program || !principal.integrationId || program.connectionId !== principal.integrationId)
    throw new WorkforceError(403, 'recovery_adapter_forbidden');
  return program;
}
export class RecoveryDeliveryService {
  constructor(
    readonly database: Database,
    readonly principal: Principal,
  ) {}
  list() {
    return tenantTransaction(this.database, this.principal.organizationId, async (tx) => {
      await authorizeAdapter(tx, this.principal);
      return tx.recoveryDispatch.findMany({
        where: {
          organizationId: this.principal.organizationId,
          status: 'pending',
          availableAt: { lte: new Date() },
        },
        select: { id: true, availableAt: true },
        orderBy: { availableAt: 'asc' },
        take: 50,
      });
    });
  }
  claim(id: string, now = new Date()) {
    uuid(id);
    if (
      process.env.REVENUE_RECOVERY_DELIVERY_ENABLED !== 'true' ||
      process.env.REVENUE_RECOVERY_ENABLED !== 'true' ||
      process.env.AGENT_RUNTIME_ENABLED !== 'true'
    )
      throw new WorkforceError(503, 'recovery_delivery_disabled');
    return tenantTransaction(this.database, this.principal.organizationId, async (tx) => {
      const program = await authorizeAdapter(tx, this.principal),
        organizationId = this.principal.organizationId;
      const dispatch = await tx.recoveryDispatch.findFirst({
        where: { organizationId, id },
        include: { action: { include: { approval: true } } },
      });
      if (!dispatch) throw new WorkforceError(404, 'recovery_dispatch_not_found');
      if (dispatch.status !== 'pending' || dispatch.availableAt > now)
        throw new WorkforceError(409, 'recovery_dispatch_not_claimable');
      const row = await loadCase(tx, organizationId, dispatch.caseId),
        human = dispatch.actor.startsWith('member:');
      let blocked =
        dispatch.runtimeVersionId !== program.runtimeVersionId ||
        dispatch.caseRevision !== row.revision
          ? 'recovery_context_changed'
          : await messageGuard(tx, row, dispatch.channel, now, {
              human,
              dispatchId: id,
              ignoreDue: dispatch.transportAttempts > 0,
              reservedAttempt: dispatch.transportAttempts > 0,
            });
      if (human && !blocked) {
        const memberId = dispatch.actor.slice(7);
        const member = await tx.organizationMember.findFirst({
          where: { organizationId, id: memberId, active: true },
        });
        if (!member || row.handoff?.status !== 'owned' || row.handoff.assignedMemberId !== memberId)
          blocked = 'recovery_human_authority_changed';
      }
      if (!human && !blocked) {
        if (
          dispatch.action?.status !== 'completed' ||
          dispatch.action.approval?.status !== 'approved'
        )
          blocked = 'recovery_approval_required';
        else {
          const config = parseDefinition(row.program.runtimeVersion.definition);
          const policy = evaluate(config, {
            tool: 'send_recovery_message',
            effect: 'external',
            enabled: row.program.agent.enabled,
            currentVersion: row.program.agent.configVersion === row.program.runtimeVersion.number,
            context: await loadContext(tx, organizationId, row.opportunityId, config),
            automaticAvailable: true,
            actions: 0,
            attempts: row.attempts - (dispatch.transportAttempts > 0 ? 1 : 0),
            now,
            approved: true,
            channel: dispatch.channel,
          });
          if (policy.outcome !== 'allow') blocked = policy.reason;
        }
      }
      if (blocked) {
        if (blocked === 'outside_operating_hours') return { blocked, retryable: true };
        await tx.recoveryDispatch.update({
          where: { organizationId_id: { organizationId, id } },
          data: { status: 'cancelled', errorCode: blocked },
        });
        await audit(tx, organizationId, 'recovery-delivery', 'recovery.dispatch_blocked', id, {
          code: blocked,
        });
        if (process.env.COMMUNICATIONS_ENABLED === 'true')
          await recoveryStatus(tx, organizationId, id, 'cancelled', null, blocked, now);
        return { blocked, retryable: false };
      }
      if (dispatch.transportAttempts >= 3)
        throw new WorkforceError(409, 'recovery_transport_attempt_limit');
      const claimToken = randomBytes(32).toString('hex'),
        expiresAt = new Date(now.getTime() + 30000);
      await tx.recoveryDispatch.update({
        where: { organizationId_id: { organizationId, id } },
        data: {
          status: 'dispatching',
          claimTokenHash: tokenHash(claimToken),
          claimedUntil: expiresAt,
          transportAttempts: { increment: 1 },
          receiptHash: null,
        },
      });
      if (!human && dispatch.transportAttempts === 0)
        await tx.recoveryCase.update({
          where: { organizationId_id: { organizationId, id: row.id } },
          data: { attempts: { increment: 1 } },
        });
      await audit(tx, organizationId, this.principal.actor, 'recovery.dispatch_claimed', id, {
        caseId: row.id,
        attempt: dispatch.transportAttempts + 1,
        expiresAt,
      });
      if (process.env.COMMUNICATIONS_ENABLED === 'true')
        await recoveryStatus(tx, organizationId, id, 'sending', null, null, now);
      return {
        version: 1,
        dispatchId: id,
        idempotencyKey: id,
        claimToken,
        expiresAt,
        channel: dispatch.channel,
        destination: dispatch.channel === 'sms' ? row.contact.phone : row.contact.email,
        message: dispatch.body,
        requirements: {
          deduplicateBy: 'idempotencyKey',
          sendBefore: expiresAt,
          receiptRequired: true,
          unknownOutcomeMustNotRetry: true,
        },
      };
    });
  }
  receipt(id: string, raw: unknown, now = new Date()) {
    uuid(id);
    const v = object(raw);
    keys(v, ['claimToken', 'status', 'providerMessageId', 'occurredAt', 'evidence']);
    const claimToken = string(v.claimToken, 64),
      status = one(v.status, ['delivered', 'not_sent', 'unknown']),
      providerId = v.providerMessageId === null ? null : string(v.providerMessageId, 150),
      occurredAt = date(v.occurredAt, now),
      evidence = string(v.evidence, 1000);
    if (status === 'delivered' && !providerId)
      throw new WorkforceError(400, 'provider_receipt_required');
    return tenantTransaction(this.database, this.principal.organizationId, async (tx) => {
      await authorizeAdapter(tx, this.principal);
      const organizationId = this.principal.organizationId;
      const dispatch = await tx.recoveryDispatch.findFirst({ where: { organizationId, id } });
      if (!dispatch) throw new WorkforceError(404, 'recovery_dispatch_not_found');
      if (dispatch.claimTokenHash !== tokenHash(claimToken))
        throw new WorkforceError(403, 'invalid_delivery_claim');
      const fingerprint = hash({ status, providerId, occurredAt, evidence });
      if (dispatch.receiptHash) {
        if (dispatch.receiptHash === fingerprint)
          return { status: dispatch.status, duplicate: true };
        if (dispatch.status !== 'unknown' || status === 'unknown')
          throw new WorkforceError(409, 'receipt_conflict');
      }
      if (!['dispatching', 'unknown'].includes(dispatch.status))
        throw new WorkforceError(409, 'receipt_not_expected');
      if (!dispatch.claimedUntil || occurredAt.getTime() < dispatch.claimedUntil.getTime() - 30000)
        throw new WorkforceError(400, 'receipt_time_conflict');
      const row = await loadCase(tx, organizationId, dispatch.caseId),
        config = parseConfig(row.program.runtimeVersion.specialization),
        human = dispatch.actor.startsWith('member:');
      const finalStatus =
        status === 'not_sent' ? (dispatch.transportAttempts < 3 ? 'pending' : 'failed') : status;
      await tx.recoveryDispatch.update({
        where: { organizationId_id: { organizationId, id } },
        data: {
          status: finalStatus,
          receiptHash: fingerprint,
          providerMessageId: providerId ? `${this.principal.integrationId}:${providerId}` : null,
          deliveredAt: status === 'delivered' ? occurredAt : null,
          errorCode:
            status === 'delivered'
              ? null
              : status === 'unknown'
                ? 'delivery_outcome_unknown'
                : 'provider_confirmed_not_sent',
          availableAt: new Date(now.getTime() + 10000 * 2 ** dispatch.transportAttempts),
        },
      });
      if (status === 'delivered') {
        const crm = new CrmService(this.database, this.principal);
        if (row.conversationId && process.env.COMMUNICATIONS_ENABLED !== 'true')
          await crm.projectExternal(
            tx,
            'messages',
            undefined,
            {
              conversationId: row.conversationId,
              direction: 'outbound',
              body: dispatch.body,
              status: 'recorded',
              occurredAt: occurredAt.toISOString(),
            },
            {
              source: {
                organizationId,
                system: 'steel_scale_agent',
                provider: row.program.connection!.provider,
                connectionId: this.principal.integrationId!,
                actor: dispatch.actor,
              },
              idempotencyKey: `recovery-dispatch:${id}`,
              correlationId: id,
            },
          );
        if (!human) {
          const next = config.cadenceMinutes[row.attempts - 1];
          await tx.recoveryCase.update({
            where: { organizationId_id: { organizationId, id: row.id } },
            data: {
              firstDeliveredAt: row.firstDeliveredAt ?? occurredAt,
              lastDeliveredAt: occurredAt,
              ...(['working', 'monitoring'].includes(row.state) &&
              row.revision === dispatch.caseRevision
                ? {
                    state: row.attempts >= config.maximumAttempts ? 'exhausted' : 'monitoring',
                    nextDueAt: next ? new Date(occurredAt.getTime() + next * 60000) : null,
                    pendingRunId: null,
                  }
                : {}),
            },
          });
        }
      } else if (finalStatus === 'unknown' || finalStatus === 'failed') {
        await pauseCase(
          tx,
          row,
          'handoff',
          finalStatus === 'unknown' ? 'delivery_outcome_unknown' : 'delivery_failed',
          now,
        );
        await ensureHandoff(
          tx,
          row,
          'delivery_review_required',
          status === 'unknown'
            ? 'Delivery outcome is unknown. Do not resend until reconciled.'
            : 'Provider confirmed no delivery and the retry budget is exhausted.',
          now,
        );
      }
      if (process.env.COMMUNICATIONS_ENABLED === 'true')
        await recoveryStatus(
          tx,
          organizationId,
          id,
          finalStatus === 'pending' ? 'awaiting_provider' : finalStatus,
          providerId,
          status === 'delivered'
            ? null
            : status === 'unknown'
              ? 'delivery_outcome_unknown'
              : 'provider_confirmed_not_sent',
          occurredAt,
        );
      await audit(tx, organizationId, this.principal.actor, 'recovery.delivery_receipt', id, {
        status,
        caseId: row.id,
        evidence,
        providerMessageId: providerId,
        occurredAt,
      });
      return { status: finalStatus, duplicate: false };
    });
  }
}
