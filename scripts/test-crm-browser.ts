/** Disposable local CRM UI checks. No external network, accounts or sends. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { requireDemoTestDatabase } from '../src/demo-engine/test-database.js';
import { provisionOrganization, authenticate } from '../src/workforce/tenancy/service.js';
import { CrmService } from '../src/crm/service.js';

async function main() {
  requireDemoTestDatabase();
  Object.assign(process.env, {
    CRM_ENABLED: 'true',
    WORKFORCE_ENABLED: 'true',
    WORKFORCE_WORKER_ENABLED: 'false',
    ADMIN_USERNAME: 'crm-browser',
    ADMIN_PASSWORD: 'crm-browser-test-only',
    LOG_LEVEL: 'silent',
  });
  const { app } = await import('../src/app.js');
  const { db } = await import('../src/db/client.js');
  const org = await provisionOrganization(
    db,
    { name: 'Northline Service Group (test)', ownerSubject: `crm-browser:${randomUUID()}` },
    'test',
  );
  const crm = new CrmService(db, await authenticate(db, `Bearer ${org.token}`));
  const pipeline = await crm.create('pipelines', { name: 'Service engagements' });
  const open = await crm.create('stages', {
    name: 'Consultation requested',
    position: 0,
    pipelineId: pipeline.id,
  });
  const won = await crm.create('stages', {
    name: 'Agreement signed',
    position: 1,
    pipelineId: pipeline.id,
    outcome: 'won',
  });
  await crm.createField({
    entityType: 'contact',
    key: 'business_unit',
    label: 'Business unit',
    fieldType: 'text',
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('Unexpected outbound request blocked by CRM browser test');
  };
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const root = `${base}/admin/crm/${org.organization.id}`;
  const screenshots = await mkdtemp(path.join(tmpdir(), 'steel-scale-crm-browser-'));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({
      ...(process.env.CHROME_PATH
        ? { executablePath: process.env.CHROME_PATH }
        : { channel: 'chromium-headless-shell' }),
      headless: true,
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      httpCredentials: { username: 'crm-browser', password: 'crm-browser-test-only' },
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.route('**/*', (route) =>
      route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort(),
    );
    await page.goto(`${root}/contacts`);
    await page.getByText('Add contact', { exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('Alex Example');
    await page.getByLabel('Email', { exact: true }).fill('alex@example.test');
    await page.getByLabel('Business unit', { exact: true }).fill('Commercial services');
    await page.getByRole('button', { name: 'Create contact', exact: true }).click();
    await page.getByRole('heading', { name: 'Alex Example', exact: true }).waitFor();
    await page
      .getByLabel('Note', { exact: true })
      .fill('Fictional consultation: prepare a service proposal.');
    await page.getByRole('button', { name: 'Save note', exact: true }).click();
    await page
      .getByText('Fictional consultation: prepare a service proposal.', { exact: true })
      .waitFor();
    await page.screenshot({ path: path.join(screenshots, 'contact-details.png'), fullPage: true });
    const contact = (await crm.list('contacts'))[0]!;
    assert.equal(
      (await crm.detail('contacts', contact.id)).customFields[0]!.value,
      'Commercial services',
    );
    await page.getByRole('link', { name: 'Opportunities', exact: true }).click();
    await page.getByText('Add opportunity', { exact: true }).click();
    await page.getByLabel('Opportunity', { exact: true }).fill('Annual service agreement');
    await page.getByLabel('Contact', { exact: true }).selectOption(contact.id);
    await page
      .getByLabel('Pipeline and stage', { exact: true })
      .selectOption(`${pipeline.id}:${open.id}`);
    await page.getByLabel('Value in currency minor units').fill('240000');
    await page.getByRole('button', { name: 'Create opportunity', exact: true }).click();
    await page.getByRole('heading', { name: 'Annual service agreement', exact: true }).waitFor();
    await page
      .getByLabel('Pipeline and stage', { exact: true })
      .selectOption(`${pipeline.id}:${won.id}`);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.waitForLoadState('load');
    await page.getByRole('link', { name: 'Pipeline', exact: true }).click();
    await page.getByRole('heading', { name: 'Pipeline', exact: true }).waitFor();
    assert.equal((await crm.list('opportunities'))[0]!.status, 'won');
    assert.equal(
      await page
        .locator('.crm-column')
        .filter({ hasText: 'Agreement signed' })
        .getByRole('link', { name: 'Annual service agreement $2,400.00' })
        .count(),
      1,
    );
    await page.screenshot({ path: path.join(screenshots, 'pipeline-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${root}/contacts/${contact.id}`);
    await page.screenshot({ path: path.join(screenshots, 'contact-mobile.png'), fullPage: true });
    assert.ok(await page.getByRole('button', { name: 'Save changes', exact: true }).isVisible());
    assert.deepEqual(errors, []);
    console.log(
      `PASS CRM browser: contact create/detail, custom field, note timeline, opportunity create/stage change, pipeline, mobile. Screenshots: ${screenshots}`,
    );
  } finally {
    await browser?.close();
    globalThis.fetch = realFetch;
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await db.$disconnect();
  }
}
main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
