import {
  IntelligenceOffer,
  OutreachDisposition,
  Prisma,
  ProspectRelationshipStatus,
} from '@prisma/client';

import { db } from '../db/client.js';
import { recommendOffers } from './recommendations/policy.js';

export type DashboardSort = 'score' | 'newest' | 'reviews' | 'listing_date' | 'enrichment';

export interface DashboardFilters {
  clientId?: string;
  offer?: IntelligenceOffer;
  minimumScore?: number;
  maximumScore?: number;
  scoreBand?: string;
  niche?: string;
  city?: string;
  state?: string;
  source?: string;
  minimumReviews?: number;
  operates24Hours?: boolean;
  emergency?: boolean;
  hasChatbot?: boolean;
  hasOnlineBooking?: boolean;
  maximumListingAgeHours?: number;
  minimumActiveListings?: number;
  notContacted?: boolean;
  lastContactedAfter?: Date;
  enrichmentStatus?: 'needs' | 'failed' | 'complete';
  sort?: DashboardSort;
}

export interface DashboardProspect {
  leadId: string;
  clientId: string;
  clientName: string;
  entityId: string;
  entityType: 'business' | 'agent';
  name: string;
  location: string;
  city: string | null;
  state: string | null;
  niche: string | null;
  primaryOffer: IntelligenceOffer | null;
  score: number | null;
  scoreBand: string | null;
  confidence: number;
  reasons: string[];
  keyTrigger: string;
  reviewsOrListings: number | null;
  reviewCount: number | null;
  rating: number | null;
  activeListings: number | null;
  phone: string | null;
  website: string | null;
  listingUrl: string | null;
  listingAddress: string | null;
  listingPrice: number | null;
  listingImages: string[];
  listingDate: Date | null;
  lastSeenAt: Date;
  lastEnrichedAt: Date | null;
  outreachStatus: OutreachDisposition;
  lastContactedAt: Date | null;
  sources: string[];
  needsEnrichment: boolean;
  failedEnrichment: boolean;
  signals: Map<string, { boolean: boolean | null; number: number | null; text: string | null }>;
  scoreComponents: Array<{
    rule: string;
    label: string;
    points: number;
    observedValue: Prisma.JsonValue | null;
  }>;
}

export interface DashboardMetrics {
  totalProspects: number;
  hotProspects: number;
  voiceAiOpportunities: number;
  realEstateVideoOpportunities: number;
  newProspectsToday: number;
  needsEnrichment: number;
  failedEnrichment: number;
}

function objectValue(value: Prisma.JsonValue | null): Record<string, Prisma.JsonValue> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Prisma.JsonValue>)
    : undefined;
}

function scoreBand(explanation: Prisma.JsonValue | null, score: number): string {
  const band = objectValue(explanation)?.band;
  if (typeof band === 'string') return band;
  if (score >= 90) return 'HOT';
  if (score >= 75) return 'HIGH';
  if (score >= 60) return 'MEDIUM';
  if (score >= 40) return 'LOW';
  return 'POOR';
}

function activeListingStatus(status: string | null): boolean {
  return ['ACTIVE', 'FOR_SALE', 'FOR_RENT', 'COMING_SOON', 'NEW'].includes(status ?? 'ACTIVE');
}

function includesText(value: string | null, expected: string | undefined): boolean {
  return (
    !expected ||
    value?.toLocaleLowerCase('en-US').includes(expected.toLocaleLowerCase('en-US')) === true
  );
}

export async function loadLeadIntelligenceDashboard(
  filters: DashboardFilters,
  now = new Date(),
): Promise<{ rows: DashboardProspect[]; metrics: DashboardMetrics }> {
  const leads = await db.lead.findMany({
    where: { clientId: filters.clientId },
    include: {
      client: { select: { businessName: true } },
      business: {
        include: {
          contacts: true,
          sourceRecords: { select: { provider: true, sourceUrl: true } },
          websiteAudits: { orderBy: { observedAt: 'desc' }, take: 1 },
        },
      },
      realEstateAgent: {
        include: {
          listings: {
            orderBy: [{ listedAt: 'desc' }, { lastSeenAt: 'desc' }],
            include: { providerSources: { select: { provider: true, sourceUrl: true } } },
          },
        },
      },
      signals: {
        where: { observedAt: { lte: now }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        orderBy: [{ observedAt: 'desc' }, { createdAt: 'desc' }],
      },
      scoreSnapshots: {
        orderBy: [{ calculatedAt: 'desc' }, { createdAt: 'desc' }],
        include: { factors: { include: { signal: true }, orderBy: { position: 'asc' } } },
      },
      offerSuppressions: { where: { liftedAt: null } },
      outreachState: true,
      enrichmentRuns: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });

  const allRows = leads.flatMap((lead): DashboardProspect[] => {
    if (!lead.business && !lead.realEstateAgent) return [];
    const latestScores = new Map<IntelligenceOffer, (typeof lead.scoreSnapshots)[number]>();
    for (const snapshot of lead.scoreSnapshots) {
      if (!latestScores.has(snapshot.offer)) latestScores.set(snapshot.offer, snapshot);
    }
    const candidates = [...latestScores.values()].map((snapshot) => {
      const explanation = objectValue(snapshot.explanation);
      return {
        offer: snapshot.offer,
        scoreSnapshotId: snapshot.id,
        score: snapshot.score,
        eligible: typeof explanation?.eligible === 'boolean' ? explanation.eligible : true,
        disqualifications: Array.isArray(explanation?.disqualifications)
          ? explanation.disqualifications.filter(
              (value): value is string => typeof value === 'string',
            )
          : [],
        inputAsOf: snapshot.inputAsOf,
        factors: snapshot.factors.map((factor) => ({
          rule: factor.key,
          label: factor.label,
          points: factor.points,
          observedValue: factor.observedValue ?? undefined,
          confidence: factor.signal?.confidence?.toNumber(),
          observedAt: factor.signal?.observedAt,
        })),
      };
    });
    const decision = recommendOffers(candidates, {
      businessId: lead.business?.id ?? lead.realEstateAgent!.id,
      leadId: lead.id,
      relationshipStatus: lead.business?.relationshipStatus ?? ProspectRelationshipStatus.prospect,
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
    });
    const primarySnapshot = decision.primaryOffer
      ? latestScores.get(decision.primaryOffer)
      : undefined;
    const latestSignals = new Map<string, (typeof lead.signals)[number]>();
    for (const signal of lead.signals)
      if (!latestSignals.has(signal.key)) latestSignals.set(signal.key, signal);
    const signalValue = (key: string) => {
      const signal = latestSignals.get(key);
      return {
        boolean: signal?.booleanValue ?? (typeof signal?.value === 'boolean' ? signal.value : null),
        number:
          signal?.numberValue?.toNumber() ??
          (typeof signal?.value === 'number' ? signal.value : null),
        text: signal?.textValue ?? (typeof signal?.value === 'string' ? signal.value : null),
      };
    };
    const signalMap = new Map([...latestSignals.keys()].map((key) => [key, signalValue(key)]));
    const agent = lead.realEstateAgent;
    const activeListings =
      agent?.listings.filter(({ status }) => activeListingStatus(status)) ?? [];
    const latestListing = activeListings[0] ?? agent?.listings[0];
    const business = lead.business;
    const latestAudit = business?.websiteAudits[0];
    const latestEnrichment = lead.enrichmentRuns[0];
    const lastEnrichedAt = latestAudit?.observedAt ?? latestEnrichment?.completedAt ?? null;
    const failedEnrichment =
      latestAudit?.status === 'failed' || latestEnrichment?.status === 'failed';
    const needsEnrichment = business
      ? Boolean(business.website && !business.websiteLastAuditedAt)
      : latestScores.get(IntelligenceOffer.REAL_ESTATE_VIDEO) === undefined;
    const reviewCount = signalValue('google_review_count').number;
    const activeCount =
      signalValue('active_listing_count').number ?? (agent ? activeListings.length : null);
    const sources = business
      ? [...new Set(business.sourceRecords.map(({ provider }) => provider))]
      : [
          ...new Set(
            agent!.listings.flatMap(({ providerSources }) =>
              providerSources.map(({ provider }) => provider),
            ),
          ),
        ];
    return [
      {
        leadId: lead.id,
        clientId: lead.clientId,
        clientName: lead.client.businessName,
        entityId: business?.id ?? agent!.id,
        entityType: business ? 'business' : 'agent',
        name: business?.name ?? agent!.fullName,
        location:
          [business?.city ?? latestListing?.city, business?.state ?? latestListing?.state]
            .filter(Boolean)
            .join(', ') || '—',
        city: business?.city ?? latestListing?.city ?? null,
        state: business?.state ?? latestListing?.state ?? null,
        niche: business?.niche ?? 'Real estate agent',
        primaryOffer: decision.primaryOffer,
        score: decision.score,
        scoreBand: primarySnapshot
          ? scoreBand(primarySnapshot.explanation, primarySnapshot.score)
          : null,
        confidence: decision.confidence,
        reasons: decision.reasons,
        keyTrigger:
          decision.reasons[0] ?? decision.excludedOffers[0]?.reasons[0] ?? 'Awaiting score',
        reviewsOrListings: business ? reviewCount : activeCount,
        reviewCount,
        rating: signalValue('google_rating').number,
        activeListings: activeCount,
        phone: business?.phone ?? agent?.phone ?? null,
        website: business?.website ?? agent?.website ?? null,
        listingUrl: latestListing?.listingUrl ?? null,
        listingAddress: latestListing?.address ?? null,
        listingPrice: latestListing?.price?.toNumber() ?? null,
        listingImages: latestListing?.listingImages ?? [],
        listingDate: latestListing?.listedAt ?? null,
        lastSeenAt: business?.lastSeenAt ?? agent!.lastSeenAt,
        lastEnrichedAt,
        outreachStatus: lead.outreachState?.disposition ?? OutreachDisposition.not_contacted,
        lastContactedAt: lead.outreachState?.lastContactedAt ?? null,
        sources,
        needsEnrichment,
        failedEnrichment,
        signals: signalMap,
        scoreComponents:
          primarySnapshot?.factors.map((factor) => ({
            rule: factor.key,
            label: factor.label,
            points: factor.points,
            observedValue: factor.observedValue,
          })) ?? [],
      },
    ];
  });

  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const metrics: DashboardMetrics = {
    totalProspects: allRows.length,
    hotProspects: allRows.filter(({ score }) => (score ?? 0) >= 90).length,
    voiceAiOpportunities: allRows.filter(
      ({ primaryOffer }) => primaryOffer === IntelligenceOffer.VOICE_AI,
    ).length,
    realEstateVideoOpportunities: allRows.filter(
      ({ primaryOffer }) => primaryOffer === IntelligenceOffer.REAL_ESTATE_VIDEO,
    ).length,
    newProspectsToday: allRows.filter(({ lastSeenAt }) => lastSeenAt >= startOfDay).length,
    needsEnrichment: allRows.filter(({ needsEnrichment }) => needsEnrichment).length,
    failedEnrichment: allRows.filter(({ failedEnrichment }) => failedEnrichment).length,
  };

  const rows = allRows.filter((row) => {
    if (filters.offer && row.primaryOffer !== filters.offer) return false;
    if (
      filters.minimumScore !== undefined &&
      (row.score === null || row.score < filters.minimumScore)
    )
      return false;
    if (
      filters.maximumScore !== undefined &&
      (row.score === null || row.score > filters.maximumScore)
    )
      return false;
    if (filters.scoreBand && row.scoreBand !== filters.scoreBand) return false;
    if (!includesText(row.niche, filters.niche)) return false;
    if (!includesText(row.city, filters.city)) return false;
    if (!includesText(row.state, filters.state)) return false;
    if (filters.source && !row.sources.some((source) => includesText(source, filters.source)))
      return false;
    if (filters.minimumReviews !== undefined && (row.reviewCount ?? -1) < filters.minimumReviews)
      return false;
    const booleanFilter = (key: string, expected: boolean | undefined) =>
      expected === undefined || row.signals.get(key)?.boolean === expected;
    if (
      !booleanFilter('mentions_24_7', filters.operates24Hours) &&
      !booleanFilter('is_24_hour', filters.operates24Hours)
    )
      return false;
    if (!booleanFilter('mentions_emergency', filters.emergency)) return false;
    if (!booleanFilter('has_chatbot', filters.hasChatbot)) return false;
    if (!booleanFilter('has_online_booking', filters.hasOnlineBooking)) return false;
    if (filters.maximumListingAgeHours !== undefined) {
      if (
        !row.listingDate ||
        (now.getTime() - row.listingDate.getTime()) / 3_600_000 > filters.maximumListingAgeHours
      )
        return false;
    }
    if (
      filters.minimumActiveListings !== undefined &&
      (row.activeListings ?? -1) < filters.minimumActiveListings
    )
      return false;
    if (filters.notContacted && row.outreachStatus !== OutreachDisposition.not_contacted)
      return false;
    if (
      filters.lastContactedAfter &&
      (!row.lastContactedAt || row.lastContactedAt < filters.lastContactedAfter)
    )
      return false;
    if (filters.enrichmentStatus === 'needs' && !row.needsEnrichment) return false;
    if (filters.enrichmentStatus === 'failed' && !row.failedEnrichment) return false;
    if (filters.enrichmentStatus === 'complete' && (row.needsEnrichment || row.failedEnrichment))
      return false;
    return true;
  });
  const sort = filters.sort ?? 'score';
  rows.sort((left, right) => {
    if (sort === 'newest') return right.lastSeenAt.getTime() - left.lastSeenAt.getTime();
    if (sort === 'reviews') return (right.reviewCount ?? -1) - (left.reviewCount ?? -1);
    if (sort === 'listing_date')
      return (right.listingDate?.getTime() ?? 0) - (left.listingDate?.getTime() ?? 0);
    if (sort === 'enrichment')
      return (right.lastEnrichedAt?.getTime() ?? 0) - (left.lastEnrichedAt?.getTime() ?? 0);
    return (right.score ?? -1) - (left.score ?? -1) || right.confidence - left.confidence;
  });
  return { rows, metrics };
}

export async function loadLeadIntelligenceDetail(leadId: string, now = new Date()) {
  const dashboard = await loadLeadIntelligenceDashboard({}, now);
  return dashboard.rows.find((row) => row.leadId === leadId) ?? null;
}
