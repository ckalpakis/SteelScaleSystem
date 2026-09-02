import { randomUUID } from 'node:crypto';

import {
  normalizeBusinessName,
  normalizeDomain,
  normalizeEmail,
  normalizePhone,
  payloadHash,
  sourceRecordKey,
} from '../src/lead-intelligence/ingestion/normalization.js';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function testNormalization(): void {
  assertEqual(
    normalizeBusinessName('  Smith & Sons, LLC  '),
    'smith and sons llc',
    'business name',
  );
  assertEqual(normalizeDomain('HTTPS://WWW.Example.COM/path?q=1'), 'example.com', 'domain');
  assertEqual(normalizeDomain('not a domain'), undefined, 'invalid domain');
  assertEqual(normalizePhone('(919) 555-0100', '1'), '+19195550100', 'US phone');
  assertEqual(normalizePhone('+44 20 7946 0958'), '+442079460958', 'international phone');
  assertEqual(normalizePhone('9195550100'), undefined, 'phone without country context');
  assertEqual(normalizeEmail(' Owner@Example.COM '), 'owner@example.com', 'email');
  assertEqual(
    payloadHash({ second: 2, first: { beta: true, alpha: false } }),
    payloadHash({ first: { alpha: false, beta: true }, second: 2 }),
    'stable payload hash',
  );
  assertEqual(
    sourceRecordKey({ externalId: ' place-123 ', rawPayload: {} }),
    'external:place-123',
    'external source key',
  );
}

async function testDatabaseDeduplication(): Promise<void> {
  process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:54329/steel_scale';
  const { db } = await import('../src/db/client.js');
  const { findBusinessMatch } = await import('../src/lead-intelligence/repositories/businesses.js');
  const { upsertSourceRecord } =
    await import('../src/lead-intelligence/repositories/source-records.js');
  const suffix = randomUUID().slice(0, 8);
  const client = await db.client.create({
    data: {
      businessName: `Lead Intelligence Test ${suffix}`,
      phoneNumber: `+1555${String(Date.now()).slice(-7)}`,
      timezone: 'America/New_York',
      services: ['Testing'],
    },
  });

  try {
    const business = await db.prospectBusiness.create({
      data: {
        clientId: client.id,
        name: 'Smith & Sons, LLC',
        normalizedName: normalizeBusinessName('Smith & Sons, LLC'),
        website: 'https://www.smith.example',
        normalizedDomain: 'smith.example',
        phone: '(919) 555-0100',
        normalizedPhone: '+19195550100',
        city: 'Raleigh',
        state: 'NC',
        normalizedCity: 'raleigh',
        normalizedState: 'nc',
        googlePlaceId: `place-${suffix}`,
      },
    });
    const lead = await db.lead.create({ data: { clientId: client.id, businessId: business.id } });

    const firstRecord = await upsertSourceRecord({
      clientId: client.id,
      provider: 'Outscraper Google Maps',
      externalId: `external-${suffix}`,
      rawPayload: { name: 'Smith & Sons' },
    });
    await db.leadSourceRecord.update({
      where: { id: firstRecord.id },
      data: { businessId: business.id, leadId: lead.id },
    });
    const secondRecord = await upsertSourceRecord({
      clientId: client.id,
      provider: 'Outscraper Google Maps',
      externalId: `external-${suffix}`,
      rawPayload: { name: 'Smith & Sons, LLC', reviews: 125 },
    });
    assertEqual(secondRecord.id, firstRecord.id, 'idempotent source-record upsert');

    const providerMatch = await findBusinessMatch(client.id, {
      provider: 'Outscraper Google Maps',
      externalId: `external-${suffix}`,
      name: 'Unrelated incoming display name',
    });
    assertEqual(providerMatch.businessId, business.id, 'provider external ID match');
    assertEqual(providerMatch.shouldAutoMerge, true, 'provider match auto merge');

    const domainMatch = await findBusinessMatch(client.id, {
      name: 'Smith and Sons',
      website: 'https://SMITH.example/contact',
    });
    assertEqual(domainMatch.businessId, business.id, 'normalized domain match');

    const identityReview = await findBusinessMatch(client.id, {
      name: 'Smith & Sons LLC',
      city: 'RALEIGH',
      state: 'nc',
    });
    assertEqual(identityReview.businessId, business.id, 'exact identity candidate');
    assertEqual(identityReview.shouldAutoMerge, false, 'name identity never auto merges');
    assertEqual(identityReview.requiresReview, true, 'name identity requires review');

    const secondBusiness = await db.prospectBusiness.create({
      data: {
        clientId: client.id,
        name: 'Shared Call Center Roofing',
        normalizedName: normalizeBusinessName('Shared Call Center Roofing'),
        normalizedPhone: '+19195550100',
      },
    });
    const conflictingMatch = await findBusinessMatch(client.id, {
      name: 'Incoming Conflicting Record',
      website: 'https://smith.example',
      phone: '+1 (919) 555-0100',
    });
    assertEqual(conflictingMatch.businessId, undefined, 'conflicting identifiers do not match');
    assertEqual(conflictingMatch.requiresReview, true, 'conflicting identifiers require review');
    assertEqual(
      conflictingMatch.conflictingBusinessIds.includes(secondBusiness.id),
      true,
      'conflict contains second business',
    );

    const noNameOnlyMatch = await findBusinessMatch(client.id, { name: 'Smith & Sons LLC' });
    assertEqual(noNameOnlyMatch.businessId, undefined, 'name-only does not match');
    assertEqual(
      await db.leadSourceRecord.count({ where: { clientId: client.id } }),
      1,
      'duplicate provider record count',
    );
  } finally {
    await db.client.delete({ where: { id: client.id } });
    await db.$disconnect();
  }
}

async function run(): Promise<void> {
  testNormalization();
  await testDatabaseDeduplication();
  process.stdout.write('Lead Intelligence Phase 1 normalization and deduplication tests passed.\n');
}

void run();
