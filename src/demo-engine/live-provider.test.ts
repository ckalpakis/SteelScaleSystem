/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registrations. */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { responseText } from '../services/openai-response.js';
import { generatePresentation, parseInput } from './core.js';
import {
  createVoiceCall,
  demoChat,
  demoPrompt,
  demoTool,
  hangupVoiceCall,
  realtimeConfig,
} from './live-provider.js';
import { publicView } from './experience-view.js';
import { requireDemoTestDatabase } from './test-database.js';

const p = generatePresentation(
  parseInput({
    businessName: 'Northline Plumbing',
    niche: 'plumbing',
    services: 'Drain cleaning, Water heaters',
    hours: 'Monday–Friday 9–5',
    location: 'Pittsburgh, PA',
    selectionMode: 'custom',
    modules: ['voice', 'chatbot', 'roi'],
    salesNotes: 'SECRET_NOTES',
    businessPhone: '+15550123456',
  }),
);

function setEnv(t: TestContext, name: string, value: string) {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

test('raw REST output text is parsed, without SDK convenience fields or tool content', () => {
  assert.equal(
    responseText({
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'function_call', name: 'no' },
        {
          type: 'message',
          content: [
            { type: 'output_text', text: 'Hello' },
            { type: 'refusal', refusal: 'no' },
            { type: 'output_text', text: 'there' },
          ],
        },
      ],
    }),
    'Hello\nthere',
  );
  for (const input of [
    null,
    [],
    {},
    { output_text: 'not a REST message' },
    { output: [null, { type: 'message', content: null }] },
  ])
    assert.equal(responseText(input), '');
});

test('demo prompts include only public allowlisted facts and explicit safe boundaries', () => {
  const prompt = demoPrompt(p);
  assert.match(prompt, /Northline Plumbing/);
  assert.match(prompt, /untrusted data/);
  assert.match(prompt, /no real calendar/);
  assert.doesNotMatch(prompt, /SECRET_NOTES|15550123456|salesNotes/);
  assert.doesNotMatch(demoPrompt({ ...p, salesNotes: 'POISON' } as typeof p), /POISON/);
});

test('only validated, confirmed, simulated bookings can be returned', () => {
  assert.equal(demoTool('check_demo_availability', {}, 'abc').slots?.length, 3);
  for (const input of [
    { confirmed: false },
    { confirmed: true, service: 'Drain', slot: 'Friday' },
    { confirmed: true, service: '', slot: 'Tuesday at 10 AM' },
  ])
    assert.equal(demoTool('create_demo_booking', input, 'abc').booking, undefined);
  assert.equal(
    demoTool(
      'create_booking',
      { confirmed: true, service: 'Drain', slot: 'Tuesday at 10 AM' },
      'abc',
    ).booking,
    undefined,
  );
  const result = demoTool(
    'create_demo_booking',
    { confirmed: true, service: 'Drain', slot: 'Tuesday at 10 AM' },
    'abcdef12-345',
  );
  assert.equal(result.booking?.simulated, true);
  assert.equal(result.booking?.confirmation, 'DEMO-ABCDEF12');
  assert.match(result.message, /no real appointment/);
});

test('chat provider uses bounded raw Responses API and rejects empty or incomplete output', async (t) => {
  setEnv(t, 'DEMO_OPENAI_API_KEY', 'unit-test-key');
  let body: Record<string, unknown> = {};
  let result: unknown = {
    output: [
      {
        type: 'message',
        content: [{ type: 'output_text', text: 'How can we help with your drain?' }],
      },
    ],
  };
  t.mock.method(globalThis, 'fetch', (_url: unknown, init: RequestInit) => {
    assert.equal(typeof init.body, 'string');
    body = JSON.parse(init.body as string) as Record<string, unknown>;
    return Promise.resolve(Response.json(result));
  });
  assert.match(
    (await demoChat(p, [{ role: 'user', content: 'Help with my drain' }], 'abc')).message,
    /drain/,
  );
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, 512);
  assert.doesNotMatch(JSON.stringify(body), /SECRET_NOTES|create_booking|15550123456/);
  result = {
    output: [{ type: 'function_call', name: 'check_demo_availability', arguments: '{}' }],
  };
  assert.equal((await demoChat(p, [], 'abc')).slots?.length, 3);
  for (const invalid of [{}, { status: 'incomplete', output: [] }]) {
    result = invalid;
    await assert.rejects(demoChat(p, [], 'abc'));
  }
});

test('voice adapter negotiates SDP server-side and validates call IDs before hangup', async (t) => {
  setEnv(t, 'DEMO_OPENAI_API_KEY', 'unit-test-key');
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', (url: string, init: RequestInit) => {
    calls.push(url);
    if (url.endsWith('/hangup')) return Promise.resolve(new Response(null, { status: 200 }));
    assert.ok(init.body instanceof FormData);
    assert.equal(init.body.get('sdp'), 'v=0\r\n');
    const session = init.body.get('session');
    assert.equal(typeof session, 'string');
    const config = JSON.parse(session as string) as { max_output_tokens: number; tools: unknown[] };
    assert.equal(config.max_output_tokens, 512);
    assert.equal(config.tools.length, 2);
    return Promise.resolve(
      new Response('v=0\r\nanswer', {
        status: 201,
        headers: { location: '/v1/realtime/calls/rtc_TEST' },
      }),
    );
  });
  assert.deepEqual(await createVoiceCall('v=0\r\n', p), {
    callId: 'rtc_TEST',
    sdp: 'v=0\r\nanswer',
  });
  await hangupVoiceCall('rtc_TEST');
  await assert.rejects(hangupVoiceCall('../responses'));
  assert.equal(calls.length, 2);
  assert.equal(realtimeConfig(p).type, 'realtime');
});

test('live view provides real controls, accessible transcripts, and honest setup states', () => {
  const html = publicView(p, '/demo/example/events', false, {
    base: '/demo/example/live',
    csrf: 'short-lived',
    chat: true,
    voice: true,
  });
  for (const id of [
    'start-call',
    'end-call',
    'chat-form',
    'voice-transcript',
    'booking-card',
    'present',
  ])
    assert.ok(html.includes(`id="${id}"`));
  assert.match(html, /Demo appointments only/);
  assert.doesNotMatch(html, /Run sample|SECRET_NOTES|api_key/);
  const off = publicView(p, '', true);
  assert.match(off, /id="start-call"[^>]*disabled/);
  assert.match(off, /Live AI awaiting setup/);
});

test('destructive demo tests refuse production, unspecified and non-loopback databases', (t) => {
  setEnv(t, 'NODE_ENV', 'test');
  setEnv(t, 'DATABASE_URL', '');
  for (const value of [
    '',
    'postgresql://x:y@production.example/steel_scale_demo_live_test',
    'postgresql://x:y@127.0.0.1/customer_data',
  ]) {
    process.env.DATABASE_URL = value;
    assert.throws(requireDemoTestDatabase);
  }
  process.env.DATABASE_URL = 'postgresql://x:y@127.0.0.1/steel_scale_demo_live_test';
  assert.doesNotThrow(requireDemoTestDatabase);
});
