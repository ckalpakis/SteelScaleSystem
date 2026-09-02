import { createHash } from 'node:crypto';

import { IntelligenceOffer, type Prisma } from '@prisma/client';

import {
  ENTERPRISE_NAME_MARKERS,
  ENTERPRISE_OR_FRANCHISE_SIGNALS,
  HIGH_VALUE_VOICE_AI_NICHES,
  VOICE_AI_SCORING_VERSION,
  VOICE_AI_WEIGHTS,
} from './config.js';
import type {
  ScoreBand,
  ScoreCalculation,
  ScoreComponent,
  ScoringSignal,
  VoiceAiScoringInput,
} from './types.js';

const SIGNALS = {
  GOOGLE_REVIEW_COUNT: 'google_review_count',
  GOOGLE_RATING: 'google_rating',
  IS_24_HOUR: 'is_24_hour',
  MENTIONS_24_7: 'mentions_24_7',
  MENTIONS_EMERGENCY: 'mentions_emergency',
  MENTIONS_SAME_DAY: 'mentions_same_day',
  HAS_CHATBOT: 'has_chatbot',
  HAS_ONLINE_BOOKING: 'has_online_booking',
  HAS_WEBSITE: 'has_website',
  WEBSITE_REACHABLE: 'website_reachable',
  GOOGLE_VERIFIED: 'google_verified',
  PHOTO_COUNT: 'photo_count',
  BUSINESS_STATUS: 'google_business_status',
  MULTIPLE_LOCATIONS: 'multiple_locations',
} as const;

export function scoreBand(score: number): ScoreBand {
  if (score >= 90) return 'HOT';
  if (score >= 75) return 'HIGH';
  if (score >= 60) return 'MEDIUM';
  if (score >= 40) return 'LOW';
  return 'POOR';
}

function latestSignals(signals: ScoringSignal[]): Map<string, ScoringSignal> {
  const latest = new Map<string, ScoringSignal>();
  for (const signal of signals) {
    const existing = latest.get(signal.key);
    if (!existing || signal.observedAt > existing.observedAt) latest.set(signal.key, signal);
  }
  return latest;
}

function booleanSignal(signals: Map<string, ScoringSignal>, key: string): boolean | undefined {
  const signal = signals.get(key);
  if (!signal) return undefined;
  if (typeof signal.booleanValue === 'boolean') return signal.booleanValue;
  return typeof signal.value === 'boolean' ? signal.value : undefined;
}

function numberSignal(signals: Map<string, ScoringSignal>, key: string): number | undefined {
  const signal = signals.get(key);
  if (!signal) return undefined;
  if (typeof signal.numberValue === 'number') return signal.numberValue;
  return typeof signal.value === 'number' ? signal.value : undefined;
}

function textSignal(signals: Map<string, ScoringSignal>, key: string): string | undefined {
  const signal = signals.get(key);
  if (!signal) return undefined;
  if (typeof signal.textValue === 'string') return signal.textValue;
  return typeof signal.value === 'string' ? signal.value : undefined;
}

function evidence(signal: ScoringSignal | undefined, detail: string): Prisma.InputJsonValue {
  return {
    detail,
    ...(signal
      ? {
          signalId: signal.id ?? null,
          signalKey: signal.key,
          provider: signal.provider,
          observedAt: signal.observedAt.toISOString(),
          confidence: signal.confidence ?? null,
        }
      : { source: 'canonical_business' }),
  };
}

function normalizedText(value: string | null | undefined): string {
  return ` ${
    value
      ?.toLocaleLowerCase('en-US')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim() ?? ''
  } `;
}

export function matchHighValueNiche(
  niche: string | null | undefined,
  category: string | null | undefined,
): string | undefined {
  const haystack = `${normalizedText(niche)}${normalizedText(category)}`;
  return Object.entries(HIGH_VALUE_VOICE_AI_NICHES).find(([, aliases]) =>
    aliases.some((alias) => haystack.includes(` ${alias} `)),
  )?.[0];
}

function inputFingerprint(input: VoiceAiScoringInput, signals: Map<string, ScoringSignal>): string {
  const state = {
    business: {
      name: input.business.name,
      niche: input.business.niche ?? null,
      category: input.business.category ?? null,
      normalizedPhone: input.business.normalizedPhone ?? null,
      updatedAt: input.business.updatedAt?.toISOString() ?? null,
    },
    signals: [...signals.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((signal) => ({
        id: signal.id ?? null,
        key: signal.key,
        value: signal.value,
        observedAt: signal.observedAt.toISOString(),
      })),
  };
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

export function calculateVoiceAiScore(input: VoiceAiScoringInput): ScoreCalculation {
  const calculatedAt = input.calculatedAt ?? new Date();
  const signals = latestSignals(input.signals);
  const components: ScoreComponent[] = [];
  const disqualifications: string[] = [];
  const flags: string[] = [];
  const add = (
    rule: string,
    label: string,
    points: number,
    signal: ScoringSignal | undefined,
    observedValue: Prisma.InputJsonValue | undefined,
    detail: string,
  ): void => {
    components.push({
      rule,
      label,
      points,
      evidence: evidence(signal, detail),
      signalId: signal?.id,
      observedValue,
    });
  };

  const reviewSignal = signals.get(SIGNALS.GOOGLE_REVIEW_COUNT);
  const reviews = numberSignal(signals, SIGNALS.GOOGLE_REVIEW_COUNT);
  if (reviews !== undefined) {
    const tier = VOICE_AI_WEIGHTS.reviews.find(({ minimum }) => reviews >= minimum)!;
    add(
      'GOOGLE_REVIEWS',
      'Google review maturity',
      tier.points,
      reviewSignal,
      reviews,
      `${reviews} Google reviews`,
    );
  }

  const ratingSignal = signals.get(SIGNALS.GOOGLE_RATING);
  const rating = numberSignal(signals, SIGNALS.GOOGLE_RATING);
  if (rating !== undefined) {
    const tier = VOICE_AI_WEIGHTS.rating.find(({ minimum }) => rating >= minimum);
    add(
      'GOOGLE_RATING',
      'Google rating',
      tier?.points ?? 0,
      ratingSignal,
      rating,
      `${rating} Google rating`,
    );
  }

  const niche = matchHighValueNiche(input.business.niche, input.business.category);
  if (niche) {
    add(
      'HIGH_VALUE_NICHE',
      'High-value phone-dependent niche',
      VOICE_AI_WEIGHTS.highPriorityNiche,
      undefined,
      niche,
      `Matched centralized niche: ${niche}`,
    );
  }

  const booleanRule = (
    keys: string[],
    rule: string,
    label: string,
    points: number,
    expected: boolean,
  ): void => {
    const signal = keys
      .map((key) => signals.get(key))
      .find((candidate) => candidate && booleanSignal(signals, candidate.key) === expected);
    if (signal) {
      add(rule, label, points, signal, expected, `${signal.key} is ${String(expected)}`);
    }
  };
  booleanRule(
    [SIGNALS.IS_24_HOUR, SIGNALS.MENTIONS_24_7],
    'ADVERTISES_24_7',
    'Advertises 24/7 availability',
    VOICE_AI_WEIGHTS.advertises24Hours,
    true,
  );
  booleanRule(
    [SIGNALS.MENTIONS_EMERGENCY],
    'EMERGENCY_SERVICE',
    'Advertises emergency service',
    VOICE_AI_WEIGHTS.advertisesEmergency,
    true,
  );
  booleanRule(
    [SIGNALS.MENTIONS_SAME_DAY],
    'SAME_DAY_SERVICE',
    'Advertises same-day service',
    VOICE_AI_WEIGHTS.advertisesSameDay,
    true,
  );
  booleanRule(
    [SIGNALS.HAS_CHATBOT],
    'NO_CHATBOT',
    'No chatbot detected',
    VOICE_AI_WEIGHTS.noChatbot,
    false,
  );
  booleanRule(
    [SIGNALS.HAS_ONLINE_BOOKING],
    'NO_ONLINE_BOOKING',
    'No online booking detected',
    VOICE_AI_WEIGHTS.noOnlineBooking,
    false,
  );

  const websiteSignal = signals.get(SIGNALS.HAS_WEBSITE);
  const reachableSignal = signals.get(SIGNALS.WEBSITE_REACHABLE);
  if (
    booleanSignal(signals, SIGNALS.HAS_WEBSITE) === true &&
    booleanSignal(signals, SIGNALS.WEBSITE_REACHABLE) === true
  ) {
    add(
      'REACHABLE_WEBSITE',
      'Website exists and is reachable',
      VOICE_AI_WEIGHTS.reachableWebsite,
      reachableSignal ?? websiteSignal,
      true,
      'Both website existence and reachability are true',
    );
  }
  booleanRule(
    [SIGNALS.GOOGLE_VERIFIED],
    'GOOGLE_VERIFIED',
    'Google verified business',
    VOICE_AI_WEIGHTS.googleVerified,
    true,
  );

  const photosSignal = signals.get(SIGNALS.PHOTO_COUNT);
  const photos = numberSignal(signals, SIGNALS.PHOTO_COUNT);
  if (
    reviews !== undefined &&
    photos !== undefined &&
    reviews >= VOICE_AI_WEIGHTS.highActivity.minimumReviews &&
    photos >= VOICE_AI_WEIGHTS.highActivity.minimumPhotos
  ) {
    add(
      'HIGH_ACTIVITY',
      'High photo and review activity',
      VOICE_AI_WEIGHTS.highActivity.points,
      photosSignal ?? reviewSignal,
      { reviews, photos },
      `${reviews} reviews and ${photos} photos`,
    );
  }

  if (
    reviews !== undefined &&
    reviews <= VOICE_AI_WEIGHTS.weakBusiness.maximumReviews &&
    (photos === undefined || photos <= VOICE_AI_WEIGHTS.weakBusiness.maximumPhotos)
  ) {
    add(
      'VERY_WEAK_BUSINESS',
      'Very weak or unestablished business',
      VOICE_AI_WEIGHTS.weakBusiness.points,
      reviewSignal,
      { reviews, photos: photos ?? null },
      'Very low review count and no strong photo activity',
    );
  }

  const statusSignal = signals.get(SIGNALS.BUSINESS_STATUS);
  const status = textSignal(signals, SIGNALS.BUSINESS_STATUS)?.toUpperCase();
  if (status && /(?:PERMANENTLY_CLOSED|CLOSED_PERMANENTLY)/.test(status)) {
    disqualifications.push('PERMANENTLY_CLOSED');
    add(
      'PERMANENTLY_CLOSED',
      'Business is permanently closed',
      0,
      statusSignal,
      status,
      'Google business status',
    );
  }
  if (!input.business.normalizedPhone) {
    disqualifications.push('NO_USABLE_PHONE');
    add(
      'NO_USABLE_PHONE',
      'No usable phone for Voice AI outbound',
      0,
      undefined,
      undefined,
      'Canonical normalized phone is absent',
    );
  }

  const explicitEnterprise = ENTERPRISE_OR_FRANCHISE_SIGNALS.map((key) => signals.get(key)).find(
    (signal) => signal && booleanSignal(signals, signal.key) === true,
  );
  const multipleLocations = booleanSignal(signals, SIGNALS.MULTIPLE_LOCATIONS) === true;
  const businessName = normalizedText(input.business.name);
  const nameMarker = ENTERPRISE_NAME_MARKERS.find((marker) => businessName.includes(marker));
  if (explicitEnterprise || nameMarker || multipleLocations) {
    flags.push('ENTERPRISE_OR_FRANCHISE_REVIEW');
    add(
      'ENTERPRISE_OR_FRANCHISE',
      'Enterprise or franchise requires review',
      VOICE_AI_WEIGHTS.enterpriseOrFranchise,
      explicitEnterprise ?? signals.get(SIGNALS.MULTIPLE_LOCATIONS),
      explicitEnterprise ? true : (nameMarker ?? 'multiple_locations'),
      'Explicit signal, multiple locations, or conservative name marker',
    );
  }

  const rawScore = components.reduce((sum, component) => sum + component.points, 0);
  const eligible = disqualifications.length === 0;
  const score = eligible ? Math.max(0, Math.min(100, rawScore)) : 0;
  const signalDates = [...signals.values()].map(({ observedAt }) => observedAt.getTime());
  const inputAsOf = new Date(Math.max(input.business.updatedAt?.getTime() ?? 0, ...signalDates));
  const effectiveInputAsOf = inputAsOf.getTime() > 0 ? inputAsOf : calculatedAt;
  const band = scoreBand(score);
  const explanation = {
    score,
    rawScore,
    band,
    version: VOICE_AI_SCORING_VERSION,
    eligible,
    manualReview: flags.length > 0,
    disqualifications,
    flags,
    components,
    inputState: {
      asOf: effectiveInputAsOf.toISOString(),
      fingerprint: inputFingerprint(input, signals),
      signalIds: [...signals.values()].flatMap(({ id }) => (id ? [id] : [])),
    },
  };
  return {
    offer: IntelligenceOffer.VOICE_AI,
    score,
    band,
    rulesetVersion: VOICE_AI_SCORING_VERSION,
    inputAsOf: effectiveInputAsOf,
    explanation,
    components,
  };
}
