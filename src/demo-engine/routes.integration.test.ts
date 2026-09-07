/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registrations are intentionally top-level. */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { requireDemoTestDatabase } from './test-database.js';

requireDemoTestDatabase();

process.env.ADMIN_USERNAME = 'demo-integration-admin';
process.env.ADMIN_PASSWORD = 'demo-integration-password';
process.env.DEMO_ENGINE_ENABLED = 'true';

const authorization = `Basic ${Buffer.from(
  `${process.env.ADMIN_USERNAME}:${process.env.ADMIN_PASSWORD}`,
).toString('base64')}`;
const adminHeaders = { authorization };
let server: Server;
let baseUrl = '';
let db: (typeof import('../db/client.js'))['db'];
let standaloneId = '';
let standaloneToken = '';

async function html(
  path: string,
  init?: RequestInit,
): Promise<{ response: Response; body: string }> {
  const response = await fetch(`${baseUrl}${path}`, init);
  return { response, body: await response.text() };
}

function hidden(page: string, name: string): string {
  const match = page.match(new RegExp(`name="${name}" value="([^"]+)"`));
  assert.ok(match?.[1], `Missing hidden field ${name}`);
  return match[1];
}

function form(values: Record<string, string>): URLSearchParams {
  return new URLSearchParams(values);
}

before(async () => {
  const modules = await Promise.all([import('../app.js'), import('../db/client.js')]);
  db = modules[1].db;
  await db.salesDemoEvent.deleteMany();
  await db.salesDemo.deleteMany();
  server = createServer(modules[0].app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  server.close();
  await once(server, 'close');
  await db.salesDemoEvent.deleteMany();
  await db.salesDemo.deleteMany();
  await db.client.deleteMany({ where: { phoneNumber: '+15550009991' } });
  await db.$disconnect();
});

test('feature flag and admin authentication fail closed before database work', async () => {
  process.env.DEMO_ENGINE_ENABLED = 'false';
  const disabledAdmin = await fetch(`${baseUrl}/admin/demos`);
  const disabledPublic = await fetch(`${baseUrl}/demo/${'a'.repeat(64)}`);
  assert.equal(disabledAdmin.status, 404);
  assert.equal(disabledPublic.status, 404);
  process.env.DEMO_ENGINE_ENABLED = 'true';

  assert.equal((await fetch(`${baseUrl}/admin/demos`)).status, 401);
  assert.equal(
    (
      await fetch(`${baseUrl}/admin/demos`, {
        method: 'POST',
        body: form({ businessName: 'No auth' }),
      })
    ).status,
    401,
  );
  assert.equal(await db.salesDemo.count(), 0);
});

test('CSRF rejects missing, modified, and wrong-action tokens', async () => {
  const page = await html('/admin/demos/new', { headers: adminHeaders });
  assert.equal(page.response.status, 200);
  const csrf = hidden(page.body, 'csrf');
  const requestId = hidden(page.body, 'requestId');
  const common = {
    requestId,
    businessName: 'CSRF Test',
    niche: 'plumbing',
    selectionMode: 'recommended',
  };
  for (const token of ['', `${csrf}x`]) {
    const response = await fetch(`${baseUrl}/admin/demos`, {
      method: 'POST',
      headers: adminHeaders,
      body: form({ ...common, csrf: token }),
      redirect: 'manual',
    });
    assert.equal(response.status, 400);
  }
  const wrongActionPage = await html('/admin/demos/new', { headers: adminHeaders });
  const id = randomUUID();
  const response = await fetch(`${baseUrl}/admin/demos/${id}/publish`, {
    method: 'POST',
    headers: adminHeaders,
    body: form({
      csrf: hidden(wrongActionPage.body, 'csrf'),
      version: '1',
      reviewed: 'on',
      days: '45',
    }),
    redirect: 'manual',
  });
  assert.equal(response.status, 400);
  assert.equal(await db.salesDemo.count(), 0);
});

test('standalone creation is concurrent-idempotent and creates no production records', async () => {
  const countsBefore = {
    clients: await db.client.count(),
    calls: await db.callLog.count(),
    bookings: await db.bookingAttempt.count(),
    chats: await db.chatSession.count(),
    outreach: await db.outreachActivity.count(),
    leads: await db.lead.count(),
  };
  const page = await html('/admin/demos/new', { headers: adminHeaders });
  const payload = form({
    csrf: hidden(page.body, 'csrf'),
    requestId: hidden(page.body, 'requestId'),
    businessName: 'Private Sentinel Plumbing',
    niche: 'plumbing',
    selectionMode: 'recommended',
    salesNotes: 'PRIVATE_SENTINEL_NOT_PUBLIC',
    businessPhone: '+15550001111',
  });
  const requests = Array.from({ length: 8 }, () =>
    fetch(`${baseUrl}/admin/demos`, {
      method: 'POST',
      headers: adminHeaders,
      body: payload,
      redirect: 'manual',
    }),
  );
  const responses = await Promise.all(requests);
  assert.ok(responses.every((response) => response.status === 303));
  assert.equal(await db.salesDemo.count(), 1);
  const demo = await db.salesDemo.findFirstOrThrow();
  standaloneId = demo.id;
  standaloneToken = demo.shareToken;
  assert.equal(demo.prospectBusinessId, null);
  assert.equal(demo.status, 'draft');
  assert.equal(await db.client.count(), countsBefore.clients);
  assert.equal(await db.callLog.count(), countsBefore.calls);
  assert.equal(await db.bookingAttempt.count(), countsBefore.bookings);
  assert.equal(await db.chatSession.count(), countsBefore.chats);
  assert.equal(await db.outreachActivity.count(), countsBefore.outreach);
  assert.equal(await db.lead.count(), countsBefore.leads);
});

test('draft is private, admin preview does not track, and secrets do not leak', async () => {
  assert.equal((await fetch(`${baseUrl}/demo/${standaloneToken}`)).status, 404);
  const preview = await html(`/admin/demos/${standaloneId}/preview`, { headers: adminHeaders });
  assert.equal(preview.response.status, 200);
  assert.match(preview.body, /PRIVATE ADMIN PREVIEW/);
  assert.doesNotMatch(preview.body, /PRIVATE_SENTINEL_NOT_PUBLIC|\+15550001111/);
  assert.equal(await db.salesDemoEvent.count(), 0);
});

test('publishing requires review, enforces versions, and exposes only the public snapshot', async () => {
  const detail = await html(`/admin/demos/${standaloneId}`, { headers: adminHeaders });
  const csrf = hidden(detail.body, 'csrf');
  const version = hidden(detail.body, 'version');
  const missingReview = await fetch(`${baseUrl}/admin/demos/${standaloneId}/publish`, {
    method: 'POST',
    headers: adminHeaders,
    body: form({ csrf, version, days: '45' }),
    redirect: 'manual',
  });
  assert.equal(missingReview.status, 400);
  const published = await fetch(`${baseUrl}/admin/demos/${standaloneId}/publish`, {
    method: 'POST',
    headers: adminHeaders,
    body: form({ csrf, version, days: '45', reviewed: 'on' }),
    redirect: 'manual',
  });
  assert.equal(published.status, 303);
  const stale = await fetch(`${baseUrl}/admin/demos/${standaloneId}/publish`, {
    method: 'POST',
    headers: adminHeaders,
    body: form({ csrf, version, days: '45', reviewed: 'on' }),
    redirect: 'manual',
  });
  assert.equal(stale.status, 409);
  const publicPage = await html(`/demo/${standaloneToken}`);
  assert.equal(publicPage.response.status, 200);
  assert.match(publicPage.body, /Guided simulation|simulation/);
  assert.doesNotMatch(publicPage.body, /PRIVATE_SENTINEL_NOT_PUBLIC|\+15550001111|salesNotes/);
  assert.equal(await db.salesDemoEvent.count(), 0, 'A public GET alone must not create an event');
});

test('events validate origin, UUID, module allowlist, dedupe, and atomic lifetime cap', async () => {
  const endpoint = `${baseUrl}/demo/${standaloneToken}/events`;
  const post = (value: unknown, origin = baseUrl) =>
    fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify(value),
    });
  assert.equal((await post({ sessionKey: 'bad', kind: 'opened' })).status, 400);
  assert.equal((await post({ sessionKey: randomUUID(), kind: 'audit_viewed' })).status, 400);
  assert.equal(
    (await post({ sessionKey: randomUUID(), kind: 'opened' }, 'https://evil.example')).status,
    403,
  );
  const sessionKey = randomUUID();
  const duplicates = await Promise.all(
    Array.from({ length: 8 }, () => post({ sessionKey, kind: 'opened' })),
  );
  assert.ok(duplicates.every((response) => response.status === 204));
  assert.equal(await db.salesDemoEvent.count({ where: { demoId: standaloneId } }), 1);
  assert.equal(
    (await db.salesDemo.findUniqueOrThrow({ where: { id: standaloneId } })).eventCount,
    1,
  );

  await db.salesDemo.update({ where: { id: standaloneId }, data: { eventCount: 4999 } });
  const capped = await Promise.all([
    post({ sessionKey: randomUUID(), kind: 'opened' }),
    post({ sessionKey: randomUUID(), kind: 'opened' }),
  ]);
  assert.ok(capped.every((response) => response.status === 204));
  const finalDemo = await db.salesDemo.findUniqueOrThrow({ where: { id: standaloneId } });
  assert.equal(finalDemo.eventCount, 5000);
  assert.equal(await db.salesDemoEvent.count({ where: { demoId: standaloneId } }), 2);
});

test('regeneration unpublishes and optimistic edit conflicts fail closed', async () => {
  const editPage = await html(`/admin/demos/${standaloneId}/edit`, { headers: adminHeaders });
  const payload = {
    csrf: hidden(editPage.body, 'csrf'),
    requestId: hidden(editPage.body, 'requestId'),
    version: hidden(editPage.body, 'version'),
    businessName: 'Updated Demo',
    niche: 'plumbing',
    selectionMode: 'recommended',
  };
  const saved = await fetch(`${baseUrl}/admin/demos/${standaloneId}/edit`, {
    method: 'POST',
    headers: adminHeaders,
    body: form(payload),
    redirect: 'manual',
  });
  assert.equal(saved.status, 303);
  assert.equal((await fetch(`${baseUrl}/demo/${standaloneToken}`)).status, 404);
  const stale = await fetch(`${baseUrl}/admin/demos/${standaloneId}/edit`, {
    method: 'POST',
    headers: adminHeaders,
    body: form(payload),
    redirect: 'manual',
  });
  assert.equal(stale.status, 409);
});

test('prospect prefill is editable and deleting the prospect detaches the demo', async () => {
  const client = await db.client.create({
    data: {
      businessName: 'Demo test owner',
      phoneNumber: '+15550009991',
      timezone: 'America/New_York',
      services: ['Test'],
    },
  });
  const prospect = await db.prospectBusiness.create({
    data: {
      clientId: client.id,
      name: 'Prefill Prospect',
      normalizedName: 'prefill prospect',
      website: 'https://example.com',
      city: 'Pittsburgh',
      state: 'PA',
      niche: 'roofing',
    },
  });
  const newPage = await html(`/admin/demos/new?prospectBusinessId=${prospect.id}`, {
    headers: adminHeaders,
  });
  assert.match(newPage.body, /value="Prefill Prospect"/);
  const created = await fetch(`${baseUrl}/admin/demos`, {
    method: 'POST',
    headers: adminHeaders,
    redirect: 'manual',
    body: form({
      csrf: hidden(newPage.body, 'csrf'),
      requestId: hidden(newPage.body, 'requestId'),
      prospectBusinessId: prospect.id,
      businessName: 'Operator Edited Name',
      niche: 'roofing',
      selectionMode: 'recommended',
    }),
  });
  assert.equal(created.status, 303);
  const linked = await db.salesDemo.findFirstOrThrow({
    where: { businessName: 'Operator Edited Name' },
  });
  assert.equal(linked.prospectBusinessId, prospect.id);
  await db.prospectBusiness.delete({ where: { id: prospect.id } });
  assert.equal(
    (await db.salesDemo.findUniqueOrThrow({ where: { id: linked.id } })).prospectBusinessId,
    null,
  );
  assert.equal(
    (await fetch(`${baseUrl}/admin/demos/${linked.id}/edit`, { headers: adminHeaders })).status,
    200,
  );
});

test('expired and archived public access and event submission return 404', async () => {
  await db.salesDemo.update({
    where: { id: standaloneId },
    data: { status: 'published', expiresAt: new Date(Date.now() - 1000) },
  });
  assert.equal((await fetch(`${baseUrl}/demo/${standaloneToken}`)).status, 404);
  assert.equal(
    (
      await fetch(`${baseUrl}/demo/${standaloneToken}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionKey: randomUUID(), kind: 'opened' }),
      })
    ).status,
    404,
  );
  await db.salesDemo.update({
    where: { id: standaloneId },
    data: { status: 'archived', expiresAt: new Date(Date.now() + 86400000) },
  });
  assert.equal((await fetch(`${baseUrl}/demo/${standaloneToken}`)).status, 404);
});
