import { IntelligenceOffer, type OutreachDisposition, Prisma } from '@prisma/client';

import { db } from '../../db/client.js';
import { normalizeLocationPart, normalizeProvider } from '../ingestion/normalization.js';
import { recommendOffers } from './policy.js';

export interface TopVoiceAiProspectFilters {
  clientId: string;
  state?: string;
  city?: string;
  niche?: string;
  minimumScore?: number;
  maximumScore?: number;
  minimumReviewCount?: number;
  maximumReviewCount?: number;
  minimumRating?: number;
  maximumRating?: number;
  websiteStatus?: 'exists' | 'missing' | 'reachable' | 'unreachable';
  chatbotStatus?: boolean;
  bookingStatus?: boolean;
  operates24Hours?: boolean;
  emergencyService?: boolean;
  source?: string;
  lastEnrichedAfter?: Date;
  lastEnrichedBefore?: Date;
  lastContactedAfter?: Date;
  lastContactedBefore?: Date;
  contactStatus?: OutreachDisposition;
  limit?: number;
  now?: Date;
}

export interface TopVoiceAiProspect {
  businessId: string;
  leadId: string;
  businessName: string;
  city: string | null;
  state: string | null;
  niche: string | null;
  score: number;
  confidence: number;
  reasons: string[];
  reviewCount: number | null;
  rating: number | null;
  website: string | null;
  websiteReachable: boolean | null;
  hasChatbot: boolean | null;
  hasOnlineBooking: boolean | null;
  operates24Hours: boolean | null;
  emergencyService: boolean | null;
  sources: string[];
  lastEnrichedAt: Date | null;
  lastContactedAt: Date | null;
  contactStatus: OutreachDisposition | 'not_contacted';
}

function objectValue(value: Prisma.JsonValue | null): Record<string, Prisma.JsonValue> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Prisma.JsonValue>)
    : undefined;
}

function latestSignalMap<T extends { key: string }>(signals: T[]): Map<string, T> {
  const latest = new Map<string, T>();
  for (const signal of signals) if (!latest.has(signal.key)) latest.set(signal.key, signal);
  return latest;
}

function booleanValue(
  signals: Map<string, { value: Prisma.JsonValue; booleanValue: boolean | null }>,
  key: string,
): boolean | null {
  const signal = signals.get(key);
  if (!signal) return null;
  if (signal.booleanValue !== null) return signal.booleanValue;
  return typeof signal.value === 'boolean' ? signal.value : null;
}

function numberValue(
  signals: Map<string, { value: Prisma.JsonValue; numberValue: Prisma.Decimal | null }>,
  key: string,
): number | null {
  const signal = signals.get(key);
  if (!signal) return null;
  if (signal.numberValue !== null) return signal.numberValue.toNumber();
  return typeof signal.value === 'number' ? signal.value : null;
}

function between(value: number | null, minimum?: number, maximum?: number): boolean {
  if (minimum !== undefined && (value === null || value < minimum)) return false;
  if (maximum !== undefined && (value === null || value > maximum)) return false;
  return true;
}

export async function getTopVoiceAiProspects(
  filters: TopVoiceAiProspectFilters,
): Promise<TopVoiceAiProspect[]> {
  const limit = filters.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('limit must be an integer from 1-100');
  }
  const now = filters.now ?? new Date();
  const businesses = await db.prospectBusiness.findMany({
    where: {
      clientId: filters.clientId,
      normalizedState: normalizeLocationPart(filters.state),
      normalizedCity: normalizeLocationPart(filters.city),
      niche: filters.niche ? { contains: filters.niche, mode: 'insensitive' } : undefined,
      website:
        filters.websiteStatus === 'exists'
          ? { not: null }
          : filters.websiteStatus === 'missing'
            ? null
            : undefined,
      websiteLastAuditedAt: {
        gte: filters.lastEnrichedAfter,
        lte: filters.lastEnrichedBefore,
      },
      sourceRecords: filters.source
        ? { some: { provider: normalizeProvider(filters.source) } }
        : undefined,
      leads: { some: {} },
    },
    include: {
      sourceRecords: { select: { provider: true } },
      leads: {
        take: 1,
        include: {
          outreachState: true,
          offerSuppressions: { where: { liftedAt: null } },
          signals: {
            where: {
              observedAt: { lte: now },
              OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            },
            orderBy: [{ observedAt: 'desc' }, { createdAt: 'desc' }],
          },
          scoreSnapshots: {
            where: { offer: IntelligenceOffer.VOICE_AI },
            orderBy: [{ calculatedAt: 'desc' }, { createdAt: 'desc' }],
            take: 1,
            include: { factors: { include: { signal: true }, orderBy: { position: 'asc' } } },
          },
        },
      },
    },
  });

  const prospects = businesses.flatMap((business): TopVoiceAiProspect[] => {
    const lead = business.leads[0];
    const snapshot = lead?.scoreSnapshots[0];
    if (!lead || !snapshot) return [];
    const explanation = objectValue(snapshot.explanation);
    const eligible = typeof explanation?.eligible === 'boolean' ? explanation.eligible : true;
    const disqualifications = Array.isArray(explanation?.disqualifications)
      ? explanation.disqualifications.filter((value): value is string => typeof value === 'string')
      : [];
    const decision = recommendOffers(
      [
        {
          offer: snapshot.offer,
          scoreSnapshotId: snapshot.id,
          score: snapshot.score,
          eligible,
          disqualifications,
          inputAsOf: snapshot.inputAsOf,
          factors: snapshot.factors.map((factor) => ({
            rule: factor.key,
            label: factor.label,
            points: factor.points,
            observedValue: factor.observedValue ?? undefined,
            confidence: factor.signal?.confidence?.toNumber(),
            observedAt: factor.signal?.observedAt,
          })),
        },
      ],
      {
        businessId: business.id,
        leadId: lead.id,
        relationshipStatus: business.relationshipStatus,
        outreach: lead.outreachState
          ? {
              disposition: lead.outreachState.disposition,
              contactable: lead.outreachState.contactable,
              lastContactedAt: lead.outreachState.lastContactedAt,
              contactAttemptCount: lead.outreachState.contactAttemptCount,
            }
          : undefined,
        suppressedOffers: lead.offerSuppressions.map(({ offer, reason }) => ({ offer, reason })),
        now,
      },
    );
    if (decision.primaryOffer !== IntelligenceOffer.VOICE_AI) return [];
    const signals = latestSignalMap(lead.signals);
    const reviewCount = numberValue(signals, 'google_review_count');
    const rating = numberValue(signals, 'google_rating');
    const websiteReachable = booleanValue(signals, 'website_reachable');
    const hasChatbot = booleanValue(signals, 'has_chatbot');
    const hasOnlineBooking = booleanValue(signals, 'has_online_booking');
    const explicit24Hours = booleanValue(signals, 'is_24_hour');
    const mentions24Hours = booleanValue(signals, 'mentions_24_7');
    const operates24Hours = [explicit24Hours, mentions24Hours].includes(true)
      ? true
      : [explicit24Hours, mentions24Hours].includes(false)
        ? false
        : null;
    const emergencyService = booleanValue(signals, 'mentions_emergency');
    const lastContactedAt = lead.outreachState?.lastContactedAt ?? null;
    const contactStatus = lead.outreachState?.disposition ?? 'not_contacted';
    if (!between(snapshot.score, filters.minimumScore, filters.maximumScore)) return [];
    if (!between(reviewCount, filters.minimumReviewCount, filters.maximumReviewCount)) return [];
    if (!between(rating, filters.minimumRating, filters.maximumRating)) return [];
    if (filters.websiteStatus === 'reachable' && websiteReachable !== true) return [];
    if (filters.websiteStatus === 'unreachable' && websiteReachable !== false) return [];
    if (filters.chatbotStatus !== undefined && hasChatbot !== filters.chatbotStatus) return [];
    if (filters.bookingStatus !== undefined && hasOnlineBooking !== filters.bookingStatus)
      return [];
    if (filters.operates24Hours !== undefined && operates24Hours !== filters.operates24Hours)
      return [];
    if (filters.emergencyService !== undefined && emergencyService !== filters.emergencyService)
      return [];
    if (
      filters.lastContactedAfter &&
      (!lastContactedAt || lastContactedAt < filters.lastContactedAfter)
    )
      return [];
    if (
      filters.lastContactedBefore &&
      (!lastContactedAt || lastContactedAt > filters.lastContactedBefore)
    )
      return [];
    if (filters.contactStatus && contactStatus !== filters.contactStatus) return [];
    return [
      {
        businessId: business.id,
        leadId: lead.id,
        businessName: business.name,
        city: business.city,
        state: business.state,
        niche: business.niche,
        score: snapshot.score,
        confidence: decision.confidence,
        reasons: decision.reasons,
        reviewCount,
        rating,
        website: business.website,
        websiteReachable,
        hasChatbot,
        hasOnlineBooking,
        operates24Hours,
        emergencyService,
        sources: [...new Set(business.sourceRecords.map(({ provider }) => provider))],
        lastEnrichedAt: business.websiteLastAuditedAt,
        lastContactedAt,
        contactStatus,
      },
    ];
  });
  return prospects
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.confidence - left.confidence ||
        (right.reviewCount ?? -1) - (left.reviewCount ?? -1) ||
        left.businessName.localeCompare(right.businessName),
    )
    .slice(0, limit);
}
