import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

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
  const fixtureDirectory = path.resolve('scripts/fixtures/outscraper');
  const [{ db }, fileParser, importer, adapterModule] = await Promise.all([
    import('../src/db/client.js'),
    import('../src/lead-intelligence/integrations/outscraper-files.js'),
    import('../src/lead-intelligence/integrations/outscraper-import.js'),
    import('../src/lead-intelligence/integrations/outscraper-google-maps.js'),
  ]);
  const suffix = randomUUID().slice(0, 8);
  const client = await db.client.create({
    data: {
      businessName: `Outscraper Phase 3 Test ${suffix}`,
      phoneNumber: `+1557${String(Date.now()).slice(-7)}`,
      timezone: 'America/New_York',
      services: ['Testing'],
    },
  });

  try {
    const jsonPath = path.join(fixtureDirectory, 'google-maps-results.json');
    const jsonRecords = fileParser.parseOutscraperFileContents(
      jsonPath,
      await readFile(jsonPath, 'utf8'),
    );
    assertEqual(jsonRecords.length, 1, 'nested Outscraper JSON is flattened');
    const jsonResult = await importer.importOutscraperGoogleMaps({
      clientId: client.id,
      idempotencyKey: `json-${suffix}`,
      records: jsonRecords,
      sourceReference: jsonPath,
      defaultCountryCallingCode: '1',
    });
    assertEqual(jsonResult.status, 'completed', 'JSON import status');
    assertEqual(jsonResult.newBusinesses, 1, 'JSON import creates canonical business');
    assert(jsonResult.signalsCreated >= 9, 'JSON import reports qualification signals');

    const business = await db.prospectBusiness.findFirstOrThrow({
      where: { clientId: client.id, googlePlaceId: 'ChIJphase3triangle' },
      include: { leads: { include: { signals: true } }, sourceRecords: true },
    });
    assertEqual(business.normalizedDomain, 'triangle-emergency.example', 'website normalized');
    assertEqual(business.normalizedPhone, '+19195550142', 'phone normalized');
    assertEqual(business.googleCid, '9876543210123456789', 'CID mapped');
    assertEqual(business.category, 'Plumber', 'category mapped');
    assert(
      isDeepStrictEqual(business.sourceRecords[0]?.rawPayload, jsonRecords[0]),
      'raw evidence retained',
    );

    const signals = business.leads[0]?.signals ?? [];
    const keys = adapterModule.OUTSCRAPER_SIGNAL_KEYS;
    const reviewSignal = signals.find((candidate) => candidate.key === keys.GOOGLE_REVIEW_COUNT);
    assertEqual(reviewSignal?.numberValue?.toNumber(), 237, 'review count signal');
    const alwaysOpen = signals.find((candidate) => candidate.key === keys.IS_24_HOUR);
    assertEqual(alwaysOpen?.booleanValue, true, '24-hour signal derived');
    const evidence = alwaysOpen?.evidence as { origin?: string; sourceFields?: string[] } | null;
    assertEqual(evidence?.origin, 'DERIVED', '24-hour derivation is explicit');
    assert(
      evidence?.sourceFields?.includes('working_hours'),
      'working hours evidence is referenced',
    );
    assertEqual(
      signals.find((candidate) => candidate.key === keys.AREA_SERVICE_BUSINESS)?.booleanValue,
      true,
      'area-service signal',
    );
    assertEqual(
      signals.find((candidate) => candidate.key === keys.HAS_APPOINTMENT_LINK)?.booleanValue,
      true,
      'appointment signal',
    );

    const csvPath = path.join(fixtureDirectory, 'google-maps-results.csv');
    const csvRecords = fileParser.parseOutscraperFileContents(
      csvPath,
      await readFile(csvPath, 'utf8'),
    );
    assertEqual(csvRecords.length, 1, 'CSV record parsed');
    const csvResult = await importer.importOutscraperGoogleMaps({
      clientId: client.id,
      idempotencyKey: `csv-${suffix}`,
      records: csvRecords,
      sourceReference: csvPath,
      defaultCountryCallingCode: '1',
    });
    assertEqual(csvResult.newBusinesses, 1, 'CSV import creates canonical business');
    const csvBusiness = await db.prospectBusiness.findFirstOrThrow({
      where: { clientId: client.id, googlePlaceId: 'ChIJphase3oak' },
      include: { leads: { include: { signals: true } } },
    });
    assertEqual(csvBusiness.normalizedPhone, '+19195550164', 'CSV phone normalized');
    assertEqual(
      csvBusiness.leads[0]?.signals.find((candidate) => candidate.key === keys.IS_24_HOUR)
        ?.booleanValue,
      false,
      'non-24-hour schedule is derived as false',
    );

    const duplicate = await importer.importOutscraperGoogleMaps({
      clientId: client.id,
      idempotencyKey: `duplicate-${suffix}`,
      records: jsonRecords,
      defaultCountryCallingCode: '1',
    });
    assertEqual(duplicate.duplicates, 1, 'repeat source payload is idempotent');
    assertEqual(duplicate.signalsCreated, 0, 'duplicate creates no signal observations');

    const changed = structuredClone(jsonRecords) as Array<Record<string, unknown>>;
    changed[0]!.reviews = 251;
    const update = await importer.importOutscraperGoogleMaps({
      clientId: client.id,
      idempotencyKey: `update-${suffix}`,
      records: changed,
      defaultCountryCallingCode: '1',
    });
    assertEqual(update.updatedBusinesses, 1, 'changed Outscraper record updates canonical entity');
    assert(update.signalsCreated >= 9, 'changed record stores a new signal observation set');
    assertEqual(
      await db.leadSignal.count({
        where: { clientId: client.id, key: keys.GOOGLE_REVIEW_COUNT },
      }),
      3,
      'review-count signal history includes both businesses and updated observation',
    );

    const rejected = await importer.importOutscraperGoogleMaps({
      clientId: client.id,
      idempotencyKey: `rejected-${suffix}`,
      records: [{ place_id: 'missing-name' }],
    });
    assertEqual(rejected.invalid, 1, 'malformed Outscraper record rejected');
    assertEqual(
      await db.ingestionError.count({ where: { ingestionRunId: rejected.runId } }),
      1,
      'rejection appears in ingestion reporting',
    );

    const aliasRecord = {
      name: 'Alias Field Plumbing',
      place_id: `alias-${suffix}`,
      site: 'https://alias-field.example',
      full_address: '12 Alias Ave, Raleigh, NC 27601',
      reviews_count: '88',
      is_verified: 'yes',
      is_area_service_business: 1,
      appointment_url: 'https://alias-field.example/book',
    };
    const aliasResult = await importer.importFromOutscraperSource(
      {
        sourceReference: 'outscraper-api:test-job',
        fetchResults: () => Promise.resolve([aliasRecord]),
      },
      {
        clientId: client.id,
        idempotencyKey: `source-abstraction-${suffix}`,
        defaultCountryCallingCode: '1',
      },
    );
    assertEqual(aliasResult.newBusinesses, 1, 'programmatic result source imports records');
    const aliasBusiness = await db.prospectBusiness.findFirstOrThrow({
      where: { clientId: client.id, googlePlaceId: aliasRecord.place_id },
      include: { leads: { include: { signals: true } } },
    });
    assertEqual(aliasBusiness.website, aliasRecord.site, 'site alias maps to website');
    assertEqual(aliasBusiness.addressLine1, aliasRecord.full_address, 'full-address alias maps');
    const aliasSignals = aliasBusiness.leads[0]?.signals ?? [];
    assertEqual(
      aliasSignals
        .find((candidate) => candidate.key === keys.GOOGLE_REVIEW_COUNT)
        ?.numberValue?.toNumber(),
      88,
      'reviews_count alias maps to review signal',
    );
    assertEqual(
      aliasSignals.find((candidate) => candidate.key === keys.GOOGLE_VERIFIED)?.booleanValue,
      true,
      'is_verified alias maps to verified signal',
    );

    process.stdout.write(
      `Lead Intelligence Phase 3 Outscraper tests passed (${jsonResult.signalsCreated + csvResult.signalsCreated} initial signals).\n`,
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
