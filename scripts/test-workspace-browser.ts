/** Local fictional-data browser checks. No live integrations, model calls or sends. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { requireDemoTestDatabase } from '../src/demo-engine/test-database.js';
import { workspaceFixture } from '../src/workspace/test-fixtures.js';

async function main() {
  requireDemoTestDatabase();
  Object.assign(process.env, {
    WORKFORCE_ENABLED: 'true',
    CRM_ENABLED: 'true',
    BUSINESS_KNOWLEDGE_ENABLED: 'true',
    AGENT_RUNTIME_ENABLED: 'true',
    REVENUE_RECOVERY_ENABLED: 'true',
    AGENT_ALLOWED_MODELS: 'test-model',
    AGENT_MODEL_ENABLED: 'false',
    REVENUE_RECOVERY_DELIVERY_ENABLED: 'false',
    COMMUNICATION_DELIVERY_ENABLED: 'false',
    WORKFORCE_WORKER_ENABLED: 'false',
    WEBHOOK_DELIVERY_ENABLED: 'false',
    OPENAI_API_KEY: '',
    LOG_LEVEL: 'silent',
  });
  const { app } = await import('../src/app.js'),
    { db } = await import('../src/db/client.js');
  const fixture = await workspaceFixture(db);
  const oldest = await fixture.addCase('Jordan Ellis', 'Commercial maintenance agreement');
  const recent = await fixture.addCase('Alex Morgan', 'Equipment replacement proposal');
  await db.organizationMember.update({
    where: { id: fixture.principal.actor.slice(7) },
    data: { displayName: 'Sam Bennett' },
  });
  for (const [row, assignedMemberId, hours] of [
    [oldest, null, 49],
    [recent, fixture.principal.actor.slice(7), 2],
  ] as const) {
    await db.recoveryHandoff.create({
      data: {
        organizationId: fixture.organizationId,
        caseId: row.recoveryCase.id,
        assignedMemberId,
        reason: 'pricing_negotiation',
        summary: 'Fictional customer requested a conversation about proposal pricing.',
        updatedAt: new Date(Date.now() - hours * 3600000),
      },
    });
    await db.recoveryCase.update({
      where: { id: row.recoveryCase.id },
      data: { state: 'handoff', reason: 'pricing_negotiation' },
    });
  }
  await db.recoveryDispatch.create({
    data: {
      organizationId: fixture.organizationId,
      caseId: oldest.recoveryCase.id,
      runtimeVersionId: fixture.program.runtimeVersionId,
      requestKey: 'test-unknown',
      body: 'Fictional test text, never sent.',
      channel: 'sms',
      actor: fixture.principal.actor,
      caseRevision: 1,
      status: 'unknown',
    },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('Unexpected outbound request blocked by workspace browser test');
  };
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const folder = await mkdtemp(path.join(tmpdir(), 'steel-scale-workspace-browser-'));
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
      httpCredentials: { username: 'member', password: fixture.token },
    });
    const page = await context.newPage(),
      errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) =>
      route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort(),
    );
    assert.equal((await page.goto(`${base}/workspace`))!.status(), 200);
    await page.getByRole('heading', { name: 'Your workforce, at a glance' }).waitFor();
    assert.ok(await page.getByText('Do not resend blindly:', { exact: false }).isVisible());
    assert.deepEqual(await page.locator('.work-item h3').allTextContents(), [
      'Jordan Ellis',
      'Alex Morgan',
    ]);
    await page.screenshot({ path: path.join(folder, 'today-desktop.png'), fullPage: false });
    await page.getByLabel('Show handoffs').selectOption('mine');
    await page.getByRole('button', { name: 'Update queue' }).click();
    assert.deepEqual(await page.locator('.work-item h3').allTextContents(), ['Alex Morgan']);
    await page.getByLabel('Show handoffs').selectOption('unassigned');
    await page.getByRole('button', { name: 'Update queue' }).click();
    assert.deepEqual(await page.locator('.work-item h3').allTextContents(), ['Jordan Ellis']);
    await page.getByLabel('Outcome window').selectOption('7');
    await page.getByRole('button', { name: 'Update results' }).click();
    assert.match(page.url(), /days=7/);
    assert.equal(await page.getByLabel('Show handoffs').inputValue(), 'unassigned');
    await page
      .getByRole('region', { name: 'Recovery results with evidence' })
      .screenshot({ path: path.join(folder, 'results-desktop.png') });
    await page.getByRole('link', { name: 'Review conversation', exact: true }).click();
    await page
      .getByRole('heading', { name: 'Commercial maintenance agreement', exact: true })
      .waitFor();
    await page.getByRole('link', { name: 'Today', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'CRM', exact: true })
      .click();
    assert.ok(page.url().endsWith('/workspace/crm/contacts'));
    assert.equal(await page.getByRole('link', { name: 'Switch organization' }).count(), 0);
    await page.getByText('Add contact', { exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('Jamie Rivera');
    await page.getByRole('button', { name: 'Create contact', exact: true }).click();
    await page.getByRole('heading', { name: 'Jamie Rivera', exact: true }).waitFor();
    await page
      .getByLabel('Note', { exact: true })
      .fill('Fictional follow-up: customer prefers a morning consultation.');
    await page.getByRole('button', { name: 'Save note', exact: true }).click();
    await page
      .getByText('Fictional follow-up: customer prefers a morning consultation.', { exact: true })
      .waitFor();
    await page.screenshot({ path: path.join(folder, 'member-crm-desktop.png'), fullPage: false });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(folder, 'member-crm-mobile.png'), fullPage: false });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.goto(`${base}/workspace`);
    await page.screenshot({ path: path.join(folder, 'today-mobile.png'), fullPage: false });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.keyboard.press('Tab');
    assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), 'BODY');
    assert.deepEqual(errors, []);
    assert.equal(
      await db.recoveryDispatch.count({
        where: { organizationId: fixture.organizationId, status: { not: 'unknown' } },
      }),
      0,
    );
    assert.equal(await db.agentRun.count({ where: { organizationId: fixture.organizationId } }), 0);
    console.log(
      `PASS workspace browser: queue filters, time windows, handoff navigation, member CRM create/note, desktop/mobile layout, keyboard focus, no sends. Screenshots: ${folder}`,
    );
  } finally {
    await browser?.close();
    globalThis.fetch = realFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.$disconnect();
  }
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
