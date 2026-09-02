import { readFile } from 'node:fs/promises';
import path from 'node:path';

interface Arguments {
  clientId: string;
  file: string;
  idempotencyKey: string;
  countryCode?: string;
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
  const file = options.get('--file');
  const idempotencyKey = options.get('--idempotency-key');
  if (!clientId || !file || !idempotencyKey) {
    throw new Error(
      'Usage: npm run import:outscraper -- --client-id <uuid> --file <result.json|result.csv> --idempotency-key <unique-key> [--country-code 1]',
    );
  }
  return { clientId, file, idempotencyKey, countryCode: options.get('--country-code') };
}

async function run(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const absoluteFile = path.resolve(args.file);
  const [{ parseOutscraperFileContents }, { importOutscraperGoogleMaps }, { db }] =
    await Promise.all([
      import('../src/lead-intelligence/integrations/outscraper-files.js'),
      import('../src/lead-intelligence/integrations/outscraper-import.js'),
      import('../src/db/client.js'),
    ]);
  try {
    const records = parseOutscraperFileContents(absoluteFile, await readFile(absoluteFile, 'utf8'));
    const result = await importOutscraperGoogleMaps({
      clientId: args.clientId,
      idempotencyKey: args.idempotencyKey,
      records,
      sourceReference: absoluteFile,
      defaultCountryCallingCode: args.countryCode,
      metadata: { importType: path.extname(absoluteFile).slice(1).toLowerCase() },
    });
    process.stdout.write(
      [
        'Outscraper import complete',
        '',
        `Run: ${result.runId}`,
        `Status: ${result.status}`,
        `Records: ${result.received.toLocaleString()}`,
        `Created businesses: ${result.newBusinesses.toLocaleString()}`,
        `Existing businesses updated: ${result.updatedBusinesses.toLocaleString()}`,
        `Duplicates: ${result.duplicates.toLocaleString()}`,
        `Rejected: ${(result.invalid + result.failed).toLocaleString()}`,
        `Signals created/updated: ${(result.signalsCreated + result.signalsUpdated).toLocaleString()}`,
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
