import { randomUUID } from 'node:crypto';

import {
  IntelligenceOffer,
  OutreachDisposition,
  ProspectRelationshipStatus,
  type Prisma,
} from '@prisma/client';

import type {
  RecommendationCandidate,
  RecommendationContext,
} from '../src/lead-intelligence/recommendations/types.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

const now = new Date('2026-09-02T12:00:00.000Z');

function candidate(
  offer: IntelligenceOffer,
  score: number,
  overrides: Partial<RecommendationCandidate> = {},
): RecommendationCandidate {
  return {
    offer,
    scoreSnapshotId: `${offer}-${score}`,
    score,
    eligible: true,
    disqualifications: [],
    inputAsOf: new Date('2026-09-01T12:00:00.000Z'),
    factors: [
      {
        rule: 'EMERGENCY_SERVICE',
        label: 'Advertises emergency service',
        points: 15,
        observedValue: true,
        confidence: 0.95,
        observedAt: new Date('2026-09-01T12:00:00.000Z'),
      },
      {
        rule: 'GOOGLE_REVIEWS',
        label: 'Google review maturity',
        points: 20,
        observedValue: 184,
        confidence: 0.99,
        observedAt: new Date('2026-09-01T12:00:00.000Z'),
      },
    ],
    ...overrides,
  };
}

function context(overrides: Partial<RecommendationContext> = {}): RecommendationContext {
  return {
    businessId: 'business-fixture',
    leadId: 'lead-fixture',
    relationshipStatus: ProspectRelationshipStatus.prospect,
    suppressedOffers: [],
    now,
    ...overrides,
  };
}

async function run(): Promise<void> {
  process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:54329/steel_scale';
  const [policy, recommendationService, queryService, { db }] = await Promise.all([
    import('../src/lead-intelligence/recommendations/policy.js'),
    import('../src/lead-intelligence/recommendations/service.js'),
    import('../src/lead-intelligence/recommendations/prospect-query.js'),
    import('../src/db/client.js'),
  ]);

  const candidates = [
    candidate(IntelligenceOffer.VOICE_AI, 93),
    candidate(IntelligenceOffer.WEBSITE, 38),
    candidate(IntelligenceOffer.SEO_RANKING, 67),
    candidate(IntelligenceOffer.REVIEWS, 42),
  ];
  const primary = policy.recommendOffers(candidates, context());
  assertEqual(primary.primaryOffer, IntelligenceOffer.VOICE_AI, 'highest eligible score wins');
  assertEqual(primary.score, 93, 'primary score returned');
  assert(primary.confidence >= 0.9, 'fresh high-confidence evidence produces high confidence');
  assert(primary.reasons.includes('Emergency service offered'), 'human-readable reason included');
  assert(primary.reasons.includes('184 Google reviews'), 'review evidence included');
  assertEqual(
    primary.rankedOffers[1]?.offer,
    IntelligenceOffer.SEO_RANKING,
    'offers ranked by score',
  );

  const disqualified = policy.recommendOffers(
    [
      candidate(IntelligenceOffer.VOICE_AI, 99, {
        eligible: false,
        disqualifications: ['NO_USABLE_PHONE'],
      }),
      candidate(IntelligenceOffer.WEBSITE, 60),
    ],
    context(),
  );
  assertEqual(disqualified.primaryOffer, IntelligenceOffer.WEBSITE, 'disqualification beats score');
  assertEqual(disqualified.excludedOffers[0]?.reasons[0], 'NO_USABLE_PHONE', 'reason retained');

  const suppressed = policy.recommendOffers(
    candidates,
    context({ suppressedOffers: [{ offer: IntelligenceOffer.VOICE_AI, reason: 'Owner request' }] }),
  );
  assertEqual(suppressed.primaryOffer, IntelligenceOffer.SEO_RANKING, 'manual suppression honored');
  const customer = policy.recommendOffers(
    candidates,
    context({ relationshipStatus: ProspectRelationshipStatus.current_customer }),
  );
  assertEqual(customer.primaryOffer, null, 'current customer excluded');
  const doNotContact = policy.recommendOffers(
    candidates,
    context({
      outreach: {
        disposition: OutreachDisposition.do_not_contact,
        contactable: false,
        contactAttemptCount: 2,
      },
    }),
  );
  assertEqual(doNotContact.primaryOffer, null, 'do-not-contact status excluded');
  const stale = policy.recommendOffers(
    [
      candidate(IntelligenceOffer.VOICE_AI, 93, {
        factors: candidates[0]!.factors.map((factor) => ({
          ...factor,
          observedAt: new Date('2025-01-01T00:00:00.000Z'),
        })),
      }),
    ],
    context(),
  );
  assert(stale.confidence < primary.confidence, 'stale evidence lowers confidence');
  const contacted = policy.recommendOffers(
    candidates,
    context({
      outreach: {
        disposition: OutreachDisposition.contacted,
        contactable: true,
        lastContactedAt: new Date('2026-08-20T12:00:00.000Z'),
        contactAttemptCount: 1,
      },
    }),
  );
  assert(contacted.confidence < primary.confidence, 'previous outreach lowers confidence');
  process.stdout.write('Lead Intelligence Phase 6 deterministic policy tests passed.\n');

  if (process.argv.includes('--unit-only')) {
    await db.$disconnect();
    return;
  }

  const suffix = randomUUID().slice(0, 8);
  const client = await db.client.create({
    data: {
      businessName: `Recommendation Phase 6 Test ${suffix}`,
      phoneNumber: `+1560${String(Date.now()).slice(-7)}`,
      timezone: 'America/New_York',
      services: ['Testing'],
    },
  });
  try {
    const makeBusiness = async (data: {
      name: string;
      score: number;
      city: string;
      state: string;
      niche: string;
      reviews: number;
      rating: number;
      chatbot: boolean;
      booking: boolean;
      emergency: boolean;
      hours24: boolean;
    }) => {
      const business = await db.prospectBusiness.create({
        data: {
          clientId: client.id,
          name: data.name,
          normalizedName: data.name.toLowerCase(),
          city: data.city,
          normalizedCity: data.city.toLowerCase(),
          state: data.state,
          normalizedState: data.state.toLowerCase(),
          niche: data.niche,
          phone: '+19195550142',
          normalizedPhone: '+19195550142',
          website: `https://${data.name.toLowerCase().replace(/[^a-z]+/g, '-')}.example`,
          normalizedDomain: `${data.name.toLowerCase().replace(/[^a-z]+/g, '-')}.example`,
          websiteLastAuditedAt: new Date('2026-09-01T00:00:00.000Z'),
        },
      });
      const lead = await db.lead.create({ data: { clientId: client.id, businessId: business.id } });
      const source = await db.leadSourceRecord.create({
        data: {
          clientId: client.id,
          leadId: lead.id,
          businessId: business.id,
          provider: 'outscraper_google_maps',
          recordKey: `fixture:${business.id}`,
          rawPayload: { fixture: true },
        },
      });
      const signalValues: Array<[string, Prisma.InputJsonValue, 'number' | 'boolean']> = [
        ['google_review_count', data.reviews, 'number'],
        ['google_rating', data.rating, 'number'],
        ['has_chatbot', data.chatbot, 'boolean'],
        ['has_online_booking', data.booking, 'boolean'],
        ['mentions_emergency', data.emergency, 'boolean'],
        ['mentions_24_7', data.hours24, 'boolean'],
        ['website_reachable', true, 'boolean'],
      ];
      const signals = await Promise.all(
        signalValues.map(([key, value, kind]) =>
          db.leadSignal.create({
            data: {
              clientId: client.id,
              leadId: lead.id,
              sourceRecordId: source.id,
              key,
              value,
              numberValue: kind === 'number' ? Number(value) : undefined,
              booleanValue: kind === 'boolean' ? Boolean(value) : undefined,
              provider: 'phase_6_fixture',
              confidence: 0.95,
              observedAt: new Date('2026-09-01T00:00:00.000Z'),
            },
          }),
        ),
      );
      const snapshot = await db.scoreSnapshot.create({
        data: {
          clientId: client.id,
          leadId: lead.id,
          offer: IntelligenceOffer.VOICE_AI,
          score: data.score,
          rulesetVersion: 'voice-ai-v1',
          inputAsOf: new Date('2026-09-01T00:00:00.000Z'),
          explanation: { eligible: true, disqualifications: [] },
          factors: {
            create: [
              {
                signalId: signals[4]!.id,
                key: 'EMERGENCY_SERVICE',
                label: 'Advertises emergency service',
                points: data.emergency ? 15 : 0,
                observedValue: data.emergency,
                ruleVersion: 'voice-ai-v1',
                position: 0,
              },
              {
                signalId: signals[0]!.id,
                key: 'GOOGLE_REVIEWS',
                label: 'Google review maturity',
                points: 20,
                observedValue: data.reviews,
                ruleVersion: 'voice-ai-v1',
                position: 1,
              },
            ],
          },
        },
      });
      return { business, lead, snapshot };
    };

    const hot = await makeBusiness({
      name: 'Hot Raleigh Plumbing',
      score: 93,
      city: 'Raleigh',
      state: 'NC',
      niche: 'plumbing',
      reviews: 184,
      rating: 4.8,
      chatbot: false,
      booking: false,
      emergency: true,
      hours24: true,
    });
    const medium = await makeBusiness({
      name: 'Medium Raleigh HVAC',
      score: 68,
      city: 'Raleigh',
      state: 'NC',
      niche: 'HVAC',
      reviews: 62,
      rating: 4.3,
      chatbot: true,
      booking: true,
      emergency: false,
      hours24: false,
    });
    await makeBusiness({
      name: 'Ohio Plumbing',
      score: 88,
      city: 'Columbus',
      state: 'OH',
      niche: 'plumbing',
      reviews: 120,
      rating: 4.7,
      chatbot: false,
      booking: false,
      emergency: true,
      hours24: false,
    });

    const generated = await recommendationService.generateOfferRecommendation(hot.business.id, now);
    assertEqual(
      generated.primaryOffer,
      IntelligenceOffer.VOICE_AI,
      'stored primary recommendation',
    );
    assertEqual(generated.score, 93, 'stored recommendation score');
    assertEqual(generated.recommendationIds.length, 1, 'history row created');
    const repeated = await recommendationService.generateOfferRecommendation(hot.business.id, now);
    assertEqual(repeated.reusedHistory, true, 'unchanged recommendation history reused');
    assertEqual(
      await db.offerRecommendation.count({ where: { leadId: hot.lead.id } }),
      1,
      'unchanged recommendation does not duplicate history',
    );

    await recommendationService.suppressOffer({
      leadId: hot.lead.id,
      offer: IntelligenceOffer.VOICE_AI,
      reason: 'Manual test suppression',
    });
    const suppressedDecision = await recommendationService.generateOfferRecommendation(
      hot.business.id,
      now,
    );
    assertEqual(suppressedDecision.primaryOffer, null, 'database suppression removes only offer');
    assertEqual(
      await recommendationService.liftOfferSuppression({
        leadId: hot.lead.id,
        offer: IntelligenceOffer.VOICE_AI,
      }),
      1,
      'suppression lifted',
    );

    await db.leadOutreachState.create({
      data: {
        leadId: medium.lead.id,
        disposition: OutreachDisposition.contacted,
        lastContactedAt: new Date('2026-08-25T00:00:00.000Z'),
        contactAttemptCount: 1,
      },
    });
    const top = await queryService.getTopVoiceAiProspects({
      clientId: client.id,
      state: 'NC',
      city: 'Raleigh',
      niche: 'plumb',
      minimumScore: 90,
      minimumReviewCount: 150,
      minimumRating: 4.5,
      websiteStatus: 'reachable',
      chatbotStatus: false,
      bookingStatus: false,
      operates24Hours: true,
      emergencyService: true,
      source: 'Outscraper Google Maps',
      lastEnrichedAfter: new Date('2026-08-01T00:00:00.000Z'),
      contactStatus: OutreachDisposition.not_contacted,
      now,
    });
    assertEqual(top.length, 1, 'combined top-prospect filters return one match');
    assertEqual(top[0]?.businessId, hot.business.id, 'top filter returns hot prospect');
    assertEqual(top[0]?.score, 93, 'top query returns current score');

    await db.prospectBusiness.update({
      where: { id: hot.business.id },
      data: { relationshipStatus: ProspectRelationshipStatus.current_customer },
    });
    const withoutCustomers = await queryService.getTopVoiceAiProspects({
      clientId: client.id,
      now,
    });
    assert(
      !withoutCustomers.some(({ businessId }) => businessId === hot.business.id),
      'current clients excluded',
    );
    process.stdout.write('Lead Intelligence Phase 6 persistence and query tests passed.\n');
  } finally {
    await db.client.delete({ where: { id: client.id } });
    await db.$disconnect();
  }
}

void run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
