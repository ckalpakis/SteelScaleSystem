import { createServer } from 'node:http';
import { once } from 'node:events';

async function testDailySummary(): Promise<void> {
  process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:54329/steel_scale';
  process.env.CRON_SECRET = 'daily-summary-test-secret';
  let slackPayload = '';
  const slackServer = createServer((request, response) => {
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      slackPayload += chunk;
    });
    request.on('end', () => response.writeHead(200).end('ok'));
  });
  slackServer.listen(0, '127.0.0.1');
  await once(slackServer, 'listening');
  const slackAddress = slackServer.address();
  if (!slackAddress || typeof slackAddress === 'string') throw new Error('Slack mock failed');
  process.env.SLACK_WEBHOOK_URL = `http://127.0.0.1:${slackAddress.port}/slack`;

  const { app } = await import('../src/app.js');
  const { db } = await import('../src/db/client.js');
  const appServer = app.listen(0, '127.0.0.1');

  try {
    await once(appServer, 'listening');
    const address = appServer.address();
    if (!address || typeof address === 'string') throw new Error('App server failed');
    const url = `http://127.0.0.1:${address.port}/internal/cron/daily-summary`;
    const unauthorized = await fetch(url, { method: 'POST' });
    if (unauthorized.status !== 401) throw new Error('Cron route did not reject missing secret');
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer daily-summary-test-secret' },
    });
    const body = (await response.json()) as {
      totalCalls?: number;
      missedCalls?: number;
      bookings?: number;
      failedBookingAttempts?: unknown[];
      slackSent?: boolean;
    };
    if (
      response.status !== 200 ||
      !body.slackSent ||
      typeof body.totalCalls !== 'number' ||
      typeof body.missedCalls !== 'number' ||
      typeof body.bookings !== 'number' ||
      !Array.isArray(body.failedBookingAttempts) ||
      !slackPayload.includes('Steel Scale daily summary')
    ) {
      throw new Error(`Daily summary assertions failed: ${JSON.stringify(body)}`);
    }
    console.log('Daily summary smoke test passed: auth, metrics, and Slack delivery succeeded.');
  } finally {
    appServer.close();
    slackServer.close();
    await Promise.all([once(appServer, 'close'), once(slackServer, 'close')]);
    await db.$disconnect();
  }
}

void testDailySummary();
