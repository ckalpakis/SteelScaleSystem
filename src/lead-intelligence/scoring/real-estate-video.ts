import { createHash } from 'node:crypto';

import { IntelligenceOffer, type Prisma } from '@prisma/client';

import type { ScoreCalculation, ScoreComponent, ScoringSignal } from './types.js';
import { scoreBand } from './voice-ai.js';

export const REAL_ESTATE_VIDEO_SCORING_VERSION = 'real-estate-video-v1';

export const REAL_ESTATE_VIDEO_WEIGHTS = {
  listingAge: [
    { maximumHours: 24, points: 30 },
    { maximumHours: 72, points: 25 },
    { maximumHours: 168, points: 15 },
  ],
  activeListings: [
    { minimum: 4, points: 20 },
    { minimum: 2, points: 10 },
    { minimum: 1, points: 5 },
  ],
  listingValue: [
    { minimum: 1_000_000, points: 20 },
    { minimum: 750_000, points: 15 },
    { minimum: 400_000, points: 10 },
    { minimum: 250_000, points: 5 },
  ],
  instagram: 10,
  tiktok: 10,
  facebook: 5,
  headshot: 10,
  agentWebsite: 5,
  multipleActiveListings: 5,
  establishedBrokerage: 5,
} as const;

export const ESTABLISHED_BROKERAGES = [
  're/max',
  'keller williams',
  'coldwell banker',
  'compass',
  'century 21',
  'berkshire hathaway',
  'sotheby',
] as const;

export interface RealEstateVideoScoringInput {
  agent: {
    id?: string;
    fullName: string;
    updatedAt?: Date;
  };
  latestListing?: {
    id?: string;
    address?: string | null;
    propertyUrl?: string | null;
    listedAt?: Date | null;
    updatedAt?: Date;
  };
  signals: ScoringSignal[];
  calculatedAt?: Date;
}

function latestSignals(signals: ScoringSignal[]): Map<string, ScoringSignal> {
  const latest = new Map<string, ScoringSignal>();
  for (const signal of signals) {
    const existing = latest.get(signal.key);
    if (!existing || signal.observedAt > existing.observedAt) latest.set(signal.key, signal);
  }
  return latest;
}

function numberValue(signal: ScoringSignal | undefined): number | undefined {
  if (typeof signal?.numberValue === 'number') return signal.numberValue;
  return typeof signal?.value === 'number' ? signal.value : undefined;
}

function booleanValue(signal: ScoringSignal | undefined): boolean | undefined {
  if (typeof signal?.booleanValue === 'boolean') return signal.booleanValue;
  return typeof signal?.value === 'boolean' ? signal.value : undefined;
}

function textValue(signal: ScoringSignal | undefined): string | undefined {
  if (typeof signal?.textValue === 'string') return signal.textValue;
  return typeof signal?.value === 'string' ? signal.value : undefined;
}

function dateValue(signal: ScoringSignal | undefined): Date | undefined {
  if (typeof signal?.value !== 'string') return undefined;
  const parsed = new Date(signal.value);
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed;
}

function fingerprint(
  input: RealEstateVideoScoringInput,
  signals: Map<string, ScoringSignal>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        agent: input.agent,
        latestListing: input.latestListing,
        signals: [...signals.values()]
          .sort((left, right) => left.key.localeCompare(right.key))
          .map(({ id, key, value, observedAt }) => ({ id, key, value, observedAt })),
      }),
    )
    .digest('hex');
}

export function calculateRealEstateVideoScore(
  input: RealEstateVideoScoringInput,
): ScoreCalculation {
  const calculatedAt = input.calculatedAt ?? new Date();
  const signals = latestSignals(input.signals);
  const components: ScoreComponent[] = [];
  const add = (
    rule: string,
    label: string,
    points: number,
    signal: ScoringSignal | undefined,
    observedValue: Prisma.InputJsonValue,
  ): void => {
    components.push({
      rule,
      label,
      points,
      signalId: signal?.id,
      observedValue,
      evidence: signal
        ? {
            signalId: signal.id ?? null,
            signalKey: signal.key,
            provider: signal.provider,
            confidence: signal.confidence ?? null,
            observedAt: signal.observedAt.toISOString(),
          }
        : { source: 'canonical_listing' },
    });
  };

  const latestDateSignal = signals.get('latest_listing_date');
  const listedAt = input.latestListing?.listedAt ?? dateValue(latestDateSignal);
  if (listedAt) {
    const ageHours = Math.max(0, (calculatedAt.getTime() - listedAt.getTime()) / 3_600_000);
    const tier = REAL_ESTATE_VIDEO_WEIGHTS.listingAge.find(
      ({ maximumHours }) => ageHours < maximumHours,
    );
    if (tier)
      add(
        'LISTING_AGE',
        'Recently listed property',
        tier.points,
        latestDateSignal,
        Number(ageHours.toFixed(1)),
      );
  }

  const countSignal = signals.get('active_listing_count');
  const activeCount = numberValue(countSignal) ?? 0;
  const countTier = REAL_ESTATE_VIDEO_WEIGHTS.activeListings.find(
    ({ minimum }) => activeCount >= minimum,
  );
  if (countTier)
    add('ACTIVE_LISTINGS', 'Active listing portfolio', countTier.points, countSignal, activeCount);
  if (activeCount >= 2) {
    add(
      'MULTIPLE_ACTIVE_LISTINGS',
      'Multiple active listings',
      REAL_ESTATE_VIDEO_WEIGHTS.multipleActiveListings,
      countSignal,
      activeCount,
    );
  }

  const priceSignal = signals.get('latest_listing_price');
  const price = numberValue(priceSignal);
  if (price !== undefined) {
    const tier = REAL_ESTATE_VIDEO_WEIGHTS.listingValue.find(({ minimum }) => price >= minimum);
    if (tier) add('LISTING_VALUE', 'High-value listing', tier.points, priceSignal, price);
  }

  const booleanRule = (key: string, rule: string, label: string, points: number): void => {
    const signal = signals.get(key);
    if (booleanValue(signal) === true) add(rule, label, points, signal, true);
  };
  booleanRule(
    'has_instagram',
    'HAS_INSTAGRAM',
    'Agent has Instagram',
    REAL_ESTATE_VIDEO_WEIGHTS.instagram,
  );
  booleanRule('has_tiktok', 'HAS_TIKTOK', 'Agent has TikTok', REAL_ESTATE_VIDEO_WEIGHTS.tiktok);
  booleanRule(
    'has_facebook',
    'HAS_FACEBOOK',
    'Agent has Facebook',
    REAL_ESTATE_VIDEO_WEIGHTS.facebook,
  );
  booleanRule(
    'has_agent_headshot',
    'HAS_AGENT_HEADSHOT',
    'Professional agent headshot',
    REAL_ESTATE_VIDEO_WEIGHTS.headshot,
  );
  booleanRule(
    'has_agent_website',
    'HAS_AGENT_WEBSITE',
    'Agent website present',
    REAL_ESTATE_VIDEO_WEIGHTS.agentWebsite,
  );

  const brokerageSignal = signals.get('brokerage');
  const brokerage = textValue(brokerageSignal)?.toLocaleLowerCase('en-US');
  if (brokerage && ESTABLISHED_BROKERAGES.some((name) => brokerage.includes(name))) {
    add(
      'ESTABLISHED_BROKERAGE',
      'Established brokerage',
      REAL_ESTATE_VIDEO_WEIGHTS.establishedBrokerage,
      brokerageSignal,
      brokerage,
    );
  }

  const rawScore = components.reduce((sum, component) => sum + component.points, 0);
  const calculatedScore = Math.min(100, Math.max(0, rawScore));
  const inputDates = [
    input.agent.updatedAt,
    input.latestListing?.updatedAt,
    listedAt,
    ...[...signals.values()].map(({ observedAt }) => observedAt),
  ].flatMap((value) => (value ? [value.getTime()] : []));
  const inputAsOf = inputDates.length ? new Date(Math.max(...inputDates)) : calculatedAt;
  const primaryOpportunity = input.latestListing
    ? {
        listingId: input.latestListing.id ?? null,
        address: input.latestListing.address ?? null,
        propertyUrl: input.latestListing.propertyUrl ?? null,
        listedAt: input.latestListing.listedAt?.toISOString() ?? null,
      }
    : null;
  const eligible = Boolean(input.latestListing && activeCount > 0);
  const score = eligible ? calculatedScore : 0;
  const explanation = {
    score,
    rawScore,
    band: scoreBand(score),
    version: REAL_ESTATE_VIDEO_SCORING_VERSION,
    eligible,
    manualReview: false,
    disqualifications: eligible ? [] : ['NO_ACTIVE_LISTING'],
    flags: [],
    components,
    inputState: {
      asOf: inputAsOf.toISOString(),
      fingerprint: fingerprint(input, signals),
      signalIds: [...signals.values()].flatMap(({ id }) => (id ? [id] : [])),
    },
    primaryOpportunity,
  };
  return {
    offer: IntelligenceOffer.REAL_ESTATE_VIDEO,
    score,
    band: scoreBand(score),
    rulesetVersion: REAL_ESTATE_VIDEO_SCORING_VERSION,
    inputAsOf,
    explanation,
    components,
  };
}
