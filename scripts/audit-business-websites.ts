interface Arguments {
  clientId: string;
  concurrency?: number;
  limit?: number;
  staleHours?: number;
}

function positiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseArguments(values: string[]): Arguments {
  const options = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error(`Invalid argument near ${key ?? 'end'}`);
    options.set(key, value);
  }
  const clientId = options.get('--client-id');
  if (!clientId) {
    throw new Error(
      'Usage: npm run audit:websites -- --client-id <uuid> [--concurrency 3] [--limit 100] [--stale-hours 720]',
    );
  }
  return {
    clientId,
    concurrency: positiveInteger(options.get('--concurrency'), 'concurrency'),
    limit: positiveInteger(options.get('--limit'), 'limit'),
    staleHours: positiveInteger(options.get('--stale-hours'), 'stale-hours'),
  };
}

async function run(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const [{ auditStaleBusinessWebsites }, { db }] = await Promise.all([
    import('../src/lead-intelligence/enrichment/website-audit.js'),
    import('../src/db/client.js'),
  ]);
  try {
    const result = await auditStaleBusinessWebsites({
      clientId: args.clientId,
      concurrency: args.concurrency,
      limit: args.limit,
      staleBefore:
        args.staleHours === undefined
          ? undefined
          : new Date(Date.now() - args.staleHours * 60 * 60 * 1_000),
    });
    process.stdout.write(
      [
        'Website Intelligence audit complete',
        '',
        `Considered: ${result.considered.toLocaleString()}`,
        `Completed: ${result.completed.toLocaleString()}`,
        `Failed: ${result.failed.toLocaleString()}`,
        `Skipped fresh: ${result.skippedFresh.toLocaleString()}`,
        `Pages crawled: ${result.pagesCrawled.toLocaleString()}`,
        `Signals stored: ${result.signalsCreated.toLocaleString()}`,
      ].join('\n') + '\n',
    );
  } finally {
    await db.$disconnect();
  }
}

void run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
