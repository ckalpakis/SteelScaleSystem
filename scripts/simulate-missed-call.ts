import { once } from 'node:events';

async function simulate(): Promise<void> {
  process.env.TWILIO_SMS_DRY_RUN = 'true';

  const { app } = await import('../src/app.js');
  const { db } = await import('../src/db/client.js');
  const { logger } = await import('../src/utils/logger.js');
  const callSid = `CA_TEST_${Date.now()}`;
  const server = app.listen(0, '127.0.0.1');

  try {
    await once(server, 'listening');
    const address = server.address();

    if (!address || typeof address === 'string') throw new Error('Simulator server did not bind');

    const payload = new URLSearchParams({
      CallSid: callSid,
      CallStatus: 'no-answer',
      From: '+15558675309',
      To: '+15550102030',
      CallDuration: '0',
    });

    const response = await fetch(`http://127.0.0.1:${address.port}/webhooks/twilio/voice-status`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: payload,
    });

    if (response.status !== 204) {
      throw new Error(`Expected webhook status 204, received ${response.status}`);
    }

    const callLog = await db.callLog.findUnique({ where: { providerCallId: callSid } });

    if (!callLog) throw new Error('Webhook returned successfully but no CallLog was created');

    logger.info({ callLog }, 'Missed-call simulation succeeded');
  } finally {
    server.close();
    await db.$disconnect();
  }
}

simulate().catch((error: unknown) => {
  // Logger imports depend on successful application initialization.
  process.stderr.write(`Missed-call simulation failed: ${String(error)}\n`);
  process.exitCode = 1;
});
