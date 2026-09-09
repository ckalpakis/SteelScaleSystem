/** Fictional local fixtures; read-only browser checks; no model or delivery calls. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { requireDemoTestDatabase } from '../src/demo-engine/test-database.js';
import { authenticate, provisionOrganization } from '../src/workforce/tenancy/service.js';
import { tenantTransaction } from '../src/workforce/shared.js';
import { CrmService } from '../src/crm/service.js';
import { RecoveryService } from '../src/recovery/service.js';
import { RecoverySimulationService } from '../src/recovery/simulation.js';
import { exampleConfig } from '../src/recovery/contracts.js';
import { ensureHandoff, loadCase, pauseCase } from '../src/recovery/lifecycle.js';
async function main() {
  requireDemoTestDatabase();
  Object.assign(process.env, {
    WORKFORCE_ENABLED: 'true',
    CRM_ENABLED: 'true',
    AGENT_RUNTIME_ENABLED: 'true',
    REVENUE_RECOVERY_ENABLED: 'true',
    REVENUE_RECOVERY_DELIVERY_ENABLED: 'false',
    WORKFORCE_WORKER_ENABLED: 'false',
    WEBHOOK_DELIVERY_ENABLED: 'false',
    AGENT_MODEL_ENABLED: 'false',
    AGENT_ALLOWED_MODELS: 'test-model',
    OPENAI_API_KEY: '',
    LOG_LEVEL: 'silent',
  });
  const { app } = await import('../src/app.js'),
    { db } = await import('../src/db/client.js');
  const org = await provisionOrganization(
    db,
    { name: 'Northline Service Group (test)', ownerSubject: `recovery-browser:${randomUUID()}` },
    'test',
  );
  const principal = await authenticate(db, `Bearer ${org.token}`),
    service = new RecoveryService(db, principal),
    crm = new CrmService(db, principal);
  const config = exampleConfig();
  config.model = 'test-model';
  config.knowledge = config.knowledge.map((k) => ({ ...k, approved: true }));
  await service.configure({ config, connectionId: null, expectedVersion: 0, reviewed: true });
  const contact = await crm.create('contacts', { name: 'Alex Morgan' });
  const pipeline = await crm.create('pipelines', { name: 'Service proposals' });
  const stage = await crm.create('stages', {
    name: 'Proposal sent',
    pipelineId: pipeline.id,
    position: 0,
  });
  const opportunity = await crm.create('opportunities', {
    title: 'Commercial maintenance proposal',
    customerId: contact.id,
    pipelineId: pipeline.id,
    stageId: stage.id,
    amountMinor: 1850000,
    currency: 'USD',
    lastActivityAt: new Date(Date.now() - 7 * 86400000).toISOString(),
  });
  const record = await service.enroll(opportunity.id);
  await tenantTransaction(db, principal.organizationId, async (tx) => {
    const row = await loadCase(tx, principal.organizationId, record.id);
    await pauseCase(tx, row, 'handoff', 'pricing_negotiation');
    await ensureHandoff(
      tx,
      row,
      'pricing_negotiation',
      'Customer asked whether the proposal could fit a smaller budget. An employee must discuss pricing.',
      new Date(),
    );
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`,
    folder = await mkdtemp(path.join(tmpdir(), 'steel-scale-recovery-browser-'));
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
    await page.goto(`${base}/revenue-recovery`);
    await page.getByRole('heading', { name: 'Revenue Recovery', exact: true }).waitFor();
    assert.equal(
      await page.getByRole('heading', { name: 'Simulation lab', exact: true }).count(),
      1,
    );
    assert.equal(
      await page
        .getByRole('combobox', { name: 'Scenario', exact: false })
        .locator('option')
        .count(),
      37,
    );
    assert.equal(await page.getByText('Recovered Revenue', { exact: true }).count(), 1);
    await page.screenshot({ path: path.join(folder, 'dashboard-desktop.png'), fullPage: false });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    await page.screenshot({ path: path.join(folder, 'dashboard-mobile.png'), fullPage: false });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${base}/revenue-recovery/cases/${record.id}`);
    for (const name of ['Take Over', 'Return to AI', 'Close Handoff', 'Respond'])
      assert.equal(await page.getByRole('button', { name, exact: true }).count(), 1);
    await page.screenshot({ path: path.join(folder, 'handoff-desktop.png'), fullPage: false });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    await page.screenshot({ path: path.join(folder, 'handoff-mobile.png'), fullPage: false });
    assert.deepEqual(errors, []);
    assert.equal(
      await db.recoveryDispatch.count({ where: { organizationId: principal.organizationId } }),
      0,
    );
    assert.equal(
      await db.agentRun.count({ where: { organizationId: principal.organizationId } }),
      0,
    );
    // Backend simulation call does not mutate browser state or create customer communication.
    await new RecoverySimulationService(db, principal).run({
      scenarioKey: 'sms-stop',
    });
    console.log(
      `PASS recovery dashboard/handoff desktop and mobile; 37 scenario options; zero browser errors, model calls or dispatches. Screenshots: ${folder}`,
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
