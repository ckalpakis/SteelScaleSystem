import { randomUUID } from 'node:crypto';

import type { FixtureLeadPayload } from '../src/lead-intelligence/ingestion/adapters/fixture.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

async function run(): Promise<void> {
  process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:54329/steel_scale';
  const { db } = await import('../src/db/client.js');
  const { FixtureLeadSourceAdapter } =
    await import('../src/lead-intelligence/ingestion/adapters/fixture.js');
  const { ingestLeadSource } = await import('../src/lead-intelligence/ingestion/service.js');
  const suffix = randomUUID().slice(0, 8);
  const adapter = new FixtureLeadSourceAdapter(`fixture_${suffix}`);
  const client = await db.client.create({
    data: {
      businessName: `Phase 2 Test ${suffix}`,
      phoneNumber: `+1556${String(Date.now()).slice(-7)}`,
      timezone: 'America/New_York',
      services: ['Testing'],
    },
  });
  let runNumber = 0;
  const ingest = (records: unknown[], idempotencyKey = `run-${++runNumber}`) =>
    ingestLeadSource({
      clientId: client.id,
      idempotencyKey,
      adapter,
      records,
      defaultCountryCallingCode: '1',
    });

  const original: FixtureLeadPayload = {
    externalId: `alpha-${suffix}`,
    business: {
      name: 'Alpha Emergency Plumbing',
      googlePlaceId: `place-alpha-${suffix}`,
      website: 'https://www.alpha.example/services',
      phone: '(919) 555-0101',
      city: 'Raleigh',
      state: 'NC',
    },
    contacts: [
      {
        firstName: 'Alex',
        lastName: 'Owner',
        email: `alex-${suffix}@alpha.example`,
      },
    ],
    signals: [{ key: 'google_review_count', value: 10, kind: 'number' }],
  };

  try {
    const first = await ingest([original]);
    assertEqual(first.newBusinesses, 1, 'initial business created');
    assertEqual(first.newContacts, 1, 'initial contact created');

    const samePlace = await ingest([
      {
        externalId: `alpha-place-alias-${suffix}`,
        business: {
          name: 'Alpha Plumbing Display Name',
          googlePlaceId: `place-alpha-${suffix}`,
        },
      },
    ]);
    assertEqual(samePlace.newBusinesses, 0, 'same Google Place ID does not create business');
    assertEqual(samePlace.updatedBusinesses, 1, 'same Google Place ID resolves existing business');

    const sameDomain = await ingest([
      {
        externalId: `alpha-domain-alias-${suffix}`,
        business: { name: 'Alpha Website Listing', website: 'HTTPS://ALPHA.EXAMPLE/contact' },
      },
    ]);
    assertEqual(sameDomain.newBusinesses, 0, 'same normalized domain does not create business');

    const samePhone = await ingest([
      {
        externalId: `alpha-phone-alias-${suffix}`,
        business: { name: 'Alpha Phone Listing', phone: '+1 919-555-0101' },
      },
    ]);
    assertEqual(samePhone.newBusinesses, 0, 'same normalized phone does not create business');
    assertEqual(
      await db.prospectBusiness.count({ where: { clientId: client.id } }),
      1,
      'strong identifiers converge on one canonical business',
    );

    const sameNameDifferentBusinesses = await ingest([
      {
        externalId: `shared-one-${suffix}`,
        business: {
          name: 'Main Street Realty',
          googlePlaceId: `shared-place-one-${suffix}`,
          city: 'Raleigh',
          state: 'NC',
        },
      },
      {
        externalId: `shared-two-${suffix}`,
        business: {
          name: 'Main Street Realty',
          googlePlaceId: `shared-place-two-${suffix}`,
          city: 'Raleigh',
          state: 'NC',
        },
      },
    ]);
    assertEqual(sameNameDifferentBusinesses.newBusinesses, 2, 'same name is not an auto-merge key');

    const reviewUpdate = structuredClone(original);
    reviewUpdate.signals = [{ key: 'google_review_count', value: 25, kind: 'number' }];
    const updatedReview = await ingest([reviewUpdate]);
    assertEqual(
      updatedReview.updatedBusinesses,
      1,
      'changed source record updates canonical record',
    );
    const alphaSource = await db.leadSourceRecord.findUniqueOrThrow({
      where: {
        clientId_provider_recordKey: {
          clientId: client.id,
          provider: adapter.provider,
          recordKey: `external:${original.externalId}`,
        },
      },
      include: { versions: true, lead: { include: { signals: true } } },
    });
    assertEqual(alphaSource.versions.length, 2, 'changed payload preserves two raw versions');
    assertEqual(
      alphaSource.lead?.signals.length,
      2,
      'updated signal preserves observation history',
    );
    assert(
      alphaSource.lead?.signals.some((signal) => signal.numberValue?.toNumber() === 25),
      'latest review count is retained',
    );

    const phoneUpdate = structuredClone(reviewUpdate);
    phoneUpdate.business.phone = '(919) 555-0199';
    await ingest([phoneUpdate]);
    const alphaBusiness = await db.prospectBusiness.findUniqueOrThrow({
      where: { id: alphaSource.businessId ?? '' },
    });
    assertEqual(
      alphaBusiness.normalizedPhone,
      '+19195550199',
      'new phone updates canonical business',
    );

    const malformed = await ingest([{ externalId: `malformed-${suffix}`, wrong: true }]);
    assertEqual(malformed.invalid, 1, 'malformed source record is invalid');
    assertEqual(
      await db.ingestionError.count({ where: { ingestionRunId: malformed.runId } }),
      1,
      'malformed source record creates an error record',
    );
    assertEqual(
      await db.leadSourceRecordVersion.count({ where: { ingestionRunId: malformed.runId } }),
      1,
      'malformed raw payload remains available',
    );

    const partial = await ingest([
      { externalId: `partial-${suffix}`, business: { name: 'Partial But Valid Prospect' } },
    ]);
    assertEqual(partial.valid, 1, 'partial record with stable source identity is valid');
    assertEqual(partial.newBusinesses, 1, 'partial record creates a canonical business');

    const retryKey = `provider-retry-${suffix}`;
    const retryFirst = await ingest([original], retryKey);
    const retrySecond = await ingest([original], retryKey);
    assertEqual(retrySecond.runId, retryFirst.runId, 'same idempotency key returns original run');
    assertEqual(
      retrySecond.duplicates,
      retryFirst.duplicates,
      'provider retry returns stable metrics',
    );

    const duplicate = await ingest([original]);
    assertEqual(duplicate.duplicates, 1, 'identical source record in a new run is a duplicate');
    assertEqual(duplicate.updatedBusinesses, 0, 'duplicate does not report a canonical update');

    process.stdout.write(
      `Lead Intelligence Phase 2 ingestion tests passed (client ${client.id}, ${runNumber} runs).\n`,
    );
  } finally {
    await db.client.delete({ where: { id: client.id } });
    await db.$disconnect();
  }
}

void run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
