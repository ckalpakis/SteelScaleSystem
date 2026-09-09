import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { OutboundDelivery } from '@prisma/client';
import { audit } from '../workforce/audit/service.js';
import { tenantTransaction, type Database } from '../workforce/shared.js';
import { sendWebhook, unseal, type Transport } from './security.js';

export function retryDelay(attempt: number) {
  return Math.min(3600000, 10000 * 2 ** Math.min(attempt, 9));
}
export async function deliverOnce(
  database: Database,
  transport: Transport = sendWebhook,
  now = new Date(),
  organizationId?: string,
) {
  if (process.env.WEBHOOK_DELIVERY_ENABLED !== 'true') return false;
  const token = randomUUID();
  const rows = await database.$queryRaw<OutboundDelivery[]>`
    UPDATE "OutboundDelivery" SET status = 'running', attempts = attempts + 1,
      "leaseToken" = ${token}::uuid, "leasedUntil" = ${new Date(now.getTime() + 60000)}
    WHERE id = (SELECT id FROM "OutboundDelivery" WHERE
      ((status = 'pending' AND "availableAt" <= ${now}) OR (status = 'running' AND "leasedUntil" <= ${now}))
      AND (${organizationId ?? null}::uuid IS NULL OR "organizationId" = ${organizationId ?? null}::uuid)
      ORDER BY "availableAt", id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`;
  const claimed = rows[0];
  if (!claimed) return false;
  logger.info(
    {
      organizationId: claimed.organizationId,
      eventId: claimed.eventId,
      deliveryId: claimed.id,
      attempt: claimed.attempts,
    },
    'Outbound integration claimed',
  );
  // Prepare under tenant lock; do network I/O outside any database transaction.
  const prepared = await tenantTransaction(database, claimed.organizationId, async (tx) => {
    const row = await tx.outboundDelivery.findFirst({
      where: {
        id: claimed.id,
        organizationId: claimed.organizationId,
        status: 'running',
        leaseToken: token,
      },
      include: { endpoint: true },
    });
    if (!row) return null;
    if (claimed.attempts > 1)
      await tx.outboundAttempt.upsert({
        where: {
          organizationId_deliveryId_attempt: {
            organizationId: row.organizationId,
            deliveryId: row.id,
            attempt: claimed.attempts - 1,
          },
        },
        create: {
          organizationId: row.organizationId,
          deliveryId: row.id,
          attempt: claimed.attempts - 1,
          errorCode: 'lease_expired_outcome_unknown',
        },
        update: {},
      });
    return row;
  });
  if (!prepared) return true;
  let statusCode: number | undefined;
  let errorCode: string | undefined;
  if (claimed.attempts > claimed.attemptsAllowed) errorCode = 'attempts_exhausted';
  else if (!prepared.endpoint.enabled) errorCode = 'endpoint_disabled';
  else
    try {
      const context = `${claimed.organizationId}:${claimed.endpointId}`;
      statusCode = await transport({
        url: unseal(prepared.endpoint.encryptedUrl, `${context}:url`),
        secret: unseal(prepared.endpoint.encryptedSecret, `${context}:secret`),
        deliveryId: claimed.id,
        body: JSON.stringify(prepared.payload),
      });
      if (statusCode < 200 || statusCode >= 300) errorCode = `http_${statusCode}`;
    } catch {
      errorCode = 'transport_failed';
    }
  await tenantTransaction(database, claimed.organizationId, async (tx) => {
    const changed = await tx.outboundDelivery.updateMany({
      where: {
        organizationId: claimed.organizationId,
        id: claimed.id,
        status: 'running',
        leaseToken: token,
      },
      data: {
        status: !errorCode
          ? 'succeeded'
          : claimed.attempts >= claimed.attemptsAllowed || errorCode === 'endpoint_disabled'
            ? 'dead'
            : 'pending',
        lastErrorCode: errorCode ?? null,
        completedAt: errorCode ? null : new Date(),
        availableAt: new Date(now.getTime() + retryDelay(claimed.attempts)),
        leaseToken: null,
        leasedUntil: null,
      },
    });
    if (!changed.count) return;
    await tx.outboundAttempt.create({
      data: {
        organizationId: claimed.organizationId,
        deliveryId: claimed.id,
        attempt: claimed.attempts,
        statusCode,
        errorCode,
      },
    });
    await audit(
      tx,
      claimed.organizationId,
      'webhook-worker',
      errorCode ? 'webhook.delivery_failed' : 'webhook.delivered',
      claimed.id,
      { attempt: claimed.attempts, statusCode, errorCode },
    );
  });
  return true;
}
