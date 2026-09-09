import type { BusinessEvent } from '../events/contracts.js';
import {
  date,
  hash,
  integer,
  json,
  keys,
  object,
  string,
  uuid,
  WorkforceError,
  type Transaction,
} from '../workforce/shared.js';
import { parseConfig, one } from './contracts.js';
import { loadCase, type CaseSnapshot } from './lifecycle.js';
import { RecoveryService } from './service.js';
import { audit } from '../workforce/audit/service.js';
import { EventPublisher } from '../events/publisher.js';

export const attributionStatuses = [
  'AI_ASSISTED',
  'AI_RECOVERED',
  'UNCERTAIN',
  'NOT_ATTRIBUTED',
] as const;
export function evidenceStatus(input: {
  deliveredAt: Date | null;
  engagedAt: Date | null;
  employeeAt: Date | null;
  outcomeAt: Date;
  windowDays: number;
  validOutcome: boolean;
}) {
  if (
    !input.validOutcome ||
    !input.deliveredAt ||
    input.outcomeAt < input.deliveredAt ||
    input.outcomeAt.getTime() - input.deliveredAt.getTime() > input.windowDays * 86400000
  )
    return 'NOT_ATTRIBUTED';
  if (!input.engagedAt || input.engagedAt < input.deliveredAt || input.engagedAt > input.outcomeAt)
    return 'UNCERTAIN';
  return 'AI_ASSISTED';
}
export async function recordOutcome(
  tx: Transaction,
  row: CaseSnapshot,
  event: BusinessEvent,
  now: Date,
) {
  const kind = event.entity.type === 'appointment' ? 'appointment' : 'opportunity',
    entityId = event.entity.id!;
  const appointment =
    kind === 'appointment'
      ? await tx.appointment.findFirst({
          where: {
            organizationId: row.organizationId,
            id: entityId,
            opportunityId: row.opportunityId,
          },
        })
      : null;
  const valid =
    kind === 'opportunity'
      ? row.opportunity.status === 'won'
      : !!appointment && appointment.status === 'scheduled';
  const config = parseConfig(row.program.runtimeVersion.specialization),
    outcomeAt = new Date(event.occurredAt);
  const status = evidenceStatus({
    deliveredAt: row.firstDeliveredAt,
    engagedAt: row.engagedAt,
    employeeAt: row.employeeActionAt,
    outcomeAt,
    windowDays: config.attributionDays,
    validOutcome: valid && outcomeAt <= now,
  });
  const prior = await tx.recoveryAttribution.findUnique({
    where: { organizationId_kind_entityId: { organizationId: row.organizationId, kind, entityId } },
  });
  if (!prior && !valid) return null;
  if (prior?.status === 'AI_RECOVERED' && valid) return prior;
  return tx.recoveryAttribution.upsert({
    where: { organizationId_kind_entityId: { organizationId: row.organizationId, kind, entityId } },
    create: {
      organizationId: row.organizationId,
      caseId: row.id,
      kind,
      entityId,
      status,
      currency: row.currency,
      occurredAt: outcomeAt,
      evidence: json({
        eventId: event.id,
        deliveredAt: row.firstDeliveredAt,
        engagedAt: row.engagedAt,
        employeeAt: row.employeeActionAt,
        rule: 'temporal_assistance_v1',
        financialClaim: false,
      }),
    },
    update: {
      status,
      amountMinor: 0,
      occurredAt: outcomeAt,
      evidence: json({
        eventId: event.id,
        valid,
        rule: 'temporal_assistance_v1',
        previousStatus: prior?.status ?? null,
        financialClaim: false,
      }),
    },
  });
}
export class RecoveryAttributionService extends RecoveryService {
  review(id: string, raw: unknown) {
    uuid(id);
    const v = object(raw);
    keys(v, ['status', 'evidence', 'amountMinor', 'currency', 'paymentReference', 'paidAt']);
    const status = one(v.status, attributionStatuses),
      evidence = string(v.evidence, 1000),
      amountMinor = integer(v.amountMinor, 0, 2147483647),
      currency = string(v.currency, 3),
      paymentReference = v.paymentReference === null ? null : string(v.paymentReference, 200),
      paidAt = v.paidAt === null ? null : date(v.paidAt);
    return this.tx(async (tx, organizationId) => {
      const attribution = await tx.recoveryAttribution.findFirst({ where: { organizationId, id } });
      if (!attribution) throw new WorkforceError(404, 'attribution_not_found');
      const row = await loadCase(tx, organizationId, attribution.caseId),
        config = parseConfig(row.program.runtimeVersion.specialization);
      const appointment =
        attribution.kind === 'appointment'
          ? await tx.appointment.findFirst({
              where: { organizationId, id: attribution.entityId, opportunityId: row.opportunityId },
            })
          : null;
      const valid =
        attribution.kind === 'opportunity'
          ? row.opportunity.status === 'won'
          : appointment?.status === 'scheduled';
      const delivered = await tx.recoveryDispatch.findFirst({
        where: {
          organizationId,
          caseId: row.id,
          status: 'delivered',
          actor: { startsWith: 'agent:' },
          deliveredAt: { lte: attribution.occurredAt },
        },
        orderBy: { deliveredAt: 'asc' },
      });
      if (status === 'AI_RECOVERED') {
        if (
          !valid ||
          !delivered ||
          !row.engagedAt ||
          !row.firstDeliveredAt ||
          row.engagedAt < row.firstDeliveredAt ||
          row.engagedAt > attribution.occurredAt ||
          attribution.occurredAt.getTime() - row.firstDeliveredAt.getTime() >
            config.attributionDays * 86400000 ||
          (row.employeeActionAt && row.employeeActionAt < row.engagedAt) ||
          currency !== row.opportunity.currency
        )
          throw new WorkforceError(409, 'recovery_attribution_evidence_insufficient');
        if (
          attribution.kind === 'opportunity' &&
          (!paymentReference ||
            !paidAt ||
            paidAt < attribution.occurredAt ||
            amountMinor <= 0 ||
            amountMinor > row.opportunity.amountMinor)
        )
          throw new WorkforceError(409, 'verified_payment_required');
        if (attribution.kind === 'appointment' && (amountMinor !== 0 || paymentReference || paidAt))
          throw new WorkforceError(400, 'appointment_not_revenue');
      } else if (amountMinor !== 0 || paymentReference || paidAt)
        throw new WorkforceError(400, 'only_recovered_payments_count_as_revenue');
      const reviewHash = hash({
        status,
        evidence,
        amountMinor,
        currency,
        paymentReference,
        paidAt,
      });
      if (
        attribution.evidence &&
        typeof attribution.evidence === 'object' &&
        !Array.isArray(attribution.evidence) &&
        attribution.evidence.reviewHash === reviewHash
      )
        return attribution;
      const updated = await tx.recoveryAttribution.update({
        where: { organizationId_id: { organizationId, id } },
        data: {
          status,
          amountMinor,
          currency,
          paymentReference,
          reviewedBy: this.principal.actor,
          reviewedAt: new Date(),
          evidence: json({
            reason: evidence,
            paidAt,
            dispatchId: delivered?.id ?? null,
            engagedAt: row.engagedAt,
            previousStatus: attribution.status,
            reviewHash,
            rule: 'human_verified_recovery_v1',
          }),
        },
      });
      await audit(tx, organizationId, this.principal.actor, 'recovery.attribution_reviewed', id, {
        status,
        amountMinor,
        currency,
        previousStatus: attribution.status,
      });
      if (status === 'AI_RECOVERED')
        await new EventPublisher().publishInTransaction(
          tx,
          {
            organizationId,
            system: 'steel_scale_agent',
            provider: 'steel_scale',
            actor: this.principal.actor,
          },
          {
            version: 2,
            type:
              attribution.kind === 'opportunity'
                ? 'opportunity.recovered'
                : 'appointment.recovered',
            entity: {
              type: attribution.kind === 'opportunity' ? 'opportunity' : 'appointment',
              id: attribution.entityId,
            },
            occurredAt: new Date().toISOString(),
            idempotencyKey: `recovery-attribution:${id}:${reviewHash}`,
            relatedRecordIds: [row.opportunityId, row.contactId],
            data: {
              changes: {
                attributionId: id,
                status,
                amountMinor,
                currency,
                method: 'human_verified',
              },
            },
          },
        );
      return updated;
    }, 'revenue:write');
  }
}
