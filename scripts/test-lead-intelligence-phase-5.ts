import { randomUUID } from 'node:crypto';

import { IntelligenceOffer, type Prisma } from '@prisma/client';

import type { ScoringSignal, VoiceAiScoringInput } from '../src/lead-intelligence/scoring/types.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

const observedAt = new Date('2026-09-01T12:00:00.000Z');

function signal(key: string, value: boolean | number | string): ScoringSignal {
  return {
    id: `signal-${key}`,
    key,
    value,
    booleanValue: typeof value === 'boolean' ? value : undefined,
    numberValue: typeof value === 'number' ? value : undefined,
    textValue: typeof value === 'string' ? value : undefined,
    provider: 'fixture',
    confidence: 0.95,
    observedAt,
  };
}

function input(
  overrides: {
    business?: Partial<VoiceAiScoringInput['business']>;
    signals?: ScoringSignal[];
    calculatedAt?: Date;
  } = {},
): VoiceAiScoringInput {
  return {
    business: {
      name: 'Fixture Plumbing',
      niche: 'plumbing',
      category: 'Plumber',
      normalizedPhone: '+19195550142',
      updatedAt: observedAt,
      ...overrides.business,
    },
    signals: overrides.signals ?? [],
    calculatedAt: overrides.calculatedAt ?? new Date('2026-09-02T12:00:00.000Z'),
  };
}

async function run(): Promise<void> {
  process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:54329/steel_scale';
  const [voice, config, { db }, scoring] = await Promise.all([
    import('../src/lead-intelligence/scoring/voice-ai.js'),
    import('../src/lead-intelligence/scoring/config.js'),
    import('../src/db/client.js'),
    import('../src/lead-intelligence/scoring/service.js'),
  ]);

  assertEqual(voice.scoreBand(0), 'POOR', 'score band lower bound');
  assertEqual(voice.scoreBand(39), 'POOR', 'POOR upper bound');
  assertEqual(voice.scoreBand(40), 'LOW', 'LOW lower bound');
  assertEqual(voice.scoreBand(59), 'LOW', 'LOW upper bound');
  assertEqual(voice.scoreBand(60), 'MEDIUM', 'MEDIUM lower bound');
  assertEqual(voice.scoreBand(74), 'MEDIUM', 'MEDIUM upper bound');
  assertEqual(voice.scoreBand(75), 'HIGH', 'HIGH lower bound');
  assertEqual(voice.scoreBand(89), 'HIGH', 'HIGH upper bound');
  assertEqual(voice.scoreBand(90), 'HOT', 'HOT lower bound');
  assertEqual(voice.scoreBand(100), 'HOT', 'HOT upper bound');

  const reviewCases = [
    [0, 0],
    [9, 0],
    [10, 5],
    [29, 5],
    [30, 10],
    [74, 10],
    [75, 15],
    [149, 15],
    [150, 20],
  ] as const;
  for (const [reviews, points] of reviewCases) {
    const result = voice.calculateVoiceAiScore(
      input({
        business: { niche: null, category: null },
        signals: [signal('google_review_count', reviews)],
      }),
    );
    const component = result.components.find(({ rule }) => rule === 'GOOGLE_REVIEWS');
    assertEqual(component?.points, points, `review boundary ${reviews}`);
  }
  for (const [rating, points] of [
    [3.9, 0],
    [4, 3],
    [4.49, 3],
    [4.5, 5],
  ] as const) {
    const result = voice.calculateVoiceAiScore(
      input({
        business: { niche: null, category: null },
        signals: [signal('google_rating', rating)],
      }),
    );
    assertEqual(
      result.components.find(({ rule }) => rule === 'GOOGLE_RATING')?.points,
      points,
      `rating boundary ${rating}`,
    );
  }

  const unknownInfrastructure = voice.calculateVoiceAiScore(input());
  assert(
    !unknownInfrastructure.components.some(({ rule }) => rule === 'NO_CHATBOT'),
    'missing chatbot evidence does not earn gap points',
  );
  const noPhone = voice.calculateVoiceAiScore(input({ business: { normalizedPhone: null } }));
  assertEqual(noPhone.score, 0, 'no phone disqualifies Voice AI');
  assert(
    noPhone.explanation.disqualifications.includes('NO_USABLE_PHONE'),
    'phone reason recorded',
  );
  const closed = voice.calculateVoiceAiScore(
    input({ signals: [signal('google_business_status', 'PERMANENTLY_CLOSED')] }),
  );
  assertEqual(closed.score, 0, 'closed business disqualified');
  assert(
    closed.explanation.disqualifications.includes('PERMANENTLY_CLOSED'),
    'closed reason recorded',
  );

  const fixtureBusinesses: Array<{ name: string; data: VoiceAiScoringInput }> = [
    {
      name: 'Emergency Plumbing HOT',
      data: input({
        signals: [
          signal('google_review_count', 180),
          signal('google_rating', 4.8),
          signal('is_24_hour', true),
          signal('mentions_emergency', true),
          signal('mentions_same_day', true),
          signal('has_chatbot', false),
          signal('has_online_booking', false),
          signal('has_website', true),
          signal('website_reachable', true),
          signal('google_verified', true),
          signal('photo_count', 80),
        ],
      }),
    },
    {
      name: 'Established HVAC',
      data: input({
        business: { niche: 'HVAC' },
        signals: [signal('google_review_count', 80), signal('google_rating', 4.6)],
      }),
    },
    {
      name: 'New Electrician',
      data: input({
        business: { niche: 'electrician' },
        signals: [signal('google_review_count', 3), signal('photo_count', 1)],
      }),
    },
    {
      name: 'Towing 24/7',
      data: input({
        business: { niche: 'towing' },
        signals: [signal('mentions_24_7', true), signal('has_chatbot', false)],
      }),
    },
    {
      name: 'Dentist With Booking',
      data: input({
        business: { niche: 'dentist' },
        signals: [signal('has_online_booking', true), signal('google_review_count', 160)],
      }),
    },
    {
      name: 'Mold Emergency',
      data: input({
        business: { niche: 'mold remediation' },
        signals: [signal('mentions_emergency', true), signal('has_online_booking', false)],
      }),
    },
    {
      name: 'Veterinarian Same Day',
      data: input({
        business: { niche: 'veterinarian' },
        signals: [signal('mentions_same_day', true), signal('google_verified', true)],
      }),
    },
    {
      name: 'Unknown Niche',
      data: input({
        business: { niche: 'bakery', category: 'Bakery' },
        signals: [signal('google_review_count', 35)],
      }),
    },
    {
      name: 'National Franchise',
      data: input({
        business: { name: 'SERVPRO of Raleigh', niche: 'water restoration' },
        signals: [signal('google_review_count', 120)],
      }),
    },
    {
      name: 'Permanently Closed',
      data: input({ signals: [signal('google_business_status', 'CLOSED_PERMANENTLY')] }),
    },
  ];
  const explanations = fixtureBusinesses.map(({ name, data }) => ({
    name,
    result: voice.calculateVoiceAiScore(data),
  }));
  assertEqual(explanations[0]?.result.score, 100, 'score caps at 100');
  assertEqual(explanations[0]?.result.explanation.rawScore, 105, 'uncapped math retained');
  assertEqual(explanations[8]?.result.explanation.manualReview, true, 'franchise flagged');
  assertEqual(explanations.length, 10, 'ten fixture explanations generated');
  process.stdout.write('VOICE_AI fixture explanations:\n');
  for (const { name, result } of explanations) {
    const math = result.components
      .map(({ rule, points }) => `${rule}:${points >= 0 ? '+' : ''}${points}`)
      .join(', ');
    process.stdout.write(`- ${name}: ${result.score} ${result.band} [${math}]\n`);
  }
  if (process.argv.includes('--unit-only')) {
    process.stdout.write('Lead Intelligence Phase 5 deterministic unit tests passed.\n');
    await db.$disconnect();
    return;
  }

  const suffix = randomUUID().slice(0, 8);
  const client = await db.client.create({
    data: {
      businessName: `Scoring Phase 5 Test ${suffix}`,
      phoneNumber: `+1559${String(Date.now()).slice(-7)}`,
      timezone: 'America/New_York',
      services: ['Testing'],
    },
  });
  try {
    const business = await db.prospectBusiness.create({
      data: {
        clientId: client.id,
        name: 'Database Fixture Plumbing',
        normalizedName: 'database fixture plumbing',
        niche: 'plumbing',
        phone: '(919) 555-0142',
        normalizedPhone: '+19195550142',
      },
    });
    const lead = await db.lead.create({ data: { clientId: client.id, businessId: business.id } });
    const createSignal = (
      key: string,
      value: Prisma.InputJsonValue,
      projections: { booleanValue?: boolean; numberValue?: number; textValue?: string },
      signalObservedAt: Date = observedAt,
    ) =>
      db.leadSignal.create({
        data: {
          clientId: client.id,
          leadId: lead.id,
          key,
          value,
          ...projections,
          provider: 'phase_5_fixture',
          confidence: 0.95,
          observedAt: signalObservedAt,
          evidence: { fixture: true },
        },
      });
    await Promise.all([
      createSignal('google_review_count', 80, { numberValue: 80 }),
      createSignal('google_rating', 4.7, { numberValue: 4.7 }),
      createSignal('mentions_emergency', true, { booleanValue: true }),
      createSignal('has_chatbot', false, { booleanValue: false }),
      createSignal('has_online_booking', false, { booleanValue: false }),
      createSignal('google_verified', true, { booleanValue: true }),
    ]);
    const first = await scoring.scoreLead(lead.id, IntelligenceOffer.VOICE_AI, {
      calculatedAt: new Date('2026-09-02T12:00:00.000Z'),
    });
    assertEqual(first.score, 73, 'database fixture deterministic score');
    const stored = await db.scoreSnapshot.findUniqueOrThrow({
      where: { id: first.snapshotId },
      include: { factors: { orderBy: { position: 'asc' } } },
    });
    assertEqual(stored.rulesetVersion, config.VOICE_AI_SCORING_VERSION, 'version stored');
    assertEqual(stored.factors.length, first.components.length, 'explainable factors stored');
    assert(
      stored.factors.some(({ signalId }) => signalId !== null),
      'factors reference evidence signals',
    );

    const second = await scoring.rescoreBusiness(business.id, IntelligenceOffer.VOICE_AI, {
      calculatedAt: new Date('2026-09-02T13:00:00.000Z'),
    });
    assert(second.snapshotId !== first.snapshotId, 'rescore creates immutable snapshot');
    assertEqual(
      await db.scoreSnapshot.count({ where: { leadId: lead.id } }),
      2,
      'history retained',
    );

    await createSignal(
      'mentions_24_7',
      true,
      { booleanValue: true },
      new Date('2026-09-03T10:00:00.000Z'),
    );
    const stale = await scoring.rescoreStaleBusinesses({
      clientId: client.id,
      calculatedAt: new Date('2026-09-03T12:00:00.000Z'),
    });
    assertEqual(stale.scored, 1, 'new enrichment observation triggers stale rescore');
    assertEqual(stale.results[0]?.score, 88, 'stale rescore includes new evidence');

    let unsupportedFailed = false;
    try {
      await scoring.scoreLead(lead.id, IntelligenceOffer.WEBSITE);
    } catch (error) {
      unsupportedFailed = error instanceof Error && error.message.includes('not implemented');
    }
    assert(unsupportedFailed, 'unimplemented offer fails explicitly');
    process.stdout.write('Lead Intelligence Phase 5 persistence tests passed.\n');
  } finally {
    await db.client.delete({ where: { id: client.id } });
    await db.$disconnect();
  }
}

void run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
