import { once } from 'node:events';

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as Record<string, unknown>;
  if (!response.ok)
    throw new Error(`Webhook returned ${response.status}: ${JSON.stringify(result)}`);
  return result;
}

async function simulate(): Promise<void> {
  process.env.BOOKING_DELIVERY_DRY_RUN = 'true';
  process.env.TWILIO_SMS_DRY_RUN = 'true';
  const { app } = await import('../src/app.js');
  const { db } = await import('../src/db/client.js');
  const { logger } = await import('../src/utils/logger.js');
  const callId = `vapi-call-test-${Date.now()}`;
  const failedTransferCallId = `vapi-transfer-test-${Date.now()}`;
  const toolCallId = `vapi-tool-test-${Date.now()}`;
  const server = app.listen(0, '127.0.0.1');

  try {
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Simulator server did not bind');
    const webhookUrl = `http://127.0.0.1:${address.port}/webhooks/vapi`;
    const call = {
      id: callId,
      assistantId: 'vapi_agent_test_001',
      phoneNumberId: 'vapi_phone_test_001',
      customer: { number: '+15558675309' },
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      endedAt: new Date().toISOString(),
    };

    const assistantResponse = await postJson(webhookUrl, {
      message: {
        type: 'assistant-request',
        phoneNumber: { id: 'vapi_phone_test_001', number: '+15550102030' },
      },
    });
    if (!assistantResponse.assistant) throw new Error('Dynamic assistant was not returned');
    const assistant = assistantResponse.assistant as Record<string, unknown>;
    const model = assistant.model as Record<string, unknown>;
    const tools = model.tools as Array<Record<string, unknown>>;
    const transferTool = tools.find((tool) => tool.type === 'transferCall');
    if (!transferTool) throw new Error('Owner transfer tool was not returned');
    const destinations = transferTool.destinations as Array<Record<string, unknown>>;
    if (destinations[0]?.number !== '+15550102031') {
      throw new Error('Owner transfer destination was not configured correctly');
    }

    await postJson(webhookUrl, {
      message: { type: 'status-update', status: 'in-progress', call },
    });

    const toolResponse = await postJson(webhookUrl, {
      message: {
        type: 'tool-calls',
        call,
        toolCallList: [
          {
            id: toolCallId,
            name: 'create_booking',
            arguments: {
              customerName: 'Jamie Test',
              phoneNumber: '+15558675309',
              address: '123 Test Street, Raleigh, NC 27601',
              service: 'HVAC repair',
              preferredTime: '2027-01-15T10:00:00-05:00',
            },
          },
        ],
      },
    });

    await postJson(webhookUrl, {
      message: { type: 'end-of-call-report', endedReason: 'customer-ended-call', call },
    });

    const bookingAttempt = await db.bookingAttempt.findUnique({
      where: { providerRequestId: toolCallId },
    });
    const callLog = await db.callLog.findUnique({ where: { providerCallId: callId } });
    const ownerNotification = bookingAttempt
      ? await db.ownerNotification.findUnique({
          where: {
            clientId_notificationType_eventKey: {
              clientId: bookingAttempt.clientId,
              notificationType: 'booking_success',
              eventKey: bookingAttempt.id,
            },
          },
        })
      : null;
    if (!bookingAttempt || !callLog || ownerNotification?.status !== 'sent') {
      throw new Error('Expected booking, call, and owner notification records were not created');
    }

    await postJson(webhookUrl, {
      message: {
        type: 'end-of-call-report',
        endedReason: 'call.in-progress.error-transfer-failed',
        call: { ...call, id: failedTransferCallId },
      },
    });
    const transferNotification = await db.ownerNotification.findFirst({
      where: { notificationType: 'transfer_failure', eventKey: failedTransferCallId },
    });
    if (transferNotification?.status !== 'sent') {
      throw new Error('Failed transfer did not notify the owner');
    }

    logger.info(
      { assistantResponse, toolResponse, bookingAttempt, callLog },
      'Vapi booking simulation succeeded',
    );
  } finally {
    server.close();
    await db.$disconnect();
  }
}

simulate().catch((error: unknown) => {
  process.stderr.write(`Vapi booking simulation failed: ${String(error)}\n`);
  process.exitCode = 1;
});
