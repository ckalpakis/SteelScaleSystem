import {
  DeliveryDestination,
  DeliveryStatus,
  OutreachDisposition,
  Prisma,
  ProspectRelationshipStatus,
} from '@prisma/client';

import { db } from '../../db/client.js';
import { mapConcurrent } from '../pipeline/retry.js';
import {
  CallQueueDeliveryTarget,
  CsvLeadDeliveryTarget,
  GhlLeadDeliveryTarget,
  ZapierLeadDeliveryTarget,
} from './targets.js';
import type {
  CampaignDeliveryResult,
  DeliveryCriteria,
  DeliveryTarget,
  QualifiedLeadPayload,
} from './types.js';

export const QUALIFIED_LEAD_PAYLOAD_VERSION = 'qualified-lead-v1';

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function object(value: Prisma.JsonValue | null): Record<string, Prisma.JsonValue> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Prisma.JsonValue>)
    : undefined;
}

function criteriaFrom(value: Prisma.JsonValue): DeliveryCriteria {
  const data = object(value);
  const criteria: DeliveryCriteria = {
    minimumScore: typeof data?.minimumScore === 'number' ? data.minimumScore : 75,
    requirePhone: data?.requirePhone === true,
    requireApprovedContactChannel: data?.requireApprovedContactChannel === true,
    maximumListingAgeDays:
      typeof data?.maximumListingAgeDays === 'number' ? data.maximumListingAgeDays : undefined,
    notContactedWithinDays:
      typeof data?.notContactedWithinDays === 'number' ? data.notContactedWithinDays : undefined,
  };
  if (criteria.minimumScore < 0 || criteria.minimumScore > 100) {
    throw new Error('minimumScore must be from 0-100');
  }
  return criteria;
}

export async function createDeliveryCampaign(input: {
  clientId: string;
  campaignKey: string;
  name: string;
  offer: Parameters<typeof db.deliveryCampaign.create>[0]['data']['offer'];
  destination: DeliveryDestination;
  criteria: DeliveryCriteria;
  destinationConfig?: Record<string, unknown>;
}) {
  criteriaFrom(JSON.parse(JSON.stringify(input.criteria)) as Prisma.JsonValue);
  return db.deliveryCampaign.create({
    data: {
      clientId: input.clientId,
      campaignKey: input.campaignKey,
      name: input.name,
      offer: input.offer,
      destination: input.destination,
      criteria: json(input.criteria),
      destinationConfig: input.destinationConfig ? json(input.destinationConfig) : undefined,
      payloadVersion: QUALIFIED_LEAD_PAYLOAD_VERSION,
    },
  });
}

async function qualifiedPayloads(campaignId: string, now: Date): Promise<QualifiedLeadPayload[]> {
  const campaign = await db.deliveryCampaign.findUniqueOrThrow({ where: { id: campaignId } });
  if (!campaign.enabled) return [];
  const criteria = criteriaFrom(campaign.criteria);
  const leads = await db.lead.findMany({
    where: {
      clientId: campaign.clientId,
      offerSuppressions: { none: { offer: campaign.offer, liftedAt: null } },
      deliveryRecords: { none: { campaignId } },
    },
    include: {
      business: true,
      realEstateAgent: {
        include: { listings: { orderBy: [{ listedAt: 'desc' }, { lastSeenAt: 'desc' }] } },
      },
      outreachState: true,
      contactPermission: true,
      scoreSnapshots: {
        where: { offer: campaign.offer },
        orderBy: [{ calculatedAt: 'desc' }, { createdAt: 'desc' }],
        take: 1,
      },
    },
  });
  return leads.flatMap((lead): QualifiedLeadPayload[] => {
    const score = lead.scoreSnapshots[0];
    if (!score || score.score < criteria.minimumScore) return [];
    const relationship = lead.business?.relationshipStatus ?? ProspectRelationshipStatus.prospect;
    if (relationship !== ProspectRelationshipStatus.prospect) return [];
    if (
      lead.outreachState &&
      (!lead.outreachState.contactable ||
        new Set<OutreachDisposition>([
          OutreachDisposition.do_not_contact,
          OutreachDisposition.invalid,
          OutreachDisposition.converted,
        ]).has(lead.outreachState.disposition))
    )
      return [];
    const permission = lead.contactPermission;
    if (
      permission?.doNotContact ||
      permission?.suppressed ||
      permission?.contactableProspect === false
    )
      return [];
    if (criteria.notContactedWithinDays && lead.outreachState?.lastContactedAt) {
      const cutoff = new Date(now.getTime() - criteria.notContactedWithinDays * 86_400_000);
      if (lead.outreachState.lastContactedAt >= cutoff) return [];
    }
    const agent = lead.realEstateAgent;
    const listing = agent?.listings.find(({ status }) =>
      ['ACTIVE', 'FOR_SALE', 'FOR_RENT', 'COMING_SOON', 'NEW'].includes(status ?? 'ACTIVE'),
    );
    if (criteria.maximumListingAgeDays !== undefined) {
      if (!listing?.listedAt) return [];
      if (now.getTime() - listing.listedAt.getTime() > criteria.maximumListingAgeDays * 86_400_000)
        return [];
    }
    const phone = lead.business?.phone ?? agent?.phone ?? null;
    const email = agent?.email ?? null;
    if (criteria.requirePhone && !phone) return [];
    if (criteria.requireApprovedContactChannel && !phone && !email) return [];
    return [
      {
        payloadVersion: campaign.payloadVersion,
        campaignId: campaign.id,
        campaignKey: campaign.campaignKey,
        leadId: lead.id,
        clientId: lead.clientId,
        offer: campaign.offer,
        score: score.score,
        name: lead.business?.name ?? agent?.fullName ?? 'Unknown prospect',
        phone,
        email,
        website: lead.business?.website ?? agent?.website ?? null,
        location: {
          city: lead.business?.city ?? listing?.city ?? null,
          state: lead.business?.state ?? listing?.state ?? null,
        },
        niche: lead.business?.niche ?? (agent ? 'Real estate agent' : null),
        listing: listing
          ? {
              address: listing.address,
              url: listing.listingUrl,
              price: listing.price?.toNumber() ?? null,
              listedAt: listing.listedAt?.toISOString() ?? null,
            }
          : null,
        compliance: {
          contactableProspect: permission?.contactableProspect ?? true,
          manualCallCandidate: permission?.manualCallCandidate ?? false,
          smsConsent: permission?.smsConsent ?? 'unknown',
          smsEligible: permission?.smsEligible ?? false,
          doNotContact: permission?.doNotContact ?? false,
          suppressed: permission?.suppressed ?? false,
        },
      },
    ];
  });
}

function csvCell(value: string | number | boolean | null | undefined): string {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function payloadsToCsv(payloads: QualifiedLeadPayload[]): string {
  return [
    [
      'lead_id',
      'campaign_id',
      'offer',
      'score',
      'name',
      'phone',
      'email',
      'website',
      'city',
      'state',
      'niche',
      'listing_address',
      'listing_url',
      'listed_at',
      'sms_eligible',
    ],
    ...payloads.map((payload) => [
      payload.leadId,
      payload.campaignId,
      payload.offer,
      payload.score,
      payload.name,
      payload.phone,
      payload.email,
      payload.website,
      payload.location.city,
      payload.location.state,
      payload.niche,
      payload.listing?.address,
      payload.listing?.url,
      payload.listing?.listedAt,
      payload.compliance.smsEligible,
    ]),
  ]
    .map((row) => row.map(csvCell).join(','))
    .join('\n');
}

async function claimAndDeliver(
  campaign: Awaited<ReturnType<typeof db.deliveryCampaign.findUniqueOrThrow>>,
  payload: QualifiedLeadPayload,
  target: DeliveryTarget,
) {
  let record;
  try {
    record = await db.deliveryRecord.create({
      data: {
        clientId: payload.clientId,
        leadId: payload.leadId,
        campaignId: campaign.id,
        destination: campaign.destination,
        status: DeliveryStatus.processing,
        payloadVersion: campaign.payloadVersion,
        payload: json(payload),
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return { duplicate: true as const };
    }
    throw error;
  }
  try {
    const result = await target.deliver(payload, record.id);
    await db.deliveryRecord.update({
      where: { id: record.id },
      data: {
        status: DeliveryStatus.delivered,
        externalId: result.externalId,
        deliveredAt: new Date(),
        error: null,
      },
    });
    if (campaign.destination === DeliveryDestination.CALL_QUEUE) {
      await db.$transaction([
        db.leadContactPermission.upsert({
          where: { leadId: payload.leadId },
          create: { leadId: payload.leadId, manualCallCandidate: true },
          update: { manualCallCandidate: true },
        }),
        db.callQueueEntry.upsert({
          where: { deliveryRecordId: record.id },
          create: {
            clientId: payload.clientId,
            leadId: payload.leadId,
            campaignId: campaign.id,
            deliveryRecordId: record.id,
          },
          update: {},
        }),
      ]);
    }
    return { duplicate: false as const, delivered: true as const };
  } catch (error) {
    const errorText = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
    await db.deliveryRecord.update({
      where: { id: record.id },
      data: { status: DeliveryStatus.failed, error: errorText },
    });
    return { duplicate: false as const, delivered: false as const, error: errorText };
  }
}

export async function deliverQualifiedLeads(input: {
  campaignId: string;
  target?: DeliveryTarget;
  concurrency?: number;
  now?: Date;
}): Promise<CampaignDeliveryResult> {
  const campaign = await db.deliveryCampaign.findUniqueOrThrow({ where: { id: input.campaignId } });
  const payloads = await qualifiedPayloads(campaign.id, input.now ?? new Date());
  const config = object(campaign.destinationConfig);
  const target =
    input.target ??
    (campaign.destination === DeliveryDestination.GHL
      ? new GhlLeadDeliveryTarget()
      : campaign.destination === DeliveryDestination.ZAPIER_WEBHOOK
        ? new ZapierLeadDeliveryTarget(
            typeof config?.webhookUrl === 'string' ? config.webhookUrl : '',
          )
        : campaign.destination === DeliveryDestination.CSV_EXPORT
          ? new CsvLeadDeliveryTarget()
          : new CallQueueDeliveryTarget());
  if (target.destination !== campaign.destination) {
    throw new Error('Delivery target does not match campaign destination');
  }
  const results = await mapConcurrent(payloads, input.concurrency ?? 5, (payload) =>
    claimAndDeliver(campaign, payload, target),
  );
  const errors: Array<{ leadId: string; error: string }> = [];
  let delivered = 0;
  let failed = 0;
  let duplicatesPrevented = 0;
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      failed += 1;
      errors.push({
        leadId: payloads[index]!.leadId,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    } else if (result.value.duplicate) duplicatesPrevented += 1;
    else if (result.value.delivered) delivered += 1;
    else {
      failed += 1;
      errors.push({ leadId: payloads[index]!.leadId, error: result.value.error });
    }
  });
  return {
    campaignId: campaign.id,
    eligible: payloads.length,
    delivered,
    failed,
    duplicatesPrevented,
    ...(campaign.destination === DeliveryDestination.CSV_EXPORT
      ? { csv: payloadsToCsv(payloads) }
      : {}),
    errors,
  };
}

export async function retryFailedDelivery(
  deliveryRecordId: string,
  target: DeliveryTarget,
): Promise<{ delivered: boolean; externalId?: string; error?: string }> {
  const record = await db.deliveryRecord.findUniqueOrThrow({ where: { id: deliveryRecordId } });
  if (record.status !== DeliveryStatus.failed)
    throw new Error('Only failed deliveries can be retried');
  if (record.destination !== target.destination)
    throw new Error('Delivery target does not match record destination');
  const payload = record.payload as unknown as QualifiedLeadPayload;
  await db.deliveryRecord.update({
    where: { id: record.id },
    data: { status: DeliveryStatus.processing, retryCount: { increment: 1 }, error: null },
  });
  try {
    const result = await target.deliver(payload, record.id);
    await db.deliveryRecord.update({
      where: { id: record.id },
      data: {
        status: DeliveryStatus.delivered,
        externalId: result.externalId,
        deliveredAt: new Date(),
      },
    });
    return { delivered: true, externalId: result.externalId };
  } catch (error) {
    const errorText = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
    await db.deliveryRecord.update({
      where: { id: record.id },
      data: { status: DeliveryStatus.failed, error: errorText },
    });
    return { delivered: false, error: errorText };
  }
}
