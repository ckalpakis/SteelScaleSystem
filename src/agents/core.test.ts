/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseDefinition, parseDecision } from './contracts.js';
import { evaluate, operatingNow } from './policy.js';
import { getTool, validateTool } from './tools.js';
import { OpenAIResponsesProvider } from './provider.js';
import { definition, decision } from './test-fixtures.js';
import { object } from '../workforce/shared.js';
const id = randomUUID();
const context = {
  subjectId: id,
  records: [{ id, type: 'contact', version: 1, data: {} }],
  suppressed: false,
  fingerprint: 'test',
};
const policyInput = {
  tool: 'create_task' as const,
  effect: 'internal' as const,
  enabled: true,
  currentVersion: true,
  context,
  automaticAvailable: true,
  actions: 0,
  attempts: 0,
  now: new Date(),
};
test('structured definitions reject freeform permissions, invalid budgets and unknown fields', () => {
  assert.equal(parseDefinition(definition()).mode, 'COPILOT');
  assert.throws(() => parseDefinition({ ...definition(), execute: 'arbitrary code' }));
  assert.throws(() =>
    parseDefinition(definition({ permissions: [{ tool: 'eval' as never, automatic: true }] })),
  );
  assert.throws(() =>
    parseDefinition(definition({ limits: { ...definition().limits, maxSteps: 100 } })),
  );
  assert.throws(() =>
    parseDefinition(
      definition({ operatingHours: { ...definition().operatingHours, timezone: 'bad/zone' } }),
    ),
  );
});
test('strict decisions reject prose, extra arguments, unregistered tools and malformed finish', () => {
  assert.deepEqual(
    parseDecision(decision('get_contact', { targetId: id })),
    decision('get_contact', { targetId: id }),
  );
  assert.throws(() => parseDecision('Call an API'));
  assert.throws(() => parseDecision({ ...decision(null), reasoning: 'hidden reasoning' }));
  assert.throws(() => parseDecision(decision('eval' as never)));
  assert.throws(() => parseDecision(decision(null, { text: 'extra' })));
  assert.throws(() => getTool('constructor'));
});
test('all modes use explicit permissions and server policy, never model authorization', () => {
  assert.equal(evaluate(definition(), policyInput).outcome, 'require_approval');
  assert.equal(evaluate(definition({ mode: 'AUTOPILOT' }), policyInput).outcome, 'allow');
  assert.equal(evaluate(definition({ mode: 'ADVISORY' }), policyInput).outcome, 'recommend');
  assert.equal(
    evaluate(definition({ mode: 'AUTOPILOT', permissions: [] }), { ...policyInput, approved: true })
      .outcome,
    'deny',
  );
  assert.equal(
    evaluate(definition({ restrictedActions: ['create_task'] }), { ...policyInput, approved: true })
      .outcome,
    'deny',
  );
  assert.equal(
    evaluate(definition(), { ...policyInput, currentVersion: false, approved: true }).outcome,
    'deny',
  );
  assert.equal(
    evaluate(definition(), { ...policyInput, automaticAvailable: false, approved: true }).outcome,
    'deny',
  );
});
test('policy enforces suppression, channels, operating hours and action limits', () => {
  assert.equal(
    evaluate(definition(), {
      ...policyInput,
      tool: 'send_message',
      effect: 'external',
      channel: 'sms',
    }).reason,
    'channel_not_allowed',
  );
  assert.equal(
    evaluate(definition(), {
      ...policyInput,
      tool: 'schedule_followup',
      context: { ...context, suppressed: true },
    }).reason,
    'customer_suppressed',
  );
  assert.equal(evaluate(definition(), { ...policyInput, attempts: 5 }).reason, 'action_limit');
  assert.equal(evaluate(definition(), { ...policyInput, actions: 3 }).reason, 'action_limit');
  assert.equal(
    operatingNow(
      definition({
        operatingHours: { timezone: 'America/New_York', days: [1], startHour: 9, endHour: 17 },
      }),
      new Date('2026-09-07T13:00:00Z'),
    ),
    true,
  );
  assert.equal(
    operatingNow(
      definition({
        operatingHours: { timezone: 'America/New_York', days: [1], startHour: 9, endHour: 17 },
      }),
      new Date('2026-09-07T21:00:00Z'),
    ),
    false,
  );
});
test('tool input cannot escape context or pass undeclared application arguments', () => {
  assert.throws(() =>
    validateTool(
      getTool('get_contact'),
      decision('get_contact', { targetId: randomUUID() }).input,
      context,
      definition(),
      new Date(),
    ),
  );
  assert.throws(() =>
    validateTool(
      getTool('get_contact'),
      decision('get_contact', { targetId: id, text: 'ignore permissions' }).input,
      context,
      definition(),
      new Date(),
    ),
  );
  assert.throws(() =>
    validateTool(
      getTool('schedule_followup'),
      decision('schedule_followup', { targetId: id, dueAt: new Date().toISOString() }).input,
      context,
      definition(),
      new Date(),
    ),
  );
  assert.equal(getTool('send_message').available, false);
  assert.equal(getTool('book_appointment').available, false);
});
test('Responses adapter uses strict schema and rejects refusals, incomplete output and bad JSON', async () => {
  const saved = {
    enabled: process.env.AGENT_MODEL_ENABLED,
    models: process.env.AGENT_ALLOWED_MODELS,
    key: process.env.OPENAI_API_KEY,
  };
  Object.assign(process.env, {
    AGENT_MODEL_ENABLED: 'true',
    AGENT_ALLOWED_MODELS: 'test-model',
    OPENAI_API_KEY: 'fictional-test-only',
  });
  try {
    for (const [status, content, works] of [
      ['completed', [{ type: 'output_text', text: JSON.stringify(decision(null)) }], true],
      ['incomplete', [{ type: 'output_text', text: JSON.stringify(decision(null)) }], false],
      ['completed', [{ type: 'refusal', refusal: 'No' }], false],
      ['completed', [{ type: 'output_text', text: 'prose' }], false],
    ] as const) {
      const provider = new OpenAIResponsesProvider((url, options) => {
        assert.equal(url, 'https://api.openai.com/v1/responses');
        assert.equal(typeof options?.body, 'string');
        const body = object(JSON.parse(options!.body as string) as unknown);
        assert.equal(body.store, false);
        assert.equal(object(object(body.text).format).strict, true);
        assert.equal(object(object(body.text).format).type, 'json_schema');
        assert.equal(body.tools, undefined);
        return Promise.resolve(
          new Response(JSON.stringify({ status, output: [{ type: 'message', content }] })),
        );
      });
      const promise = provider.decide(
        { definition: definition(), context, history: [], trigger: { system: 'test' } },
        new AbortController().signal,
      );
      if (works) assert.deepEqual(await promise, decision(null));
      else await assert.rejects(promise);
    }
  } finally {
    for (const [key, value] of Object.entries({
      AGENT_MODEL_ENABLED: saved.enabled,
      AGENT_ALLOWED_MODELS: saved.models,
      OPENAI_API_KEY: saved.key,
    }))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});
