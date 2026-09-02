import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:54329/steel_scale';
  const { withRetry, mapConcurrent } = await import('../src/lead-intelligence/pipeline/retry.js');
  let attempts = 0;
  const retried = await withRetry(
    () => {
      attempts += 1;
      return attempts < 3
        ? Promise.reject(new Error('temporary provider failure'))
        : Promise.resolve('recovered');
    },
    { attempts: 3, initialDelayMs: 1, maximumDelayMs: 1 },
    () => Promise.resolve(),
  );
  assert(retried === 'recovered' && attempts === 3, 'provider retry should recover');
  let active = 0;
  let maximumActive = 0;
  await mapConcurrent([1, 2, 3, 4, 5], 2, async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
  });
  assert(maximumActive === 2, 'bounded worker pool should honor concurrency');

  const { parsePipelineCampaigns } = await import('../src/lead-intelligence/pipeline/scheduler.js');
  const campaigns = parsePipelineCampaigns(
    JSON.stringify([
      {
        key: 'voice-ai-restoration-pa',
        clientId: randomUUID(),
        source: 'outscraper_google_maps',
        discovery: {
          kind: 'outscraper_google_maps',
          keywords: ['water damage restoration', 'fire damage restoration', 'mold remediation'],
          locations: ['Pittsburgh PA', 'Philadelphia PA', 'Harrisburg PA', 'Erie PA'],
          maximumResults: 500,
          minimumReviews: 10,
          states: ['PA'],
        },
      },
    ]),
  );
  assert(campaigns[0]?.discovery.kind === 'outscraper_google_maps', 'campaign config parses');
  if (process.argv.includes('--unit-only')) {
    process.stdout.write('Lead Intelligence Phase 9 unit tests passed.\n');
    return;
  }

  const [{ runLeadIntelligencePipeline }, { parseOutscraperJson }, { db }] = await Promise.all([
    import('../src/lead-intelligence/pipeline/orchestrator.js'),
    import('../src/lead-intelligence/integrations/outscraper-files.js'),
    import('../src/db/client.js'),
  ]);
  const records = parseOutscraperJson(
    await readFile('scripts/fixtures/outscraper/google-maps-results.json', 'utf8'),
  );
  const record = {
    ...(records[0] as Record<string, unknown>),
    site: undefined,
    website: undefined,
  };
  const suffix = randomUUID().slice(0, 8);
  const client = await db.client.create({
    data: {
      businessName: `Phase 9 Pipeline ${suffix}`,
      phoneNumber: `+1571${String(Date.now()).slice(-7)}`,
      timezone: 'America/New_York',
      services: ['Testing'],
    },
  });
  try {
    const campaign = {
      ...campaigns[0],
      clientId: client.id,
      key: `phase-9-${suffix}`,
      reviewScoreThreshold: 0,
      retry: { attempts: 2, initialDelayMs: 1, maximumDelayMs: 1 },
    };
    let discoveryAttempts = 0;
    const provider = {
      discover: () => {
        discoveryAttempts += 1;
        return discoveryAttempts === 1
          ? Promise.reject(new Error('isolated provider timeout'))
          : Promise.resolve({ records: [record], sourceReference: `fixture:${suffix}` });
      },
    };
    const idempotencyKey = `phase-9:${suffix}`;
    const result = await runLeadIntelligencePipeline(
      campaign,
      { providers: { outscraper_google_maps: provider } },
      idempotencyKey,
    );
    assert(discoveryAttempts === 2, 'discovery retries are configurable');
    assert(result.recordsDiscovered === 1, 'record should be discovered');
    assert(result.recordsImported === 1, 'record should be canonically imported');
    assert(result.scored === 1, 'affected lead should be scored');
    assert(result.queuedForReview === 1, 'qualified lead should be queued for human review');
    const snapshots = await db.scoreSnapshot.count({ where: { clientId: client.id } });
    const repeated = await runLeadIntelligencePipeline(
      campaign,
      { providers: { outscraper_google_maps: provider } },
      idempotencyKey,
    );
    assert(repeated.runId === result.runId, 'completed pipeline rerun should reuse durable run');
    assert(
      (await db.scoreSnapshot.count({ where: { clientId: client.id } })) === snapshots,
      'idempotent rerun must not create another score',
    );
    const stored = await db.pipelineRun.findUniqueOrThrow({ where: { id: result.runId } });
    assert(stored.scored === 1 && stored.completedAt, 'pipeline execution should be fully tracked');
    process.stdout.write('Lead Intelligence Phase 9 pipeline tests passed.\n');
  } finally {
    await db.client.delete({ where: { id: client.id } });
    await db.$disconnect();
  }
}

void run();
