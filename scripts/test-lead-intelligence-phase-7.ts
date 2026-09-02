import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { IntelligenceOffer } from '@prisma/client';

import type { ScoringSignal } from '../src/lead-intelligence/scoring/types.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

const now = new Date('2026-09-02T12:00:00.000Z');

function signal(key: string, value: boolean | number | string): ScoringSignal {
  return {
    id: `fixture-${key}`,
    key,
    value,
    booleanValue: typeof value === 'boolean' ? value : undefined,
    numberValue: typeof value === 'number' ? value : undefined,
    textValue: typeof value === 'string' ? value : undefined,
    provider: 'phase_7_fixture',
    confidence: 0.95,
    observedAt: now,
  };
}

async function run(): Promise<void> {
  process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:54329/steel_scale';
  const fixtureRecords = JSON.parse(
    await readFile(path.resolve('scripts/fixtures/real-estate/apify-listings.json'), 'utf8'),
  ) as unknown[];
  const [adapterModule, ingestionModule, importer, scoringModule, scoringService, { db }] =
    await Promise.all([
      import('../src/lead-intelligence/real-estate/apify-adapter.js'),
      import('../src/lead-intelligence/real-estate/ingestion.js'),
      import('../src/lead-intelligence/real-estate/import.js'),
      import('../src/lead-intelligence/scoring/real-estate-video.js'),
      import('../src/lead-intelligence/scoring/service.js'),
      import('../src/db/client.js'),
    ]);

  const zillowAdapter = new adapterModule.ApifyRealEstateAdapter('zillow');
  const validation = zillowAdapter.validate(fixtureRecords[0]);
  assert(validation.valid, 'realistic Zillow/Apify fixture validates');
  const normalized = zillowAdapter.normalize(validation.value);
  assertEqual(normalized.externalId, 'zillow-123-oak', 'provider listing ID normalized');
  assertEqual(normalized.price, 685000, 'listing price normalized');
  assertEqual(normalized.squareFeet, 2840, 'square footage normalized');
  assertEqual(normalized.images.length, 2, 'listing images normalized');
  assertEqual(normalized.agent?.fullName, 'Sarah Thompson', 'agent normalized');
  assertEqual(
    normalized.agent?.headshotUrl,
    'https://images.example/sarah.jpg',
    'headshot normalized',
  );
  assertEqual(
    ingestionModule.normalizeListingAddress(normalized),
    '123 oak street|raleigh|nc|27601',
    'cross-provider address identity normalized',
  );

  const modernApifyPayload = {
    zpid: 'modern-zillow-456',
    propertyUrl: 'https://www.zillow.com/homedetails/456-River-Rd/456_zpid/',
    listingAddress: {
      street: '456 River Road',
      city: 'Pittsburgh',
      state: 'PA',
      zipCode: '15222',
      full: '456 River Road, Pittsburgh, PA 15222',
    },
    coordinates: { latitude: 40.4406, longitude: -79.9959 },
    listingPrice: { amount: 685000 },
    bedrooms: 4,
    bathrooms: 3.5,
    livingArea: 2840,
    listingStatus: 'forSale',
    onMarketDate: '2026-09-02T00:00:00.000Z',
    listingPhotos: [{ url: 'https://images.example/modern-listing.jpg' }],
    agent: {
      name: 'Sarah Thompson',
      phoneNumber: '+14125550142',
      email: 'sarah@example.test',
      licenseNumber: 'PA-RS123456',
    },
    broker: { name: 'Example Realty' },
  };
  const modernValidation = zillowAdapter.validate(modernApifyPayload);
  assert(modernValidation.valid, 'modern nested Zillow/Apify payload validates');
  const modernNormalized = zillowAdapter.normalize(modernValidation.value);
  assertEqual(modernNormalized.address, '456 River Road, Pittsburgh, PA 15222', 'nested address');
  assertEqual(modernNormalized.price, 685000, 'nested listing price');
  assertEqual(modernNormalized.latitude, 40.4406, 'nested coordinates');
  assertEqual(modernNormalized.images.length, 1, 'nested listing photos');
  assertEqual(modernNormalized.agent?.phone, '+14125550142', 'nested agent phone');
  assertEqual(modernNormalized.brokerage, 'Example Realty', 'nested brokerage');
  assertEqual(
    modernNormalized.listedAt?.toISOString(),
    '2026-09-02T00:00:00.000Z',
    'modern listing date',
  );
  assert(!zillowAdapter.validate({ zpid: 'missing-address' }).valid, 'missing address rejected');

  const baseInput = {
    agent: { fullName: 'Sarah Thompson', updatedAt: now },
    latestListing: {
      id: 'listing-oak',
      address: '123 Oak Street',
      propertyUrl: 'https://example.test/123-oak',
      listedAt: new Date('2026-09-02T01:00:00.000Z'),
      updatedAt: now,
    },
    calculatedAt: now,
  };
  const scoreWith = (signals: ScoringSignal[]) =>
    scoringModule.calculateRealEstateVideoScore({ ...baseInput, signals });
  for (const [ageHours, points] of [
    [23.9, 30],
    [24, 25],
    [71.9, 25],
    [72, 15],
    [167.9, 15],
    [168, 0],
  ] as const) {
    const result = scoringModule.calculateRealEstateVideoScore({
      ...baseInput,
      latestListing: {
        ...baseInput.latestListing,
        listedAt: new Date(now.getTime() - ageHours * 3_600_000),
      },
      signals: [signal('active_listing_count', 1)],
    });
    assertEqual(
      result.components.find(({ rule }) => rule === 'LISTING_AGE')?.points ?? 0,
      points,
      `listing age boundary ${ageHours}`,
    );
  }
  for (const [count, points] of [
    [0, 0],
    [1, 5],
    [2, 10],
    [3, 10],
    [4, 20],
  ] as const) {
    const result = scoreWith([signal('active_listing_count', count)]);
    assertEqual(
      result.components.find(({ rule }) => rule === 'ACTIVE_LISTINGS')?.points ?? 0,
      points,
      `active count boundary ${count}`,
    );
  }
  for (const [price, points] of [
    [249999, 0],
    [250000, 5],
    [400000, 10],
    [750000, 15],
    [1000000, 20],
  ] as const) {
    const result = scoreWith([
      signal('active_listing_count', 1),
      signal('latest_listing_price', price),
    ]);
    assertEqual(
      result.components.find(({ rule }) => rule === 'LISTING_VALUE')?.points ?? 0,
      points,
      `price boundary ${price}`,
    );
  }
  const sarah = scoreWith([
    signal('active_listing_count', 6),
    signal('latest_listing_price', 685000),
    signal('has_instagram', true),
    signal('has_tiktok', true),
    signal('has_facebook', true),
    signal('has_agent_headshot', true),
    signal('has_agent_website', true),
    signal('brokerage', 'Compass'),
  ]);
  assertEqual(sarah.score, 100, 'real-estate score caps at 100');
  assert(sarah.explanation.rawScore > 100, 'uncapped score remains explainable');
  const opportunity = sarah.explanation as typeof sarah.explanation & {
    primaryOpportunity?: { address?: string };
  };
  assertEqual(
    opportunity.primaryOpportunity?.address,
    '123 Oak Street',
    'primary opportunity stored',
  );
  process.stdout.write(
    `Sarah Thompson — REAL_ESTATE_VIDEO ${sarah.score} (${sarah.components.map(({ rule, points }) => `${rule} +${points}`).join(', ')})\n`,
  );
  process.stdout.write(
    'Lead Intelligence Phase 7 deterministic adapter and scoring tests passed.\n',
  );

  if (process.argv.includes('--unit-only')) {
    await db.$disconnect();
    return;
  }

  const suffix = randomUUID().slice(0, 8);
  const client = await db.client.create({
    data: {
      businessName: `Real Estate Phase 7 Test ${suffix}`,
      phoneNumber: `+1561${String(Date.now()).slice(-7)}`,
      timezone: 'America/New_York',
      services: ['Testing'],
    },
  });
  try {
    const importRecord = (record: unknown, source: string, idempotencyKey: string) =>
      importer.importApifyRealEstateListings({
        clientId: client.id,
        source,
        idempotencyKey,
        records: [record],
        defaultCountryCallingCode: '1',
        observedAt: now,
      });
    const zillow = await importRecord(fixtureRecords[0], 'zillow', `zillow-${suffix}`);
    const realtor = await importRecord(fixtureRecords[1], 'realtor', `realtor-${suffix}`);
    const redfin = await importRecord(fixtureRecords[2], 'redfin', `redfin-${suffix}`);
    const pine = await importRecord(fixtureRecords[3], 'redfin', `redfin-pine-${suffix}`);
    assertEqual(zillow.newListings, 1, 'first provider creates listing');
    assertEqual(zillow.newAgents, 1, 'first provider creates agent');
    assertEqual(realtor.updatedListings, 1, 'second provider resolves same canonical listing');
    assertEqual(realtor.updatedAgents, 1, 'same agent deduplicated by email/phone');
    assertEqual(redfin.updatedListings, 1, 'third provider resolves same canonical listing');
    assertEqual(pine.newListings, 1, 'different address creates listing');
    assertEqual(
      await db.realEstateAgent.count({ where: { clientId: client.id } }),
      1,
      'one canonical agent',
    );
    assertEqual(
      await db.realEstateListing.count({ where: { clientId: client.id } }),
      2,
      'two canonical listings',
    );
    assertEqual(
      await db.realEstateListingSourceRecord.count({ where: { clientId: client.id } }),
      4,
      'four provider source records retained',
    );
    assertEqual(
      await db.realEstateListingSourceVersion.count({
        where: { sourceRecord: { clientId: client.id } },
      }),
      4,
      'raw source versions retained',
    );
    const oak = await db.realEstateListing.findFirstOrThrow({
      where: { clientId: client.id, normalizedAddress: '123 oak street|raleigh|nc|27601' },
      include: { providerSources: true, agent: true },
    });
    assertEqual(oak.providerSources.length, 3, 'Zillow, Realtor, and Redfin point to same listing');
    assertEqual(oak.agent?.fullName, 'Sarah Thompson', 'canonical listing links agent');
    assertEqual(
      (oak.rawPayload as { storedSeparately?: boolean }).storedSeparately,
      true,
      'canonical row does not duplicate raw source payload',
    );

    const agent = await db.realEstateAgent.findFirstOrThrow({ where: { clientId: client.id } });
    const signalRows = await db.leadSignal.findMany({
      where: { leadId: agent.leadId },
      orderBy: { createdAt: 'desc' },
    });
    const latestByKey = new Map<string, (typeof signalRows)[number]>();
    for (const row of signalRows) if (!latestByKey.has(row.key)) latestByKey.set(row.key, row);
    assertEqual(
      latestByKey.get('active_listing_count')?.numberValue?.toNumber(),
      2,
      'active listing count aggregated',
    );
    assertEqual(
      latestByKey.get('new_listing_last_24_hours')?.booleanValue,
      true,
      '24-hour signal generated',
    );
    assertEqual(
      latestByKey.get('has_agent_headshot')?.booleanValue,
      true,
      'headshot signal generated',
    );
    assertEqual(latestByKey.get('brokerage')?.textValue, 'Compass', 'brokerage signal generated');

    const duplicate = await importRecord(fixtureRecords[0], 'zillow', `zillow-retry-${suffix}`);
    assertEqual(duplicate.duplicateListings, 1, 'provider retry is idempotent');
    assertEqual(
      await db.realEstateListingSourceVersion.count({
        where: { sourceRecord: { clientId: client.id } },
      }),
      4,
      'duplicate raw payload does not create version',
    );

    const score = await scoringService.scoreLead(
      agent.leadId,
      IntelligenceOffer.REAL_ESTATE_VIDEO,
      { calculatedAt: now },
    );
    assertEqual(
      score.offer,
      IntelligenceOffer.REAL_ESTATE_VIDEO,
      'real-estate offer snapshot created',
    );
    assertEqual(score.score, 100, 'fixture agent scores deterministically');
    assertEqual(score.agentId, agent.id, 'score result links canonical agent');
    const snapshot = await db.scoreSnapshot.findUniqueOrThrow({
      where: { id: score.snapshotId },
      include: { factors: true },
    });
    assertEqual(snapshot.rulesetVersion, 'real-estate-video-v1', 'scoring version persisted');
    assertEqual(
      snapshot.factors.length,
      score.components.length,
      'score factor breakdown persisted',
    );

    const invalid = await importRecord({ listingId: 'no-address' }, 'zillow', `invalid-${suffix}`);
    assertEqual(invalid.invalid, 1, 'malformed listing reported');
    process.stdout.write('Lead Intelligence Phase 7 persistence tests passed.\n');
  } finally {
    await db.client.delete({ where: { id: client.id } });
    await db.$disconnect();
  }
}

void run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
