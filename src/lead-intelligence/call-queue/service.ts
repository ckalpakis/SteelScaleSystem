import { IntelligenceOffer, OutreachDisposition, ProspectCallStatus } from '@prisma/client';

import { db } from '../../db/client.js';

const TERMINAL = new Set<ProspectCallStatus>([
  ProspectCallStatus.demo_booked,
  ProspectCallStatus.not_interested,
  ProspectCallStatus.bad_fit,
  ProspectCallStatus.do_not_contact,
]);

export interface RankedCall {
  queueEntryId: string;
  leadId: string;
  business: string;
  offer: IntelligenceOffer;
  score: number;
  scoreBand: string;
  phone: string;
  website: string | null;
  niche: string | null;
  reasons: string[];
  angle: string;
  status: ProspectCallStatus;
  attemptCount: number;
  lastAttemptAt: Date | null;
  nextFollowUpAt: Date | null;
  manualPriority: number;
  rankScore: number;
  signalFreshness: Date | null;
  opportunityDate: Date;
  latestNote: string | null;
}

function band(score: number): string {
  if (score >= 90) return 'HOT';
  if (score >= 75) return 'HIGH';
  if (score >= 60) return 'MEDIUM';
  if (score >= 40) return 'LOW';
  return 'POOR';
}

function ageBonus(date: Date | null, now: Date, maximum: number): number {
  if (!date) return 0;
  const ageDays = Math.max(0, (now.getTime() - date.getTime()) / 86_400_000);
  return Math.max(0, maximum - Math.floor(ageDays));
}

function pitchAngle(offer: IntelligenceOffer, signalKeys: Set<string>): string {
  if (offer === IntelligenceOffer.REAL_ESTATE_VIDEO) return 'New-listing video launch';
  if (signalKeys.has('mentions_emergency') || signalKeys.has('mentions_24_7')) {
    return 'After-hours lead capture';
  }
  if (signalKeys.has('has_online_booking') || signalKeys.has('has_chatbot')) {
    return 'Front-desk overflow coverage';
  }
  return 'Missed-call lead capture';
}

export async function getRankedCallQueue(
  input: {
    clientId?: string;
    limit?: number;
    now?: Date;
  } = {},
): Promise<RankedCall[]> {
  const now = input.now ?? new Date();
  const entries = await db.callQueueEntry.findMany({
    where: {
      clientId: input.clientId,
      status: { notIn: [...TERMINAL] },
      OR: [{ cooldownUntil: null }, { cooldownUntil: { lte: now } }],
      lead: {
        outreachState: { isNot: { contactable: false } },
        contactPermission: { isNot: { doNotContact: true } },
      },
    },
    include: {
      campaign: true,
      attempts: { orderBy: { occurredAt: 'desc' } },
      lead: {
        include: {
          business: true,
          realEstateAgent: {
            include: {
              listings: { orderBy: [{ listedAt: 'desc' }, { lastSeenAt: 'desc' }], take: 1 },
            },
          },
          signals: { orderBy: [{ observedAt: 'desc' }, { createdAt: 'desc' }] },
          scoreSnapshots: {
            orderBy: [{ calculatedAt: 'desc' }, { createdAt: 'desc' }],
            include: { factors: { orderBy: { position: 'asc' } } },
          },
        },
      },
    },
  });
  const rows = entries.flatMap((entry): RankedCall[] => {
    const lead = entry.lead;
    const score = lead.scoreSnapshots.find(({ offer }) => offer === entry.campaign.offer);
    const phone = lead.business?.phone ?? lead.realEstateAgent?.phone;
    if (!score || !phone) return [];
    const latestSignals = new Map<string, (typeof lead.signals)[number]>();
    for (const signal of lead.signals)
      if (!latestSignals.has(signal.key)) latestSignals.set(signal.key, signal);
    const reasons = score.factors
      .filter(({ points }) => points > 0)
      .sort((left, right) => right.points - left.points)
      .slice(0, 5)
      .map(({ label }) => label);
    const listing = lead.realEstateAgent?.listings[0];
    const opportunityDate = listing?.listedAt ?? lead.lastSeenAt;
    const signalFreshness = latestSignals.values().next().value?.observedAt ?? null;
    const freshnessBonus = ageBonus(signalFreshness, now, 10);
    const recencyBonus = ageBonus(opportunityDate, now, 10);
    const attemptPenalty = Math.min(20, entry.attempts.length * 3);
    const followUpBonus = entry.nextFollowUpAt && entry.nextFollowUpAt <= now ? 8 : 0;
    return [
      {
        queueEntryId: entry.id,
        leadId: lead.id,
        business: lead.business?.name ?? lead.realEstateAgent?.fullName ?? 'Unknown prospect',
        offer: entry.campaign.offer,
        score: score.score,
        scoreBand: band(score.score),
        phone,
        website: lead.business?.website ?? lead.realEstateAgent?.website ?? null,
        niche: lead.business?.niche ?? (lead.realEstateAgent ? 'Real estate agent' : null),
        reasons: reasons.length
          ? reasons
          : [`${score.score}-point ${entry.campaign.offer.replaceAll('_', ' ')} opportunity`],
        angle: pitchAngle(
          entry.campaign.offer,
          new Set(
            [...latestSignals.values()]
              .filter(({ booleanValue }) => booleanValue === true)
              .map(({ key }) => key),
          ),
        ),
        status: entry.status,
        attemptCount: entry.attempts.length,
        lastAttemptAt: entry.attempts[0]?.occurredAt ?? null,
        nextFollowUpAt: entry.nextFollowUpAt,
        manualPriority: entry.manualPriority,
        rankScore:
          score.score +
          freshnessBonus +
          recencyBonus +
          entry.manualPriority +
          followUpBonus -
          attemptPenalty,
        signalFreshness,
        opportunityDate,
        latestNote: entry.latestNote,
      },
    ];
  });
  return rows
    .sort((left, right) => right.rankScore - left.rankScore || right.score - left.score)
    .slice(0, input.limit ?? 100);
}

function defaultCooldown(status: ProspectCallStatus, occurredAt: Date): Date | null {
  const days =
    status === ProspectCallStatus.no_answer ? 2 : status === ProspectCallStatus.gatekeeper ? 1 : 0;
  return days ? new Date(occurredAt.getTime() + days * 86_400_000) : null;
}

export async function recordCallAttempt(input: {
  queueEntryId: string;
  status: ProspectCallStatus;
  notes?: string;
  nextFollowUpAt?: Date;
  occurredAt?: Date;
}) {
  const occurredAt = input.occurredAt ?? new Date();
  const entry = await db.callQueueEntry.findUniqueOrThrow({
    where: { id: input.queueEntryId },
    include: {
      campaign: true,
      lead: {
        include: {
          business: true,
          scoreSnapshots: { orderBy: { calculatedAt: 'desc' } },
          signals: true,
        },
      },
    },
  });
  const score = entry.lead.scoreSnapshots.find(({ offer }) => offer === entry.campaign.offer);
  const angle = pitchAngle(
    entry.campaign.offer,
    new Set(
      entry.lead.signals.filter(({ booleanValue }) => booleanValue === true).map(({ key }) => key),
    ),
  );
  const nextFollowUpAt = input.nextFollowUpAt;
  if (input.status === ProspectCallStatus.follow_up && !nextFollowUpAt)
    throw new Error('Follow-up date is required for follow-up status');
  const disposition =
    input.status === ProspectCallStatus.demo_booked
      ? OutreachDisposition.qualified
      : input.status === ProspectCallStatus.interested
        ? OutreachDisposition.replied
        : input.status === ProspectCallStatus.do_not_contact
          ? OutreachDisposition.do_not_contact
          : OutreachDisposition.contacted;
  return db.$transaction(async (transaction) => {
    const attempt = await transaction.callAttempt.create({
      data: {
        clientId: entry.clientId,
        leadId: entry.leadId,
        queueEntryId: entry.id,
        status: input.status,
        pitchAngle: angle,
        scoreAtAttempt: score?.score,
        scoreBand: score ? band(score.score) : null,
        niche: entry.lead.business?.niche,
        notes: input.notes?.trim() || null,
        nextFollowUpAt,
        occurredAt,
      },
    });
    await transaction.callQueueEntry.update({
      where: { id: entry.id },
      data: {
        status: input.status,
        latestNote: input.notes?.trim() || null,
        nextFollowUpAt,
        cooldownUntil: nextFollowUpAt ?? defaultCooldown(input.status, occurredAt),
      },
    });
    await transaction.leadOutreachState.upsert({
      where: { leadId: entry.leadId },
      create: {
        leadId: entry.leadId,
        disposition,
        contactable: input.status !== ProspectCallStatus.do_not_contact,
        lastContactedAt: occurredAt,
        contactAttemptCount: 1,
        lastChannel: 'phone',
        lastOutcome: input.status,
      },
      update: {
        disposition,
        contactable: input.status !== ProspectCallStatus.do_not_contact,
        doNotContactReason:
          input.status === ProspectCallStatus.do_not_contact
            ? 'Recorded during prospecting call'
            : undefined,
        lastContactedAt: occurredAt,
        contactAttemptCount: { increment: 1 },
        lastChannel: 'phone',
        lastOutcome: input.status,
      },
    });
    if (input.status === ProspectCallStatus.do_not_contact)
      await transaction.leadContactPermission.upsert({
        where: { leadId: entry.leadId },
        create: {
          leadId: entry.leadId,
          doNotContact: true,
          contactableProspect: false,
          smsEligible: false,
        },
        update: { doNotContact: true, contactableProspect: false, smsEligible: false },
      });
    return attempt;
  });
}

export async function setCallQueuePriority(queueEntryId: string, manualPriority: number) {
  if (!Number.isInteger(manualPriority) || manualPriority < -25 || manualPriority > 25)
    throw new Error('Manual priority must be an integer from -25 to 25');
  return db.callQueueEntry.update({ where: { id: queueEntryId }, data: { manualPriority } });
}
