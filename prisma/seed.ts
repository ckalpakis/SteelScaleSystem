import { DestinationType, PrismaClient, VoiceProvider } from '@prisma/client';

import { logger } from '../src/utils/logger.js';

const db = new PrismaClient();

async function seed(): Promise<void> {
  const client = await db.client.upsert({
    where: { phoneNumber: '+15550102030' },
    update: {
      businessName: 'Acme Home Services',
      timezone: 'America/New_York',
      services: ['HVAC', 'Plumbing', 'Electrical'],
      missedCallSmsTemplate:
        "Hey, sorry we missed your call! This is {business_name} — reply here and we'll get you booked in.",
      ownerNotificationNumber: '+15550102032',
    },
    create: {
      id: '00000000-0000-4000-8000-000000000001',
      businessName: 'Acme Home Services',
      phoneNumber: '+15550102030',
      timezone: 'America/New_York',
      services: ['HVAC', 'Plumbing', 'Electrical'],
      missedCallSmsTemplate:
        "Hey, sorry we missed your call! This is {business_name} — reply here and we'll get you booked in.",
      ownerNotificationNumber: '+15550102032',
    },
  });

  await db.clientDestination.upsert({
    where: { clientId: client.id },
    update: {
      destinationType: DestinationType.zapier,
      zapierWebhookUrl: 'https://hooks.zapier.com/hooks/catch/example/test-client',
      ghlCalendarId: null,
    },
    create: {
      clientId: client.id,
      destinationType: DestinationType.zapier,
      zapierWebhookUrl: 'https://hooks.zapier.com/hooks/catch/example/test-client',
    },
  });

  await db.voiceAgentConfig.upsert({
    where: { clientId: client.id },
    update: {
      provider: VoiceProvider.vapi,
      agentId: 'vapi_agent_test_001',
      phoneNumberId: 'vapi_phone_test_001',
      ownerTransferNumber: '+15550102031',
      ownerTransferMode: 'blind-transfer',
      systemPrompt:
        'You are the helpful phone agent for {business_name}. Services offered: {services}. Greet the caller, confirm what they need, and collect their full name, callback phone number, service address, requested service, and preferred appointment time. Read the details back for confirmation. Only after the caller confirms, call the create_booking tool. Never claim the booking is confirmed unless the tool returns accepted.',
    },
    create: {
      clientId: client.id,
      provider: VoiceProvider.vapi,
      agentId: 'vapi_agent_test_001',
      phoneNumberId: 'vapi_phone_test_001',
      ownerTransferNumber: '+15550102031',
      ownerTransferMode: 'blind-transfer',
      systemPrompt:
        'You are the helpful phone agent for {business_name}. Services offered: {services}. Greet the caller, confirm what they need, and collect their full name, callback phone number, service address, requested service, and preferred appointment time. Read the details back for confirmation. Only after the caller confirms, call the create_booking tool. Never claim the booking is confirmed unless the tool returns accepted.',
    },
  });

  const seededClient = await db.client.findUniqueOrThrow({
    where: { id: client.id },
    include: { destination: true, voiceAgentConfig: true },
  });

  logger.info({ client: seededClient }, 'Test client seeded');
}

seed()
  .catch((error: unknown) => {
    logger.error({ error }, 'Database seed failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
