import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

import { IntelligenceOffer } from '@prisma/client';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:54329/steel_scale';
  process.env.ADMIN_USERNAME = 'phase-8-admin';
  process.env.ADMIN_PASSWORD = 'phase-8-password';

  const [{ app }, { db }] = await Promise.all([
    import('../src/app.js'),
    import('../src/db/client.js'),
  ]);
  const suffix = randomUUID().slice(0, 8);
  const client = await db.client.create({
    data: {
      businessName: `Phase 8 Admin Test ${suffix}`,
      phoneNumber: `+1561${String(Date.now()).slice(-7)}`,
      timezone: 'America/New_York',
      services: ['Testing'],
    },
  });
  const business = await db.prospectBusiness.create({
    data: {
      clientId: client.id,
      name: `Beacon Restoration ${suffix}`,
      normalizedName: `beacon restoration ${suffix}`,
      phone: '+19195550199',
      normalizedPhone: '+19195550199',
      website: 'https://beacon.example',
      normalizedDomain: 'beacon.example',
      city: 'Raleigh',
      state: 'NC',
      normalizedCity: 'raleigh',
      normalizedState: 'nc',
      niche: 'water restoration',
      category: 'Water damage restoration service',
    },
  });
  const lead = await db.lead.create({
    data: { clientId: client.id, businessId: business.id },
  });
  const score = await db.scoreSnapshot.create({
    data: {
      clientId: client.id,
      leadId: lead.id,
      offer: IntelligenceOffer.VOICE_AI,
      score: 92,
      rulesetVersion: 'voice-ai-v1',
      inputAsOf: new Date(),
      factors: {
        create: [
          {
            key: 'GOOGLE_REVIEWS',
            label: '237 Google reviews',
            points: 20,
            ruleVersion: 'voice-ai-v1',
            position: 0,
          },
          {
            key: 'EMERGENCY_SERVICE',
            label: 'Emergency service',
            points: 15,
            ruleVersion: 'voice-ai-v1',
            position: 1,
          },
        ],
      },
    },
  });
  await db.offerRecommendation.create({
    data: {
      clientId: client.id,
      leadId: lead.id,
      offer: IntelligenceOffer.VOICE_AI,
      rank: 1,
      recommended: true,
      reason: {
        confidence: 0.94,
        reasons: ['Emergency service offered', '237 Google reviews'],
      },
      scoreSnapshotId: score.id,
      recommendationVersion: 'offer-recommendation-v1',
    },
  });
  await db.leadSignal.createMany({
    data: [
      {
        clientId: client.id,
        leadId: lead.id,
        key: 'google_review_count',
        value: 237,
        numberValue: 237,
        provider: 'outscraper',
        confidence: 0.99,
        observedAt: new Date(),
      },
      {
        clientId: client.id,
        leadId: lead.id,
        key: 'mentions_emergency',
        value: true,
        booleanValue: true,
        provider: 'website_audit',
        confidence: 0.95,
        observedAt: new Date(),
      },
      {
        clientId: client.id,
        leadId: lead.id,
        key: 'has_chatbot',
        value: false,
        booleanValue: false,
        provider: 'website_audit',
        confidence: 0.9,
        observedAt: new Date(),
      },
    ],
  });

  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string', 'test server did not bind');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const authorization = `Basic ${Buffer.from('phase-8-admin:phase-8-password').toString('base64')}`;

    const unauthorized = await fetch(`${baseUrl}/admin/leads`);
    assert(unauthorized.status === 401, 'Lead Intelligence must use protected admin auth');

    const dashboard = await fetch(`${baseUrl}/admin/leads?offer=VOICE_AI&state=NC`, {
      headers: { authorization },
    });
    const dashboardHtml = await dashboard.text();
    assert(dashboard.status === 200, 'dashboard should render');
    assert(dashboardHtml.includes(`Beacon Restoration ${suffix}`), 'prospect row should render');
    assert(dashboardHtml.includes('Hot prospects'), 'top metrics should render');
    assert(dashboardHtml.includes('Not contacted only'), 'prospecting filters should render');

    const detail = await fetch(`${baseUrl}/admin/leads/${lead.id}`, {
      headers: { authorization },
    });
    const detailHtml = await detail.text();
    assert(detailHtml.includes('Why this prospect qualifies'), 'score explanation should render');
    assert(detailHtml.includes('237 Google reviews'), 'score evidence should render');
    assert(detailHtml.includes('Website intelligence'), 'website intelligence should render');
    assert(detailHtml.includes('Mark contacted'), 'safe admin actions should render');

    const contacted = await fetch(`${baseUrl}/admin/leads/${lead.id}/contacted`, {
      method: 'POST',
      headers: { authorization },
      redirect: 'manual',
    });
    assert(contacted.status === 303, 'mark contacted should redirect after mutation');
    const outreach = await db.leadOutreachState.findUnique({ where: { leadId: lead.id } });
    assert(outreach?.disposition === 'contacted', 'mark contacted should persist state');

    const exported = await fetch(`${baseUrl}/admin/leads/export.csv?clientId=${client.id}`, {
      headers: { authorization },
    });
    assert(
      (await exported.text()).includes(`Beacon Restoration ${suffix}`),
      'CSV export should include the prospect',
    );
    process.stdout.write('Lead Intelligence Phase 8 admin UI test passed.\n');
  } finally {
    server.close();
    await once(server, 'close');
    await db.client.delete({ where: { id: client.id } });
    await db.$disconnect();
  }
}

void run();
