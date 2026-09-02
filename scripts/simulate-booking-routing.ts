import { createServer } from 'node:http';
import { once } from 'node:events';

async function simulate(): Promise<void> {
  let zapierRequests = 0;
  let successfulZapierRequests = 0;
  let contactRequests = 0;
  let appointmentRequests = 0;
  let slackAlerts = 0;
  let rejectGhlAppointment = false;
  const externalServer = createServer((request, response) => {
    if (request.url === '/zapier') {
      zapierRequests += 1;
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Intentional test failure' }));
      return;
    }
    if (request.url === '/zapier-success') {
      successfulZapierRequests += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'success' }));
      return;
    }
    if (request.url === '/contacts/upsert') {
      contactRequests += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ contact: { id: 'test-contact-001' }, new: true }));
      return;
    }
    if (request.url === '/calendars/events/appointments') {
      appointmentRequests += 1;
      if (rejectGhlAppointment) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'Intentional GHL failure' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'test-appointment-001' }));
      return;
    }
    if (request.url === '/slack') {
      slackAlerts += 1;
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
      return;
    }
    response.writeHead(404).end();
  });
  externalServer.listen(0, '127.0.0.1');
  await once(externalServer, 'listening');
  const externalAddress = externalServer.address();
  if (!externalAddress || typeof externalAddress === 'string')
    throw new Error('Mock server failed');

  process.env.BOOKING_DELIVERY_DRY_RUN = 'false';
  process.env.GHL_API_KEY = 'test-ghl-token';
  process.env.GHL_LOCATION_ID = 'test-location-001';
  process.env.GHL_FALLBACK_CALENDAR_ID = 'test-safety-calendar-001';
  process.env.GHL_API_BASE_URL = `http://127.0.0.1:${externalAddress.port}`;
  process.env.SLACK_WEBHOOK_URL = `http://127.0.0.1:${externalAddress.port}/slack`;

  const { app } = await import('../src/app.js');
  const { db } = await import('../src/db/client.js');
  const { logger } = await import('../src/utils/logger.js');
  const client = await db.client.findUniqueOrThrow({
    where: { phoneNumber: '+15550102030' },
    include: { destination: true },
  });
  if (!client.destination) throw new Error('Seeded client has no destination');
  const originalDestination = { ...client.destination };
  await db.clientDestination.update({
    where: { id: client.destination.id },
    data: {
      destinationType: 'zapier',
      zapierWebhookUrl: `http://127.0.0.1:${externalAddress.port}/zapier`,
    },
  });
  const appServer = app.listen(0, '127.0.0.1');

  try {
    await once(appServer, 'listening');
    const appAddress = appServer.address();
    if (!appAddress || typeof appAddress === 'string') throw new Error('App server failed');
    const response = await fetch(`http://127.0.0.1:${appAddress.port}/internal/bookings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: client.id,
        caller_name: 'Jamie Routing Test',
        caller_phone: '+15558675309',
        address: '123 Test Street, Raleigh, NC 27601',
        requested_service: 'HVAC repair',
        preferred_datetime: '2027-01-15T10:00:00-05:00',
        source: 'chatbot',
      }),
    });
    const body = (await response.json()) as { bookingAttemptId?: string; accepted?: boolean };
    if (response.status !== 201 || !body.accepted || !body.bookingAttemptId) {
      throw new Error(`Unexpected booking response ${response.status}: ${JSON.stringify(body)}`);
    }
    const attempt = await db.bookingAttempt.findUniqueOrThrow({
      where: { id: body.bookingAttemptId },
    });
    if (
      zapierRequests !== 2 ||
      contactRequests !== 1 ||
      appointmentRequests !== 1 ||
      attempt.status !== 'success' ||
      !attempt.fallbackUsed ||
      !attempt.manualFollowUpRequired ||
      attempt.deliveredDestinationType !== 'ghl_fallback'
    ) {
      throw new Error('Retry/fallback assertions failed');
    }

    await db.clientDestination.update({
      where: { id: client.destination.id },
      data: { zapierWebhookUrl: `http://127.0.0.1:${externalAddress.port}/zapier-success` },
    });
    const primaryResponse = await fetch(`http://127.0.0.1:${appAddress.port}/internal/bookings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: client.id,
        caller_name: 'Taylor Primary Test',
        caller_phone: '+15558675310',
        requested_service: 'Electrical repair',
        preferred_datetime: '2027-01-16T14:00:00-05:00',
        source: 'voice',
      }),
    });
    const primaryBody = (await primaryResponse.json()) as {
      bookingAttemptId?: string;
      accepted?: boolean;
    };
    if (primaryResponse.status !== 201 || !primaryBody.accepted || !primaryBody.bookingAttemptId) {
      throw new Error(
        `Unexpected primary response ${primaryResponse.status}: ${JSON.stringify(primaryBody)}`,
      );
    }
    const primaryAttempt = await db.bookingAttempt.findUniqueOrThrow({
      where: { id: primaryBody.bookingAttemptId },
    });
    if (
      successfulZapierRequests !== 1 ||
      primaryAttempt.status !== 'success' ||
      primaryAttempt.fallbackUsed ||
      primaryAttempt.manualFollowUpRequired ||
      primaryAttempt.deliveredDestinationType !== 'zapier'
    ) {
      throw new Error('Primary Zapier success assertions failed');
    }

    rejectGhlAppointment = true;
    await db.clientDestination.update({
      where: { id: client.destination.id },
      data: { zapierWebhookUrl: `http://127.0.0.1:${externalAddress.port}/zapier` },
    });
    const failedResponse = await fetch(`http://127.0.0.1:${appAddress.port}/internal/bookings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: client.id,
        caller_name: 'Morgan Failure Test',
        caller_phone: '+15558675311',
        requested_service: 'Plumbing repair',
        preferred_datetime: '2027-01-17T09:00:00-05:00',
        source: 'chatbot',
      }),
    });
    const failedBody = (await failedResponse.json()) as {
      bookingAttemptId?: string;
      accepted?: boolean;
    };
    if (failedResponse.status !== 502 || failedBody.accepted || !failedBody.bookingAttemptId) {
      throw new Error(
        `Unexpected failed response ${failedResponse.status}: ${JSON.stringify(failedBody)}`,
      );
    }
    const failedAttempt = await db.bookingAttempt.findUniqueOrThrow({
      where: { id: failedBody.bookingAttemptId },
    });
    if (
      failedAttempt.status !== 'failed' ||
      !failedAttempt.manualFollowUpRequired ||
      slackAlerts !== 1
    ) {
      throw new Error('Total delivery failure assertions failed');
    }
    logger.info(
      {
        fallbackResponse: body,
        primaryResponse: primaryBody,
        failedResponse: failedBody,
        zapierRequests,
        successfulZapierRequests,
        contactRequests,
        appointmentRequests,
        slackAlerts,
        fallbackAttempt: attempt,
        primaryAttempt,
        failedAttempt,
      },
      'Booking primary and GHL safety-net simulations succeeded',
    );
  } finally {
    appServer.close();
    externalServer.close();
    await db.clientDestination.update({
      where: { id: originalDestination.id },
      data: {
        destinationType: originalDestination.destinationType,
        zapierWebhookUrl: originalDestination.zapierWebhookUrl,
        ghlCalendarId: originalDestination.ghlCalendarId,
      },
    });
    await db.$disconnect();
  }
}

simulate().catch((error: unknown) => {
  process.stderr.write(`Booking routing simulation failed: ${String(error)}\n`);
  process.exitCode = 1;
});
