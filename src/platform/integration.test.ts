/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registrations. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import type { Server } from 'node:http';
import type { PrismaClient } from '@prisma/client';
import { requireDemoTestDatabase } from '../demo-engine/test-database.js';
let backgroundOnce: typeof import('./background.js').backgroundOnce;
let enqueueBackground: typeof import('./background.js').enqueueBackground;
let enqueueLegacySms: typeof import('./background.js').enqueueLegacySms;
import { databaseReady, healthRoutes } from './health.js';

requireDemoTestDatabase();
Object.assign(process.env, {
  LOG_LEVEL: 'silent',
  DURABLE_BACKGROUND_ENABLED: 'true',
  TWILIO_SMS_DRY_RUN: 'true',
  BOOKING_DELIVERY_DRY_RUN: 'true',
  OPENAI_API_KEY: '',
  ANTHROPIC_API_KEY: '',
  LLM_PROVIDER: 'mock',
  ADMIN_USERNAME: 'operator',
  ADMIN_PASSWORD: 'test-operator-password',
  CRON_SECRET: 'test-cron-secret',
  WORKFORCE_ENABLED: 'false',
  COMMUNICATIONS_ENABLED: 'false',
  DEMO_ENGINE_ENABLED: 'false',
});
let db: PrismaClient;
before(async () => {
  db = (await import('../db/client.js')).db;
  ({ backgroundOnce, enqueueBackground, enqueueLegacySms } = await import('./background.js'));
});
after(async () => {
  await db.$disconnect();
});
async function fixture() {
  const client = await db.client.create({
    data: {
      businessName: 'Deployment fixture',
      phoneNumber: `+19${String(Date.now()).slice(-9)}${Math.floor(Math.random() * 10)}`,
      timezone: 'UTC',
      services: [],
    },
  });
  const org = await db.organization.create({
    data: { name: 'Deployment tenant', legacyClientId: client.id },
  });
  return { client, org };
}
test('legacy pipeline enqueue stays in the database and restart reconciliation closes the outbox gap', async () => {
  const { client } = await fixture();
  const { enqueueLeadIntelligencePipeline } =
    await import('../lead-intelligence/pipeline/background.js');
  const { reconcilePendingPipelines } = await import('./background.js');
  const campaign = {
    key: randomUUID(),
    clientId: client.id,
    source: 'outscraper_google_maps' as const,
    discovery: {
      kind: 'outscraper_google_maps' as const,
      keywords: ['service'],
      locations: ['Test'],
      maximumResults: 1,
    },
  };
  const key = randomUUID();
  const id = await enqueueLeadIntelligencePipeline(campaign, key);
  assert.equal(await enqueueLeadIntelligencePipeline(campaign, key), id);
  await assert.rejects(enqueueLeadIntelligencePipeline({ ...campaign, key: 'changed' }, key));
  assert.equal((await db.pipelineRun.findUniqueOrThrow({ where: { id } })).status, 'pending');
  const interrupted = await db.pipelineRun.create({
    data: {
      clientId: client.id,
      source: campaign.source,
      campaignKey: campaign.key,
      idempotencyKey: randomUUID(),
      configuration: campaign,
      status: 'pending',
    },
  });
  await reconcilePendingPipelines(db);
  await reconcilePendingPipelines(db);
  assert.equal(
    await db.backgroundTask.count({ where: { clientId: client.id, kind: 'lead_pipeline' } }),
    2,
  );
  await db.backgroundTask.updateMany({ where: { clientId: client.id }, data: { status: 'dead' } });
  await db.pipelineRun.updateMany({
    where: { id: { in: [id, interrupted.id] } },
    data: { status: 'failed' },
  });
});
test('execution rejects a mismatched tenant link before invoking any legacy provider', async () => {
  const a = await fixture(),
    b = await fixture();
  const task = await enqueueLegacySms(db, {
    messageSid: randomUUID(),
    from: '+12025550101',
    to: a.client.phoneNumber,
    body: 'fixture',
  });
  const mismatched = await db.backgroundTask.update({
    where: { id: task!.id },
    data: { organizationId: b.org.id },
  });
  const { executeBackground } = await import('./background.js');
  await assert.rejects(executeBackground(db, mismatched), /tenant mismatch/);
  await db.backgroundTask.update({ where: { id: mismatched.id }, data: { status: 'dead' } });
});
test('durable enqueue is tenant scoped, deduplicates concurrent retries, rejects changed payload', async () => {
  const a = await fixture(),
    b = await fixture();
  const key = randomUUID();
  const tasks = await Promise.all(
    Array.from({ length: 4 }, () =>
      enqueueBackground(db, 'legacy_sms', key, { body: 'private' }, a.client.id),
    ),
  );
  assert.equal(new Set(tasks.map((t) => t.id)).size, 1);
  assert.equal(tasks[0]!.organizationId, a.org.id);
  const other = await enqueueBackground(db, 'legacy_sms', key, { body: 'private' }, b.client.id);
  assert.notEqual(other.id, tasks[0]!.id);
  await assert.rejects(enqueueBackground(db, 'legacy_sms', key, { body: 'changed' }, a.client.id));
  await db.backgroundTask.updateMany({
    where: { id: { in: [...tasks.map((t) => t.id), other.id] } },
    data: { status: 'dead' },
  });
});
test('concurrent worker claims execute once, completion redacts payload and replay still deduplicates', async () => {
  const key = randomUUID();
  const task = await enqueueBackground(db, 'daily_summary', key, { private: 'fixture' });
  let executed = 0;
  const execute = () => {
    executed++;
    return Promise.resolve();
  };
  await Promise.all([backgroundOnce(db, execute), backgroundOnce(db, execute)]);
  assert.equal(executed, 1);
  const stored = await db.backgroundTask.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(stored.status, 'completed');
  assert.deepEqual(stored.payload, {});
  assert.equal(
    (await enqueueBackground(db, 'daily_summary', key, { private: 'fixture' })).id,
    task.id,
  );
});
test('expired or failed legacy side effects become visible unknowns and are never automatically replayed', async () => {
  const expired = await enqueueBackground(db, 'daily_summary', randomUUID(), {});
  await db.backgroundTask.update({
    where: { id: expired.id },
    data: { status: 'running', attempts: 1, leaseToken: randomUUID(), leasedUntil: new Date(0) },
  });
  const failed = await enqueueBackground(db, 'daily_summary', randomUUID(), {});
  let calls = 0;
  await backgroundOnce(db, () => {
    calls++;
    return Promise.reject(new Error('secret provider body'));
  });
  await backgroundOnce(db, () => {
    calls++;
    return Promise.resolve();
  });
  assert.equal(calls, 1);
  for (const task of [expired, failed]) {
    const row = await db.backgroundTask.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(row.status, 'unknown');
    assert.ok(!JSON.stringify(row).includes('secret provider body'));
  }
});
test('due time survives worker recreation and future jobs are not sent early', async () => {
  const task = await enqueueBackground(db, 'daily_summary', randomUUID(), {});
  const future = new Date(Date.now() + 3600000);
  await db.backgroundTask.update({ where: { id: task.id }, data: { availableAt: future } });
  let calls = 0;
  const execute = () => {
    calls++;
    return Promise.resolve();
  };
  await backgroundOnce(db, execute);
  assert.equal(calls, 0);
  const { PrismaClient } = await import('@prisma/client');
  const restarted = new PrismaClient();
  try {
    await backgroundOnce(restarted, execute, future);
    assert.equal(calls, 1);
  } finally {
    await restarted.$disconnect();
  }
});
test('legacy ingress maps destination to Client and SQL rejects unscoped customer jobs', async () => {
  const { client, org } = await fixture();
  const task = await enqueueLegacySms(db, {
    messageSid: randomUUID(),
    from: '+12025550101',
    to: client.phoneNumber,
    body: 'STOP',
  });
  assert.equal(task?.organizationId, org.id);
  assert.equal(task?.clientId, client.id);
  await assert.rejects(
    db.backgroundTask.create({
      data: {
        kind: 'legacy_sms',
        key: randomUUID(),
        payload: {},
        payloadHash: 'test',
        correlationId: randomUUID(),
      },
    }),
  );
  await db.backgroundTask.update({ where: { id: task.id }, data: { status: 'dead' } });
});
async function serve(app: express.Express) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, url: `http://127.0.0.1:${address.port}` };
}
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));
test('readiness checks migrations/database, distinguishes liveness and stops traffic while draining', async () => {
  await databaseReady(db);
  let live = true;
  const app = express();
  app.use(
    healthRoutes(
      () => Promise.reject(new Error('private database URL')),
      () => live,
    ),
  );
  const { server, url } = await serve(app);
  try {
    assert.equal((await fetch(`${url}/health`)).status, 200);
    const ready = await fetch(`${url}/ready`);
    assert.equal(ready.status, 503);
    assert.ok(!(await ready.text()).includes('private'));
    live = false;
    assert.equal((await fetch(`${url}/health`)).status, 503);
  } finally {
    await close(server);
  }
});
test('operator visibility requires platform authentication and never returns private job bodies', async () => {
  const { app } = await import('../app.js');
  const { server, url } = await serve(app);
  try {
    assert.equal((await fetch(`${url}/admin/operations`)).status, 401);
    const result = await fetch(`${url}/admin/operations`, {
      headers: {
        authorization: `Basic ${Buffer.from('operator:test-operator-password').toString('base64')}`,
      },
    });
    assert.equal(result.status, 200);
    const text = await result.text();
    assert.ok(text.includes('background'));
    assert.ok(!text.includes('payloadHash'));
    assert.ok(!text.includes('private'));
    assert.equal((await fetch(`${url}/ready`)).status, 200);
  } finally {
    await close(server);
  }
});
test('authenticated cron requests acknowledge durable tasks and duplicate requests do not repeat work', async () => {
  const { app } = await import('../app.js');
  const { server, url } = await serve(app);
  try {
    assert.equal(
      (await fetch(`${url}/internal/cron/daily-summary`, { method: 'POST' })).status,
      401,
    );
    const request = () =>
      fetch(`${url}/internal/cron/daily-summary`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-cron-secret' },
      });
    const first = await request(),
      second = await request();
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    const task = (await first.json()) as { jobId: string };
    assert.equal(((await second.json()) as { jobId: string }).jobId, task.jobId);
    await db.backgroundTask.update({ where: { id: task.jobId }, data: { status: 'dead' } });
  } finally {
    await close(server);
  }
});
