import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { WebsiteFetcher, WebsitePage } from '../src/lead-intelligence/enrichment/types.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

class FixtureFetcher implements WebsiteFetcher {
  readonly requests: string[] = [];

  constructor(
    private readonly pages: Map<string, string>,
    private readonly failure?: Error,
  ) {}

  fetchPage(url: string, allowedDomain: string): Promise<WebsitePage> {
    this.requests.push(url);
    if (this.failure) return Promise.reject(this.failure);
    const parsed = new URL(url);
    assertEqual(allowedDomain, 'example.test', 'normalized domain is passed to fetcher');
    const html = this.pages.get(parsed.pathname);
    if (html === undefined)
      return Promise.reject(new Error(`Missing fixture for ${parsed.pathname}`));
    return Promise.resolve({
      requestedUrl: url,
      finalUrl: parsed.toString(),
      statusCode: 200,
      html,
      attempts: 1,
    });
  }
}

async function fixture(name: string): Promise<string> {
  return readFile(path.resolve('scripts/fixtures/websites', name), 'utf8');
}

async function run(): Promise<void> {
  process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:54329/steel_scale';
  const [{ db }, detector, fetchSafety, auditModule] = await Promise.all([
    import('../src/db/client.js'),
    import('../src/lead-intelligence/enrichment/detector.js'),
    import('../src/lead-intelligence/enrichment/http-fetcher.js'),
    import('../src/lead-intelligence/enrichment/website-audit.js'),
  ]);
  const [chatbotHtml, providersHtml, phoneHtml, contactHtml, discoveryHtml] = await Promise.all([
    fixture('chatbot-ghl.html'),
    fixture('booking-providers.html'),
    fixture('phone-emergency-social.html'),
    fixture('contact-form.html'),
    fixture('discovery-home.html'),
  ]);

  const page = (html: string, pathname: string): WebsitePage => ({
    requestedUrl: `https://example.test${pathname}`,
    finalUrl: `https://example.test${pathname}`,
    statusCode: 200,
    html,
    attempts: 1,
  });
  const detections = detector.detectWebsiteSignals([
    page(chatbotHtml, '/'),
    page(providersHtml, '/schedule'),
    page(phoneHtml, '/services'),
    page(contactHtml, '/contact'),
  ]);
  const detected = new Map(detections.map((item) => [item.key, item]));
  const expectedTrue = [
    detector.WEBSITE_SIGNAL_KEYS.HAS_CHATBOT,
    detector.WEBSITE_SIGNAL_KEYS.HAS_GHL_WIDGET,
    detector.WEBSITE_SIGNAL_KEYS.HAS_ONLINE_BOOKING,
    detector.WEBSITE_SIGNAL_KEYS.HAS_CONTACT_FORM,
    detector.WEBSITE_SIGNAL_KEYS.HAS_VISIBLE_PHONE,
    detector.WEBSITE_SIGNAL_KEYS.HAS_CLICK_TO_CALL,
    detector.WEBSITE_SIGNAL_KEYS.MENTIONS_24_7,
    detector.WEBSITE_SIGNAL_KEYS.MENTIONS_EMERGENCY,
    detector.WEBSITE_SIGNAL_KEYS.MENTIONS_SAME_DAY,
    detector.WEBSITE_SIGNAL_KEYS.MENTIONS_FREE_ESTIMATE,
    detector.WEBSITE_SIGNAL_KEYS.HAS_FACEBOOK,
    detector.WEBSITE_SIGNAL_KEYS.HAS_INSTAGRAM,
    detector.WEBSITE_SIGNAL_KEYS.HAS_TIKTOK,
    detector.WEBSITE_SIGNAL_KEYS.HAS_GOOGLE_ANALYTICS,
    detector.WEBSITE_SIGNAL_KEYS.HAS_HOUSECALL_PRO,
    detector.WEBSITE_SIGNAL_KEYS.HAS_JOBBER,
    detector.WEBSITE_SIGNAL_KEYS.HAS_SERVICETITAN,
    detector.WEBSITE_SIGNAL_KEYS.HAS_CALENDLY,
    detector.WEBSITE_SIGNAL_KEYS.HAS_GHL_BOOKING,
  ];
  for (const key of expectedTrue) assertEqual(detected.get(key)?.result, true, `${key} detected`);
  assertEqual(
    detected.get(detector.WEBSITE_SIGNAL_KEYS.HAS_OTHER_BOOKING_PROVIDER)?.result,
    false,
    'named providers are not mislabeled as other provider',
  );
  const emptyChatbot = detector
    .detectWebsiteSignals([page('<html><body>Plain site</body></html>', '/')])
    .find(({ key }) => key === detector.WEBSITE_SIGNAL_KEYS.HAS_CHATBOT);
  assertEqual(emptyChatbot?.result, false, 'no chatbot artifact produces a negative observation');
  assert(
    (emptyChatbot?.metadata.limitation as string | undefined)?.includes('not definitive'),
    'negative chatbot evidence records its limitation',
  );

  const discovered = detector.discoverAuditPages(page(discoveryHtml, '/'), 'example.test', 3);
  assertEqual(discovered.length, 2, 'crawl discovery is bounded by max pages');
  assert(
    discovered.every((url) => new URL(url).hostname === 'example.test'),
    'crawl stays on domain',
  );
  assert(
    discovered.some((url) => new URL(url).pathname === '/contact'),
    'contact page discovered',
  );
  assert(
    discovered.some((url) => new URL(url).pathname === '/schedule'),
    'booking page discovered',
  );
  assertEqual(
    fetchSafety.normalizeAuditUrl('example.test').toString(),
    'https://example.test/',
    'URL normalized',
  );
  assert(fetchSafety.isPrivateAddress('127.0.0.1'), 'loopback is private');
  assert(fetchSafety.isPrivateAddress('10.2.3.4'), 'private IPv4 is rejected');
  assert(!fetchSafety.isPrivateAddress('8.8.8.8'), 'public IPv4 is accepted');
  assert(
    !fetchSafety.isAllowedBusinessDomain('example.test.evil.invalid', 'example.test'),
    'lookalike domain is rejected',
  );

  const suffix = randomUUID().slice(0, 8);
  const client = await db.client.create({
    data: {
      businessName: `Website Intelligence Test ${suffix}`,
      phoneNumber: `+1558${String(Date.now()).slice(-7)}`,
      timezone: 'America/New_York',
      services: ['Testing'],
    },
  });
  try {
    const business = await db.prospectBusiness.create({
      data: {
        clientId: client.id,
        name: 'Fixture Plumbing',
        normalizedName: 'fixture plumbing',
        website: 'https://example.test',
        normalizedDomain: 'example.test',
      },
    });
    const lead = await db.lead.create({ data: { clientId: client.id, businessId: business.id } });
    const fixtureFetcher = new FixtureFetcher(
      new Map([
        ['/', discoveryHtml + chatbotHtml + phoneHtml],
        ['/schedule', providersHtml],
        ['/contact', contactHtml],
      ]),
    );
    const observedAt = new Date('2026-09-02T12:00:00.000Z');
    const result = await auditModule.auditBusinessWebsite({
      businessId: business.id,
      idempotencyKey: `success-${suffix}`,
      fetcher: fixtureFetcher,
      observedAt,
    });
    assertEqual(result.status, 'completed', 'fixture audit completes');
    assertEqual(result.pagesCrawled, 3, 'homepage plus two relevant pages audited');
    assertEqual(fixtureFetcher.requests.length, 3, 'crawler does not exceed page limit');
    const audit = await db.websiteAudit.findUniqueOrThrow({ where: { id: result.auditId } });
    assertEqual(audit.businessId, business.id, 'audit history links canonical business');
    assertEqual(audit.enrichmentRunId, result.enrichmentRunId, 'audit links enrichment run');
    assertEqual(audit.status, 'completed', 'successful audit history stored');
    assertEqual(
      audit.observedAt.toISOString(),
      observedAt.toISOString(),
      'observation time stored',
    );
    const storedBusiness = await db.prospectBusiness.findUniqueOrThrow({
      where: { id: business.id },
    });
    assertEqual(
      storedBusiness.websiteLastAuditedAt?.toISOString(),
      observedAt.toISOString(),
      'last audited timestamp updated',
    );
    const storedSignals = await db.leadSignal.findMany({
      where: { leadId: lead.id, provider: 'website_intelligence' },
    });
    assertEqual(storedSignals.length, result.signalsCreated, 'canonical lead signals persisted');
    const chatbot = storedSignals.find(
      ({ key }) => key === detector.WEBSITE_SIGNAL_KEYS.HAS_CHATBOT,
    );
    assertEqual(chatbot?.booleanValue, true, 'chatbot signal persisted');
    const evidence = chatbot?.evidence as { auditId?: string; evidenceUrl?: string } | null;
    assertEqual(evidence?.auditId, audit.id, 'signal evidence links audit history');
    assert(evidence?.evidenceUrl?.startsWith('https://example.test'), 'signal evidence URL stored');
    const repeated = await auditModule.auditBusinessWebsite({
      businessId: business.id,
      idempotencyKey: `success-${suffix}`,
      fetcher: new FixtureFetcher(new Map()),
      observedAt,
    });
    assertEqual(repeated.auditId, result.auditId, 'same idempotency key reuses audit');

    const failedBusiness = await db.prospectBusiness.create({
      data: {
        clientId: client.id,
        name: 'Unreachable Plumbing',
        normalizedName: 'unreachable plumbing',
        website: 'https://unreachable.example',
        normalizedDomain: 'unreachable.example',
      },
    });
    const failedLead = await db.lead.create({
      data: { clientId: client.id, businessId: failedBusiness.id },
    });
    const failed = await auditModule.auditBusinessWebsite({
      businessId: failedBusiness.id,
      idempotencyKey: `failed-${suffix}`,
      fetcher: new FixtureFetcher(new Map(), new Error('simulated timeout')),
      observedAt: new Date('2026-08-01T12:00:00.000Z'),
    });
    assertEqual(failed.status, 'failed', 'unreachable website is isolated as failed audit');
    assert(failed.error?.includes('simulated timeout'), 'failure reason returned');
    const unreachableSignal = await db.leadSignal.findFirst({
      where: {
        leadId: failedLead.id,
        key: detector.WEBSITE_SIGNAL_KEYS.WEBSITE_REACHABLE,
      },
      orderBy: { observedAt: 'desc' },
    });
    assertEqual(unreachableSignal?.booleanValue, false, 'unreachable signal recorded');
    const bookingAttempts = await db.bookingAttempt.count({ where: { clientId: client.id } });
    const callLogs = await db.callLog.count({ where: { clientId: client.id } });
    assertEqual(bookingAttempts, 0, 'website failure does not enter booking infrastructure');
    assertEqual(callLogs, 0, 'website failure does not enter voice infrastructure');

    const batch = await auditModule.auditStaleBusinessWebsites({
      clientId: client.id,
      staleBefore: new Date('2026-09-01T00:00:00.000Z'),
      fetcher: new FixtureFetcher(new Map(), new Error('batch failure')),
    });
    assertEqual(batch.considered, 1, 'stale batch skips fresh successful audit');
    assertEqual(batch.skippedFresh, 1, 'fresh audit reported as skipped');
    assertEqual(batch.failed, 1, 'batch contains failure without throwing');

    process.stdout.write(
      `Lead Intelligence Phase 4 tests passed (${result.signalsCreated} website signals stored).\n`,
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
