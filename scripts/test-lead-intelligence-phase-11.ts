import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

import { DeliveryDestination, IntelligenceOffer, ProspectCallStatus } from '@prisma/client';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:54329/steel_scale';
  process.env.ADMIN_USERNAME = 'phase-11-admin';
  process.env.ADMIN_PASSWORD = 'phase-11-password';
  const [{ db }, queueService, metricsService, { app }] = await Promise.all([
    import('../src/db/client.js'),
    import('../src/lead-intelligence/call-queue/service.js'),
    import('../src/lead-intelligence/call-queue/metrics.js'),
    import('../src/app.js'),
  ]);
  const suffix = randomUUID().slice(0, 8);
  const now = new Date();
  const client = await db.client.create({
    data: {
      businessName: `Phase 11 Calls ${suffix}`,
      phoneNumber: `+1404${String(Date.now()).slice(-7)}`,
      timezone: 'America/New_York',
      services: ['Testing'],
    },
  });
  try {
    const business = await db.prospectBusiness.create({
      data: {
        clientId: client.id,
        name: `ABC Restoration ${suffix}`,
        normalizedName: `abc restoration ${suffix}`,
        phone: '+14125550123',
        normalizedPhone: '+14125550123',
        website: 'https://abc-restoration.example',
        niche: 'water restoration',
      },
    });
    const lead = await db.lead.create({ data: { clientId: client.id, businessId: business.id } });
    await db.leadSignal.createMany({
      data: [
        {
          clientId: client.id,
          leadId: lead.id,
          key: 'mentions_emergency',
          value: true,
          booleanValue: true,
          provider: 'fixture',
          observedAt: now,
        },
        {
          clientId: client.id,
          leadId: lead.id,
          key: 'mentions_24_7',
          value: true,
          booleanValue: true,
          provider: 'fixture',
          observedAt: now,
        },
      ],
    });
    const score = await db.scoreSnapshot.create({
      data: {
        clientId: client.id,
        leadId: lead.id,
        offer: IntelligenceOffer.VOICE_AI,
        score: 94,
        rulesetVersion: 'voice-ai-v1',
        inputAsOf: now,
        factors: {
          create: [
            {
              key: 'REVIEWS',
              label: '246 Google reviews',
              points: 20,
              ruleVersion: 'voice-ai-v1',
              position: 0,
            },
            {
              key: 'EMERGENCY',
              label: 'Emergency restoration',
              points: 15,
              ruleVersion: 'voice-ai-v1',
              position: 1,
            },
            {
              key: 'OPEN_24',
              label: 'Advertises 24/7',
              points: 15,
              ruleVersion: 'voice-ai-v1',
              position: 2,
            },
          ],
        },
      },
    });
    const campaign = await db.deliveryCampaign.create({
      data: {
        clientId: client.id,
        campaignKey: `calls-${suffix}`,
        name: 'Restoration calls',
        offer: IntelligenceOffer.VOICE_AI,
        destination: DeliveryDestination.CALL_QUEUE,
        criteria: { minimumScore: 75 },
        payloadVersion: 'qualified-lead-v1',
      },
    });
    const delivery = await db.deliveryRecord.create({
      data: {
        clientId: client.id,
        leadId: lead.id,
        campaignId: campaign.id,
        destination: DeliveryDestination.CALL_QUEUE,
        status: 'delivered',
        payloadVersion: 'qualified-lead-v1',
        payload: { scoreSnapshotId: score.id },
        deliveredAt: now,
      },
    });
    const entry = await db.callQueueEntry.create({
      data: {
        clientId: client.id,
        leadId: lead.id,
        campaignId: campaign.id,
        deliveryRecordId: delivery.id,
      },
    });
    const ranked = await queueService.getRankedCallQueue({ clientId: client.id, now });
    assert(ranked[0]?.score === 94, 'queue uses primary offer score');
    assert(ranked[0]?.reasons.includes('246 Google reviews'), 'queue explains why to call');
    assert(
      ranked[0]?.angle === 'After-hours lead capture',
      'signals produce a relevant pitch angle',
    );
    await queueService.setCallQueuePriority(entry.id, 12);
    assert(
      (await queueService.getRankedCallQueue({ clientId: client.id, now }))[0]?.manualPriority ===
        12,
      'manual priority affects queue',
    );
    await queueService.recordCallAttempt({
      queueEntryId: entry.id,
      status: ProspectCallStatus.interested,
      notes: 'Owner wants a demo',
      occurredAt: now,
    });
    const metrics = await metricsService.getCallPerformance({ clientId: client.id, now });
    assert(
      metrics.callsToday === 1 && metrics.ownersReached === 1 && metrics.interested === 1,
      'call outcome metrics are retained',
    );
    assert(metrics.byNiche[0]?.label === 'water restoration', 'conversion is grouped by niche');
    const server = createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      assert(address && typeof address !== 'string', 'admin test server failed');
      const baseUrl = `http://127.0.0.1:${address.port}`;
      assert(
        (await fetch(`${baseUrl}/admin/call-queue`)).status === 401,
        'call queue uses existing admin auth',
      );
      const authorization = `Basic ${Buffer.from('phase-11-admin:phase-11-password').toString('base64')}`;
      const response = await fetch(`${baseUrl}/admin/call-queue`, { headers: { authorization } });
      const html = await response.text();
      assert(
        response.status === 200 && html.includes(`ABC Restoration ${suffix}`),
        'protected call desk renders ranked prospect',
      );
      assert(html.includes('Conversion by pitch angle'), 'performance feedback renders');
    } finally {
      server.close();
      await once(server, 'close');
    }
    await queueService.recordCallAttempt({
      queueEntryId: entry.id,
      status: ProspectCallStatus.do_not_contact,
      notes: 'Requested no further contact',
    });
    assert(
      (await db.leadContactPermission.findUniqueOrThrow({ where: { leadId: lead.id } }))
        .doNotContact,
      'do-not-contact outcome updates compliance state',
    );
    process.stdout.write('Lead Intelligence Phase 11 call queue tests passed.\n');
  } finally {
    await db.client.delete({ where: { id: client.id } });
    await db.$disconnect();
  }
}

void run();
