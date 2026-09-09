import { randomUUID } from 'node:crypto';
import { deliveryTransition } from './contracts.js';
import type { CommunicationAccount } from '@prisma/client';
import { unseal } from '../integrations/security.js';
import { audit } from '../workforce/audit/service.js';
import {
  hash,
  tenantTransaction,
  WorkforceError,
  type Database,
  type Transaction,
} from '../workforce/shared.js';
import { assertContactAllowed, suppress } from './safety.js';
import { TwilioSmsProvider, type Provider, type ProviderResult } from './providers.js';
export type ProviderResolver = (account: CommunicationAccount) => Provider;
export const resolveProvider: ProviderResolver = (account) => {
  if (account.provider !== 'twilio' || account.channel !== 'sms')
    throw new WorkforceError(409, 'communication_provider_not_installed');
  return new TwilioSmsProvider(
    account.externalAccountId,
    unseal(account.encryptedCredentials, `communication:${account.organizationId}:${account.id}`),
  );
};
export async function recordStatus(
  tx: Transaction,
  organizationId: string,
  id: string,
  status: string,
  eventKey: string,
  externalId: string | null,
  errorCode: string | null,
  now: Date,
) {
  const row = await tx.communicationDelivery.findFirstOrThrow({ where: { organizationId, id } });
  if (row.externalId && externalId && row.externalId !== externalId)
    throw new WorkforceError(409, 'communication_receipt_mismatch');
  const prior = await tx.communicationAttempt.findUnique({
    where: { organizationId_deliveryId_eventKey: { organizationId, deliveryId: id, eventKey } },
  });
  if (prior) return row;
  const next = deliveryTransition(row.status, status);
  await tx.communicationAttempt.create({
    data: {
      organizationId,
      deliveryId: id,
      eventKey,
      status,
      externalId,
      errorCode,
      occurredAt: now,
    },
  });
  const result = await tx.communicationDelivery.update({
    where: { organizationId_id: { organizationId, id } },
    data: {
      status: next,
      ...(next === status ? { errorCode, statusAt: now } : {}),
      externalId: row.externalId ?? externalId,
      ...(next === 'accepted' && !row.acceptedAt ? { acceptedAt: now } : {}),
      ...(next === 'delivered' && !row.deliveredAt ? { deliveredAt: now } : {}),
    },
  });
  if (errorCode === 'provider_opt_out')
    await suppress(tx, organizationId, row.contactId, 'provider_opt_out');
  await audit(tx, organizationId, 'communication-delivery', 'communication.status', id, {
    status: next,
    errorCode,
    externalId,
  });
  return result;
}
export async function processDeliveryStatus(
  database: Database,
  accountId: string,
  deliveryId: string,
  externalId: string,
  status: 'accepted' | 'sent' | 'delivered' | 'failed',
  errorCode: string | null = null,
) {
  const account = await database.communicationAccount.findUnique({ where: { id: accountId } });
  if (!account) throw new WorkforceError(404, 'communication_account_not_found');
  return tenantTransaction(database, account.organizationId, async (tx) => {
    const row = await tx.communicationDelivery.findFirst({
      where: {
        organizationId: account.organizationId,
        id: deliveryId,
        accountId,
        direction: 'outbound',
      },
    });
    if (!row || (row.externalId && row.externalId !== externalId) || !row.attempts)
      throw new WorkforceError(409, 'communication_receipt_mismatch');
    return recordStatus(
      tx,
      account.organizationId,
      row.id,
      status,
      hash({ externalId, status, errorCode }),
      externalId,
      errorCode,
      new Date(),
    );
  });
}
export async function sendOnce(
  database: Database,
  resolve: ProviderResolver = resolveProvider,
  now = new Date(),
  organizationId?: string,
) {
  if (
    process.env.COMMUNICATIONS_ENABLED !== 'true' ||
    process.env.COMMUNICATION_DELIVERY_ENABLED !== 'true'
  )
    return false;
  // Global scheduler discovery only; every mutation and data read below is tenant-scoped.
  const candidate = await database.communicationDelivery.findFirst({
    where: {
      ...(organizationId ? { organizationId } : {}),
      recoveryDispatchId: null,
      OR: [
        { status: 'queued', availableAt: { lte: now } },
        { status: 'sending', leasedUntil: { lte: now } },
        {
          status: { in: ['accepted', 'sent'] },
          statusAt: { lte: new Date(now.getTime() - 86400000) },
        },
      ],
    },
    orderBy: { availableAt: 'asc' },
    select: { id: true, organizationId: true },
  });
  if (!candidate) return false;
  const token = randomUUID();
  const prepared = await tenantTransaction(database, candidate.organizationId, async (tx) => {
    const row = await tx.communicationDelivery.findFirstOrThrow({
      where: { organizationId: candidate.organizationId, id: candidate.id },
      include: {
        account: { include: { connection: true } },
        message: true,
        conversation: { include: { record: true } },
      },
    });
    if (row.status === 'sending' && row.leasedUntil && row.leasedUntil <= now) {
      await recordStatus(
        tx,
        row.organizationId,
        row.id,
        'unknown',
        `expired:${row.leaseToken}`,
        row.externalId,
        'send_outcome_unknown',
        now,
      );
      return null;
    }
    if (
      ['accepted', 'sent'].includes(row.status) &&
      row.statusAt.getTime() <= now.getTime() - 86400000
    ) {
      await tx.communicationDelivery.update({
        where: { organizationId_id: { organizationId: row.organizationId, id: row.id } },
        data: { status: 'unknown' },
      });
      await recordStatus(
        tx,
        row.organizationId,
        row.id,
        'unknown',
        `receipt-timeout:${row.id}`,
        row.externalId,
        'delivery_receipt_overdue',
        now,
      );
      return null;
    }
    if (row.status !== 'queued' || row.availableAt > now) return null;
    try {
      const { destination } = await assertContactAllowed(
        tx,
        row.organizationId,
        row.contactId,
        row.channel,
      );
      if (row.recipient !== destination)
        throw new WorkforceError(409, 'communication_destination_changed');
      if (
        !row.account?.enabled ||
        !row.account.connection.enabled ||
        row.account.sender !== row.sender
      )
        throw new WorkforceError(409, 'communication_account_unavailable');
      if (
        row.conversation.status !== 'open' ||
        row.conversation.record.archivedAt ||
        row.message.direction !== 'outbound'
      )
        throw new WorkforceError(409, 'communication_conversation_unavailable');
      // The generic queue accepts human-authored messages only. Recovery owns its exact-action approval queue.
      if (
        !row.actor.startsWith('member:') ||
        !(await tx.organizationMember.findFirst({
          where: {
            organizationId: row.organizationId,
            id: row.actor.slice(7),
            active: true,
            role: { not: 'viewer' },
          },
        }))
      )
        throw new WorkforceError(403, 'communication_actor_unavailable');
      if (row.attempts >= 3) throw new WorkforceError(409, 'communication_attempt_limit');
    } catch (error) {
      if (!(error instanceof WorkforceError)) throw error;
      await recordStatus(
        tx,
        row.organizationId,
        row.id,
        'cancelled',
        `blocked:${row.attempts}`,
        null,
        error.code,
        now,
      );
      return null;
    }
    await tx.communicationDelivery.update({
      where: { organizationId_id: { organizationId: row.organizationId, id: row.id } },
      data: {
        status: 'sending',
        attempts: { increment: 1 },
        leaseToken: token,
        leasedUntil: new Date(now.getTime() + 60000),
      },
    });
    await tx.communicationAttempt.create({
      data: {
        organizationId: row.organizationId,
        deliveryId: row.id,
        eventKey: `claim:${token}`,
        status: 'sending',
      },
    });
    return row;
  });
  if (!prepared) return true;
  let outcome: ProviderResult;
  try {
    const provider = resolve(prepared.account!);
    const base = process.env.APP_URL;
    if (!base || !/^https:\/\//.test(base))
      throw new WorkforceError(503, 'communication_public_https_required');
    const input = {
      organizationId: prepared.organizationId,
      idempotencyKey: prepared.id,
      from: prepared.sender!,
      to: prepared.recipient!,
      body: prepared.message.body,
      statusCallback: new URL(
        `/api/communications/providers/twilio/${prepared.accountId}/status/${prepared.id}`,
        base,
      ).toString(),
    };
    if (prepared.channel === 'sms' && 'sendSms' in provider)
      outcome = await provider.sendSms(input);
    else if (prepared.channel === 'email' && 'sendEmail' in provider)
      outcome = await provider.sendEmail({ ...input, subject: prepared.conversation.subject });
    else
      outcome = {
        status: 'not_sent',
        externalId: null,
        errorCode: 'communication_provider_not_installed',
      };
  } catch (error) {
    outcome = {
      status: error instanceof WorkforceError ? 'not_sent' : 'unknown',
      externalId: null,
      errorCode: error instanceof WorkforceError ? error.code : 'provider_outcome_unknown',
    };
  }
  await tenantTransaction(database, prepared.organizationId, async (tx) => {
    const current = await tx.communicationDelivery.findFirstOrThrow({
      where: { organizationId: prepared.organizationId, id: prepared.id },
    });
    if (current.leaseToken !== token) return;
    const retry =
      outcome.status === 'not_sent' && outcome.retryable === true && current.attempts < 3;
    const status = retry ? 'queued' : outcome.status === 'not_sent' ? 'failed' : outcome.status;
    await recordStatus(
      tx,
      current.organizationId,
      current.id,
      status,
      `result:${token}`,
      outcome.externalId,
      outcome.errorCode ?? null,
      new Date(),
    );
    await tx.communicationDelivery.update({
      where: { organizationId_id: { organizationId: current.organizationId, id: current.id } },
      data: {
        leaseToken: null,
        leasedUntil: null,
        ...(retry ? { availableAt: new Date(now.getTime() + 10000 * 2 ** current.attempts) } : {}),
      },
    });
  });
  return true;
}
