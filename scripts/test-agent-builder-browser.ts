/** Local fictional fixtures only. Browser checks never activate agents or call AI. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { requireDemoTestDatabase } from '../src/demo-engine/test-database.js';
import { provisionOrganization, authenticate } from '../src/workforce/tenancy/service.js';
import { BlueprintService } from '../src/agent-builder/service.js';
import {
  exampleBlueprint,
  readyBlueprint,
  sourceRequest,
} from '../src/agent-builder/test-fixtures.js';
async function main() {
  requireDemoTestDatabase();
  Object.assign(process.env, {
    WORKFORCE_ENABLED: 'true',
    AGENT_RUNTIME_ENABLED: 'true',
    AGENT_BUILDER_ENABLED: 'true',
    WORKFORCE_WORKER_ENABLED: 'false',
    WEBHOOK_DELIVERY_ENABLED: 'false',
    AGENT_MODEL_ENABLED: 'false',
    AGENT_BUILDER_AI_ENABLED: 'false',
    AGENT_ALLOWED_MODELS: 'test-model',
    OPENAI_API_KEY: '',
    LOG_LEVEL: 'silent',
  });
  const { app } = await import('../src/app.js');
  const { db } = await import('../src/db/client.js');
  const org = await provisionOrganization(
    db,
    {
      name: 'Northline Service Group (test)',
      ownerSubject: `builder-browser:${randomUUID()}`,
    },
    'test',
  );
  const service = new BlueprintService(db, await authenticate(db, `Bearer ${org.token}`), {
    provider: 'fixture',
    model: 'test-model',
    extract: () => Promise.resolve(exampleBlueprint()),
  });
  const example = await service.generate({ description: sourceRequest, requestKey: randomUUID() });
  const ready = await service.save({ specification: readyBlueprint() });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const folder = await mkdtemp(path.join(tmpdir(), 'steel-scale-builder-browser-'));
  const browser = await chromium.launch({ channel: 'chromium-headless-shell', headless: true });
  try {
    const context = await browser.newContext({
      httpCredentials: { username: 'organization', password: org.token },
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) =>
      route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort(),
    );
    await page.goto(`${base}/agent-builder`);
    await page.getByRole('heading', { name: 'Build an AI employee', exact: true }).waitFor();
    assert.equal(
      await page.getByRole('button', { name: 'Generate blueprint', exact: true }).isEnabled(),
      false,
    );
    await page.screenshot({ path: path.join(folder, 'entry-desktop.png'), fullPage: false });
    await page.goto(`${base}/agent-builder/${example.blueprintId}`);
    for (const name of [
      'Trigger',
      'Eligibility',
      'AI may',
      'AI may not',
      'Escalate to a person',
      'Goal and stop conditions',
    ])
      assert.equal(await page.getByRole('heading', { name, exact: true }).count(), 1);
    assert.equal(
      await page.getByRole('button', { name: 'Activate Agent', exact: true }).isEnabled(),
      false,
    );
    assert.equal(
      await page.getByLabel('Delay in minutes (0 means immediate)', { exact: true }).inputValue(),
      '2880',
    );
    await page.screenshot({ path: path.join(folder, 'review-desktop.png'), fullPage: false });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    await page.screenshot({ path: path.join(folder, 'review-mobile.png'), fullPage: false });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${base}/agent-builder/${ready.blueprintId}`);
    assert.equal(
      await page.getByRole('button', { name: 'Test Agent', exact: true }).isEnabled(),
      true,
    );
    await page.getByLabel('Agent name', { exact: true }).fill('Unsaved fictional edit');
    assert.equal(
      await page.getByRole('button', { name: 'Test Agent', exact: true }).isEnabled(),
      false,
    );
    assert.equal(
      await page.getByRole('button', { name: 'Activate Agent', exact: true }).isEnabled(),
      false,
    );
    assert.equal(
      await page.getByRole('button', { name: 'Save Draft', exact: true }).isEnabled(),
      true,
    );
    assert.deepEqual(errors, []);
    console.log(
      `PASS builder UI: editable sections, missing configuration, disabled AI, unsaved-review guard, desktop/mobile, no page errors. Screenshots: ${folder}`,
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
