/** Read-only visual checks with fictional local fixtures; no browser credential mutations or sends. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { requireDemoTestDatabase } from '../src/demo-engine/test-database.js';
import { provisionOrganization, authenticate } from '../src/workforce/tenancy/service.js';
import { IntegrationService } from '../src/integrations/service.js';
async function main() {
  requireDemoTestDatabase();
  Object.assign(process.env, {
    WORKFORCE_ENABLED: 'true',
    WORKFORCE_WORKER_ENABLED: 'false',
    WEBHOOK_DELIVERY_ENABLED: 'false',
    INTEGRATION_ENCRYPTION_KEY: 'c'.repeat(64),
    LOG_LEVEL: 'silent',
    APP_URL: 'https://steel-scale.example.test',
  });
  const { app } = await import('../src/app.js');
  const { db } = await import('../src/db/client.js');
  const org = await provisionOrganization(
    db,
    { name: 'Northline Service Group (test)', ownerSubject: `integration-browser:${randomUUID()}` },
    'test',
  );
  const service = new IntegrationService(db, await authenticate(db, `Bearer ${org.token}`));
  await service.createConnection({ name: 'CRM via Zapier' });
  await service.createEndpoint({
    name: 'Approved handoffs',
    url: 'https://hooks.zapier.com/hooks/catch/fixture/not-real/',
    events: ['agent.handoff_created', 'contact.updated'],
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const folder = await mkdtemp(path.join(tmpdir(), 'steel-scale-integrations-browser-'));
  const browser = await chromium.launch({ channel: 'chromium-headless-shell', headless: true });
  try {
    const context = await browser.newContext({
      httpCredentials: { username: 'organization', password: org.token },
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.route('**/*', (route) =>
      route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort(),
    );
    await page.goto(`${base}/integrations`);
    await page.getByRole('heading', { name: 'Integrations', exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole('button', { name: 'Create connection and API key', exact: true })
        .count(),
      1,
    );
    assert.equal(
      await page.getByRole('button', { name: 'Send test event', exact: true }).count(),
      1,
    );
    assert.ok(
      (await page.getByLabel('Inbound webhook URL', { exact: true }).inputValue()).startsWith(
        'https://steel-scale.example.test/api/integrations/',
      ),
    );
    await page.screenshot({ path: path.join(folder, 'desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    await page.screenshot({ path: path.join(folder, 'mobile.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(
      `PASS integration UI: organization authentication, controls, desktop/mobile layout, no page errors. Screenshots: ${folder}`,
    );
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.$disconnect();
  }
}
void main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
