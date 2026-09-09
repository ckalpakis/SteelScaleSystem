/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registrations. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { requireDemoTestDatabase } from '../demo-engine/test-database.js';
requireDemoTestDatabase();
const redis = new URL(process.env.REDIS_URL ?? 'https://invalid');
if (
  !['redis:', 'rediss:'].includes(redis.protocol) ||
  !['localhost', '127.0.0.1', '[::1]'].includes(redis.hostname)
)
  throw new Error('Explicit local Redis required');

test('compiled production worker becomes ready and drains on SIGTERM; web starts without Redis', async () => {
  for (const role of ['worker', 'web']) {
    const socket = createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const address = socket.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    const child = spawn(
      process.execPath,
      [role === 'worker' ? 'dist/workforce/jobs/worker.js' : 'dist/server.js'],
      {
        env: {
          ...process.env,
          NODE_ENV: 'production',
          DOTENV_CONFIG_PATH: '/dev/null',
          LOG_LEVEL: 'silent',
          SERVICE_ROLE: role,
          PORT: String(port),
          QUEUE_PREFIX: `deployment-process-test-${randomUUID()}`,
          SHUTDOWN_TIMEOUT_MS: '3000',
          REDIS_URL: role === 'worker' ? redis.toString() : '',
          WORKFORCE_WORKER_ENABLED: role === 'worker' ? 'true' : 'false',
          WORKFORCE_ENABLED: 'false',
          DURABLE_BACKGROUND_ENABLED: role === 'web' ? 'true' : 'false',
          AGENT_RUNTIME_ENABLED: 'false',
          AGENT_MODEL_ENABLED: 'false',
          AGENT_BUILDER_AI_ENABLED: 'false',
          REVENUE_RECOVERY_ENABLED: 'false',
          REVENUE_RECOVERY_DELIVERY_ENABLED: 'false',
          DEMO_ENGINE_ENABLED: 'false',
          DEMO_AI_ENABLED: 'false',
          DEMO_VOICE_ENABLED: 'false',
          COMMUNICATION_DELIVERY_ENABLED: 'false',
          WEBHOOK_DELIVERY_ENABLED: 'false',
          OPENAI_API_KEY: '',
          ANTHROPIC_API_KEY: '',
          TWILIO_ACCOUNT_SID: '',
          TWILIO_AUTH_TOKEN: '',
          GHL_API_KEY: '',
          SLACK_WEBHOOK_URL: '',
          OUTSCRAPER_API_KEY: '',
          APIFY_API_TOKEN: '',
          TWILIO_SMS_DRY_RUN: 'true',
          BOOKING_DELIVERY_DRY_RUN: 'true',
          LLM_PROVIDER: 'mock',
        },
        stdio: 'pipe',
      },
    );
    const exited = once(child, 'exit');
    try {
      const deadline = Date.now() + 45000;
      for (;;) {
        let ok = false;
        try {
          ok = (
            await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(2500) })
          ).ok;
        } catch {
          /* Waiting for bind. */
        }
        if (ok) break;
        if (Date.now() > deadline || child.exitCode !== null)
          throw new Error(`${role} failed readiness`);
        await delay(200);
      }
      assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
      child.kill('SIGTERM');
      const result = await Promise.race([
        exited,
        delay(5000).then(() => {
          throw new Error('Shutdown exceeded limit');
        }),
      ]);
      assert.equal(result[0], 0);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
});
