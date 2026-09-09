/** Fictional local fixtures; browser reads only; no model, customer delivery or file upload. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { requireDemoTestDatabase } from '../src/demo-engine/test-database.js';
import { authenticate, provisionOrganization } from '../src/workforce/tenancy/service.js';
import { KnowledgeService } from '../src/knowledge/service.js';

async function main() {
  requireDemoTestDatabase();
  Object.assign(process.env, {
    WORKFORCE_ENABLED: 'true',
    BUSINESS_KNOWLEDGE_ENABLED: 'true',
    WORKFORCE_WORKER_ENABLED: 'false',
    WEBHOOK_DELIVERY_ENABLED: 'false',
    AGENT_MODEL_ENABLED: 'false',
    REVENUE_RECOVERY_DELIVERY_ENABLED: 'false',
    OPENAI_API_KEY: '',
    LOG_LEVEL: 'silent',
  });
  const { app } = await import('../src/app.js'),
    { db } = await import('../src/db/client.js');
  const org = await provisionOrganization(
    db,
    {
      name: 'Northline Service Group (test)',
      ownerSubject: `knowledge-browser:${randomUUID()}`,
    },
    'test',
  );
  const principal = await authenticate(db, `Bearer ${org.token}`),
    service = new KnowledgeService(db, principal);
  const source = await service.source({ name: 'Reviewed company handbook' });
  for (const input of [
    {
      category: 'faq',
      title: 'Equipment maintenance',
      question: 'Do you offer maintenance?',
      content: 'We offer equipment maintenance and inspections.',
    },
    {
      category: 'financing',
      title: 'Financing availability',
      question: null,
      content: 'Financing is available through ABC Finance, subject to lender approval.',
    },
  ]) {
    const saved = await service.save({
      ...input,
      sourceId: source.id,
      audience: 'public',
      facts: {},
    });
    await service.approve(saved.entry.id, {
      expectedRevision: 1,
      versionId: saved.version.id,
      reviewed: true,
    });
  }
  const draft = await service.save({
    sourceId: source.id,
    category: 'warranties',
    audience: 'public',
    title: 'Warranty reference',
    content: 'Warranty coverage depends on the product and signed agreement.',
    facts: {},
  });
  const doc = await service.document({
    sourceId: source.id,
    filename: 'company-reference.md',
    content: '# Company reference\nWe offer equipment maintenance and inspections.\n',
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`,
    folder = await mkdtemp(path.join(tmpdir(), 'steel-scale-knowledge-browser-'));
  const browser = await chromium.launch({ channel: 'chromium-headless-shell', headless: true });
  try {
    const context = await browser.newContext({
      httpCredentials: { username: 'organization', password: org.token },
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage(),
      errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) =>
      route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort(),
    );
    await page.goto(`${base}/business-knowledge`);
    await page.getByRole('heading', { name: 'Business Knowledge', exact: true }).waitFor();
    assert.equal(
      await page.getByRole('combobox', { name: 'Category', exact: true }).locator('option').count(),
      16,
    );
    assert.equal(await page.getByRole('button', { name: 'Test question', exact: true }).count(), 1);
    assert.equal(
      await page.getByLabel('Choose text file').getAttribute('accept'),
      '.txt,.md,text/plain,text/markdown',
    );
    assert.equal(await page.getByText('Draft · not available', { exact: true }).count(), 1);
    await page.screenshot({ path: path.join(folder, 'library-desktop.png'), fullPage: false });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    await page.screenshot({ path: path.join(folder, 'library-mobile.png'), fullPage: false });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${base}/business-knowledge/entries/${draft.entry.id}`);
    await page.getByRole('heading', { name: 'Review version 1', exact: true }).waitFor();
    assert.equal(
      await page.getByRole('heading', { name: 'Version history', exact: true }).count(),
      1,
    );
    assert.equal(
      await page.getByRole('button', { name: 'Approve and activate version', exact: true }).count(),
      1,
    );
    assert.equal(await page.getByText('Not approved for agent use.', { exact: true }).count(), 1);
    await page.screenshot({ path: path.join(folder, 'review-desktop.png'), fullPage: false });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    await page.screenshot({ path: path.join(folder, 'review-mobile.png'), fullPage: false });
    await page.goto(`${base}/business-knowledge/documents/${doc.id}`);
    await page.getByRole('heading', { name: doc.filename, exact: true }).waitFor();
    assert.deepEqual(errors, []);
    assert.equal((await service.detail(draft.entry.id)).active, false);
    assert.equal(
      await db.agentRun.count({ where: { organizationId: principal.organizationId } }),
      0,
    );
    assert.equal(
      await db.recoveryDispatch.count({ where: { organizationId: principal.organizationId } }),
      0,
    );
    console.log(
      `PASS knowledge library, review/history and documents, desktop/mobile; 16 categories; no overflow or browser errors; no AI calls or dispatches. Screenshots: ${folder}`,
    );
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.$disconnect();
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
