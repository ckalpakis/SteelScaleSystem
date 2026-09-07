/** Local browser QA: real Express + PostgreSQL, stubbed AI and microphone/WebRTC. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { requireDemoTestDatabase } from '../src/demo-engine/test-database.js';
import { generatePresentation, parseInput } from '../src/demo-engine/core.js';
import { record } from '../src/services/openai-response.js';

async function main() {
  requireDemoTestDatabase();
  process.env.DEMO_ENGINE_ENABLED = 'true';
  process.env.DEMO_AI_ENABLED = 'true';
  process.env.DEMO_VOICE_ENABLED = 'true';
  process.env.DEMO_OPENAI_API_KEY = 'browser-test-key-not-real';
  process.env.ADMIN_USERNAME = 'browser-test';
  process.env.ADMIN_PASSWORD = 'browser-test-only';
  const { app } = await import('../src/app.js');
  const { db } = await import('../src/db/client.js');
  const input = parseInput({
    businessName: 'Northline Plumbing',
    niche: 'plumbing',
    location: 'Pittsburgh, Pennsylvania',
    websiteUrl: 'https://example.com',
    services: 'Drain cleaning, Water heaters, Leak repair, Fixture installation',
    publicSummary:
      'From a stubborn drain to your next home project, tell us what you need. Our team is here to help you find the right service.',
    hours: 'Monday–Friday · 8 AM–6 PM',
    selectionMode: 'custom',
    modules: ['voice', 'chatbot', 'missed_call', 'nurture', 'roi'],
    salesNotes: 'PRIVATE_BROWSER_SENTINEL',
  });
  const demo = await db.salesDemo.create({
    data: {
      creationRequestId: randomUUID(),
      shareToken: randomBytes(32).toString('hex'),
      businessName: input.businessName,
      inputs: input,
      presentation: generatePresentation(input),
      status: 'published',
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  const realFetch = globalThis.fetch;
  let providerFailure = false;
  globalThis.fetch = (url, init) => {
    const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (target !== 'https://api.openai.com/v1/responses')
      throw new Error('Unexpected outbound request blocked by browser test');
    if (providerFailure) return Promise.resolve(new Response(null, { status: 503 }));
    assert.equal(typeof init?.body, 'string');
    const body = record(JSON.parse(init?.body as string) as unknown);
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE_BROWSER_SENTINEL|create_booking/);
    const messages = body.input as { content: string }[];
    const latest = messages.at(-1)?.content || '';
    const output = /confirm/i.test(latest)
      ? [
          {
            type: 'function_call',
            name: 'create_demo_booking',
            arguments: JSON.stringify({
              service: 'Drain cleaning',
              slot: 'Tuesday at 10 AM',
              confirmed: true,
            }),
          },
        ]
      : [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'We can help with drain cleaning. For this demo, Tuesday at 10 AM is an example slot. Would you like to confirm that demo appointment?',
              },
            ],
          },
        ];
    return Promise.resolve(Response.json({ output }));
  };
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const browser = await chromium
    .launch({
      ...(process.env.CHROME_PATH
        ? { executablePath: process.env.CHROME_PATH }
        : { channel: 'chromium-headless-shell' }),
      headless: true,
      timeout: 30000,
    })
    .catch(async (error: unknown) => {
      globalThis.fetch = realFetch;
      server.close();
      await once(server, 'close');
      await db.salesDemo.delete({ where: { id: demo.id } });
      await db.$disconnect();
      throw error;
    });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    httpCredentials: { username: 'browser-test', password: 'browser-test-only' },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const screenshots = path.resolve(process.env.DEMO_SCREENSHOT_DIR || 'docs/testing/live-demo');
  await mkdir(screenshots, { recursive: true });
  try {
    await page.route('**/*', (route) =>
      route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort(),
    );
    await page.goto(`${base}/demo/${demo.shareToken}`);
    assert.match(await page.locator('h1').innerText(), /customer experience/);
    assert.doesNotMatch(await page.content(), /PRIVATE_BROWSER_SENTINEL|browser-test-key/);
    await page.getByRole('button', { name: 'Chat with Northline Plumbing' }).click();
    assert.equal(await page.locator('#chat-launcher').getAttribute('aria-expanded'), 'true');
    await page.getByRole('button', { name: 'Explore services', exact: true }).click();
    await page
      .locator('#chat-messages .assistant')
      .filter({ hasText: 'Would you like to confirm' })
      .waitFor();
    await page
      .getByRole('textbox', { name: 'Your message' })
      .fill('Yes, confirm drain cleaning Tuesday at 10 AM.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.locator('#booking-card').waitFor({ state: 'visible' });
    assert.match(await page.locator('#booking-service').innerText(), /Drain cleaning/);
    assert.match(await page.locator('#booking-slot').innerText(), /Tuesday/);
    await page.screenshot({ path: path.join(screenshots, 'desktop-chat.png'), fullPage: true });
    console.log(
      'PASS: desktop personalized website, real route-backed chat, persisted demo booking, escaping',
    );

    // These transport doubles never open the real microphone or contact OpenAI.
    const voiceHarness = () => {
      const harness = { deny: false, stopped: false, enabled: true, greetingRequested: false };
      Object.defineProperty(window, '__demoVoiceTest', { value: harness });
      const track = {
        get enabled() {
          return harness.enabled;
        },
        set enabled(value: boolean) {
          harness.enabled = value;
        },
        stop() {
          harness.stopped = true;
        },
      };
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        value: () =>
          harness.deny
            ? Promise.reject(new DOMException('Denied', 'NotAllowedError'))
            : Promise.resolve({ getTracks: () => [track], getAudioTracks: () => [track] }),
      });
      class TestPeerConnection {
        localDescription = { sdp: 'v=0\r\nbrowser-test' };
        connectionState = 'new';
        onconnectionstatechange?: () => void;
        channel: {
          onmessage?: (message: { data: string }) => void;
          onopen?: () => void;
          send: (data: string) => void;
        } = {
          send: (data) => {
            harness.greetingRequested = data === JSON.stringify({ type: 'response.create' });
          },
        };
        addTrack() {}
        getReceivers() {
          return [];
        }
        createDataChannel() {
          return this.channel;
        }
        createOffer() {
          return Promise.resolve(this.localDescription);
        }
        setLocalDescription() {
          return Promise.resolve();
        }
        setRemoteDescription() {
          this.connectionState = 'connected';
          this.onconnectionstatechange?.();
          this.channel.onopen?.();
          const events = [
            {
              type: 'conversation.item.input_audio_transcription.completed',
              item_id: 'user1',
              transcript: 'Hi, I need help with a blocked drain.',
            },
            {
              type: 'response.output_audio_transcript.done',
              item_id: 'assistant1',
              transcript:
                'Thanks for calling Northline Plumbing. I can help with that. Is it a kitchen sink or a bathroom drain?',
            },
          ];
          for (const event of events) this.channel.onmessage?.({ data: JSON.stringify(event) });
          return Promise.resolve();
        }
        close() {
          this.connectionState = 'closed';
        }
      }
      Object.defineProperty(window, 'RTCPeerConnection', { value: TestPeerConnection });
    };
    // tsx may retain function names with __name; provide that helper in page scope.
    await page.addInitScript({
      content: `const __name = (value) => value; (${voiceHarness.toString()})();`,
    });
    await page.route('**/sessions/*/voice', async (route) => {
      await route.fulfill({
        json: { sdp: 'v=0\r\ntest-answer', expiresAt: new Date(Date.now() + 180000).toISOString() },
      });
    });
    await page.reload();
    await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
    await page
      .getByRole('button', { name: 'Mute microphone', exact: true })
      .waitFor({ timeout: 8000 })
      .catch(async () => {
        throw new Error(
          `Voice UI failed: ${await page.locator('#voice-status').innerText()}; browser errors: ${JSON.stringify(errors)}`,
        );
      });
    assert.match(await page.locator('#voice-transcript').innerText(), /blocked drain/);
    assert.equal(
      await page.evaluate(
        () =>
          (window as unknown as { __demoVoiceTest: { greetingRequested: boolean } }).__demoVoiceTest
            .greetingRequested,
      ),
      true,
    );
    await page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
    assert.equal(
      await page.evaluate(
        () =>
          (window as unknown as { __demoVoiceTest: { enabled: boolean } }).__demoVoiceTest.enabled,
      ),
      false,
    );
    await page.screenshot({
      path: path.join(screenshots, 'desktop-voice-controls.png'),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'End conversation', exact: true }).click();
    assert.equal(
      await page.evaluate(
        () =>
          (window as unknown as { __demoVoiceTest: { stopped: boolean } }).__demoVoiceTest.stopped,
      ),
      true,
    );
    await page.evaluate(() => {
      (window as unknown as { __demoVoiceTest: { deny: boolean } }).__demoVoiceTest.deny = true;
    });
    await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
    await page
      .locator('#voice-status')
      .filter({ hasText: 'Microphone access was denied' })
      .waitFor();
    console.log(
      'PASS: voice UI connect/transcripts/mute/end/permission-denial with transport doubles (not real audio)',
    );

    await page.getByRole('button', { name: 'Chat with Northline Plumbing' }).click();
    providerFailure = true;
    await page.getByRole('textbox', { name: 'Your message' }).fill('Help with a drain');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.locator('#chat-error').waitFor({ state: 'visible' });
    assert.match(await page.locator('#chat-error').innerText(), /could not respond/);
    assert.equal(await page.locator('#chat-input').inputValue(), 'Help with a drain');
    providerFailure = false;
    await page.getByRole('button', { name: 'Start a new chat', exact: true }).click();
    assert.equal(await page.locator('#chat-messages .chat-message').count(), 1);
    await page.getByRole('button', { name: 'Close chat', exact: true }).click();
    assert.equal(await page.locator('#chat-launcher').getAttribute('aria-expanded'), 'false');
    console.log('PASS: provider-error recovery, reset, and accessible open/close chat');

    await page.getByText('Explore the potential return', { exact: false }).click();
    await page.getByRole('button', { name: 'Calculate scenario', exact: true }).click();
    assert.match(await page.locator('#roi-result').innerText(), /2.5 additional jobs/);
    assert.match(await page.locator('#roi-result').innerText(), /\$500 contribution/);
    await page.locator('[data-roi="1"]').fill('101');
    assert.equal(
      await page
        .locator('[data-roi="1"]')
        .evaluate((node) => (node as HTMLInputElement).checkValidity()),
      false,
    );
    console.log('PASS: calculator arithmetic and percentage validation');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Chat with Northline Plumbing' }).click();
    await page.locator('#chat-panel').scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    const box = await page.locator('#chat-panel').boundingBox();
    assert.ok(box && box.width <= 390 && box.x >= 0);
    await page.screenshot({ path: path.join(screenshots, 'mobile-chat.png'), fullPage: true });
    console.log('PASS: 390px mobile layout and chat fit');

    await page.goto(`${base}/admin/demos/${demo.id}/preview`);
    assert.match(await page.locator('.preview-note').innerText(), /PRIVATE ADMIN PREVIEW/);
    await page.getByRole('button', { name: 'Chat with Northline Plumbing' }).click();
    await page.getByRole('button', { name: 'Explore services', exact: true }).click();
    await page
      .locator('#chat-messages .assistant')
      .filter({ hasText: 'Would you like to confirm' })
      .waitFor();
    assert.ok(await db.salesDemoSession.count({ where: { demoId: demo.id, preview: true } }));
    console.log('PASS: authenticated private preview uses its own session scope');
    assert.deepEqual(errors, []);
    console.log(
      `All browser checks passed. Screenshots: ${screenshots}. No real AI or microphone used.`,
    );
  } catch (error) {
    await page.screenshot({ path: path.join(screenshots, 'failure.png'), fullPage: true });
    throw error;
  } finally {
    await browser.close();
    globalThis.fetch = realFetch;
    server.close();
    await once(server, 'close');
    await db.salesDemo.delete({ where: { id: demo.id } });
    await db.$disconnect();
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
