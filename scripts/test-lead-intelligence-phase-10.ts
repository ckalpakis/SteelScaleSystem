import { randomUUID } from 'node:crypto';

import { ConsentStatus, DeliveryDestination, IntelligenceOffer } from '@prisma/client';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:54329/steel_scale';
  const [{ db }, delivery, permissions] = await Promise.all([
    import('../src/db/client.js'),
    import('../src/lead-intelligence/delivery/service.js'),
    import('../src/lead-intelligence/delivery/permissions.js'),
  ]);
  const suffix = randomUUID().slice(0, 8);
  const client = await db.client.create({
    data: {
      businessName: `Phase 10 Delivery ${suffix}`,
      phoneNumber: `+1585${String(Date.now()).slice(-7)}`,
      timezone: 'America/New_York',
      services: ['Testing'],
    },
  });
  try {
    const business = await db.prospectBusiness.create({
      data: {
        clientId: client.id,
        name: `Qualified Restoration ${suffix}`,
        normalizedName: `qualified restoration ${suffix}`,
        phone: '+14125550123',
        normalizedPhone: '+14125550123',
        niche: 'water restoration',
      },
    });
    const voiceLead = await db.lead.create({
      data: { clientId: client.id, businessId: business.id },
    });
    await db.scoreSnapshot.create({
      data: {
        clientId: client.id,
        leadId: voiceLead.id,
        offer: IntelligenceOffer.VOICE_AI,
        score: 84,
        rulesetVersion: 'voice-ai-v1',
        inputAsOf: new Date(),
      },
    });
    const voiceCampaign = await delivery.createDeliveryCampaign({
      clientId: client.id,
      campaignKey: `voice-call-${suffix}`,
      name: 'Voice AI manual call queue',
      offer: IntelligenceOffer.VOICE_AI,
      destination: DeliveryDestination.CALL_QUEUE,
      criteria: { minimumScore: 75, requirePhone: true, notContactedWithinDays: 30 },
    });
    const first = await delivery.deliverQualifiedLeads({ campaignId: voiceCampaign.id });
    assert(first.delivered === 1, 'qualified Voice AI lead enters call queue');
    const permission = await db.leadContactPermission.findUniqueOrThrow({
      where: { leadId: voiceLead.id },
    });
    assert(permission.manualCallCandidate, 'call queue records manual-call candidacy');
    assert(!permission.smsEligible, 'scraped phone does not imply SMS eligibility');
    const repeated = await delivery.deliverQualifiedLeads({ campaignId: voiceCampaign.id });
    assert(repeated.delivered === 0, 'campaign idempotency prevents accidental redelivery');
    assert(
      (await db.deliveryRecord.count({ where: { campaignId: voiceCampaign.id } })) === 1,
      'one delivery record per campaign and lead',
    );

    await permissions.recordLeadContactPermission({
      leadId: voiceLead.id,
      smsConsent: ConsentStatus.granted,
      consentSource: 'verbal permission on manual call',
      updatedBy: 'phase-10-test',
    });
    assert(
      (await db.leadContactPermission.findUniqueOrThrow({ where: { leadId: voiceLead.id } }))
        .smsEligible,
      'documented permission enables SMS eligibility separately',
    );
    await permissions.recordLeadContactPermission({
      leadId: voiceLead.id,
      smsConsent: ConsentStatus.opted_out,
      recordedAt: new Date(),
      updatedBy: 'phase-10-test',
    });
    assert(
      !(await db.leadContactPermission.findUniqueOrThrow({ where: { leadId: voiceLead.id } }))
        .smsEligible,
      'opt-out immediately removes SMS eligibility',
    );

    const agentLead = await db.lead.create({ data: { clientId: client.id } });
    const agent = await db.realEstateAgent.create({
      data: {
        clientId: client.id,
        leadId: agentLead.id,
        fullName: `Jordan Agent ${suffix}`,
        normalizedName: `jordan agent ${suffix}`,
        email: `jordan-${suffix}@example.test`,
      },
    });
    await db.realEstateListing.create({
      data: {
        clientId: client.id,
        leadId: agentLead.id,
        agentId: agent.id,
        provider: 'phase_10_fixture',
        externalId: `listing-${suffix}`,
        address: '123 New Listing Way',
        listedAt: new Date(Date.now() - 2 * 86_400_000),
        status: 'ACTIVE',
        rawPayload: { fixture: true },
      },
    });
    await db.scoreSnapshot.create({
      data: {
        clientId: client.id,
        leadId: agentLead.id,
        offer: IntelligenceOffer.REAL_ESTATE_VIDEO,
        score: 91,
        rulesetVersion: 'real-estate-video-v1',
        inputAsOf: new Date(),
      },
    });
    const csvCampaign = await delivery.createDeliveryCampaign({
      clientId: client.id,
      campaignKey: `realtor-csv-${suffix}`,
      name: 'New realtor listings',
      offer: IntelligenceOffer.REAL_ESTATE_VIDEO,
      destination: DeliveryDestination.CSV_EXPORT,
      criteria: { minimumScore: 75, maximumListingAgeDays: 7, requireApprovedContactChannel: true },
    });
    const csv = await delivery.deliverQualifiedLeads({ campaignId: csvCampaign.id });
    assert(
      csv.delivered === 1 && csv.csv?.includes('123 New Listing Way'),
      'fresh qualified listing exports to CSV',
    );
    assert(csv.csv?.includes('"false"'), 'CSV explicitly reports that SMS is not eligible');
    process.stdout.write('Lead Intelligence Phase 10 delivery integration tests passed.\n');
  } finally {
    await db.client.delete({ where: { id: client.id } });
    await db.$disconnect();
  }
}

void run();
