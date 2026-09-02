import { once } from 'node:events';

async function simulate(): Promise<void> {
  process.env.LLM_PROVIDER = 'mock';
  process.env.BOOKING_DELIVERY_DRY_RUN = 'true';
  const { app } = await import('../src/app.js');
  const { db } = await import('../src/db/client.js');
  const { logger } = await import('../src/utils/logger.js');
  const client = await db.client.findUniqueOrThrow({ where: { phoneNumber: '+15550102030' } });
  const sessionId = `chat-test-${Date.now()}`;
  const server = app.listen(0, '127.0.0.1');

  try {
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Simulator server did not bind');
    const response = await fetch(`http://127.0.0.1:${address.port}/chatbot/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: client.id,
        session_id: sessionId,
        message: '/test-booking',
      }),
    });
    const responseBody: unknown = await response.json();
    if (!response.ok)
      throw new Error(`Chatbot returned ${response.status}: ${JSON.stringify(responseBody)}`);

    const session = await db.chatSession.findUniqueOrThrow({
      where: { clientId_sessionKey: { clientId: client.id, sessionKey: sessionId } },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    const bookingAttempt = await db.bookingAttempt.findFirstOrThrow({
      where: { clientId: client.id, source: 'chatbot' },
      orderBy: { createdAt: 'desc' },
    });

    logger.info(
      {
        fakeClientId: client.id,
        widgetScript: `<script src="http://localhost:3000/widget/chatbot-widget.js" data-client-id="${client.id}"></script>`,
        responseBody,
        session,
        bookingAttempt,
      },
      'Chatbot booking simulation succeeded',
    );
  } finally {
    server.close();
    await db.$disconnect();
  }
}

simulate().catch((error: unknown) => {
  process.stderr.write(`Chatbot booking simulation failed: ${String(error)}\n`);
  process.exitCode = 1;
});
