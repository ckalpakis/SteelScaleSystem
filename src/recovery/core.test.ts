/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  exampleConfig,
  parseConfig,
  validateActivation,
  parseClassification,
} from './contracts.js';
import { classifyFixture, emptyClassification, normalizeDecision } from './decisions.js';
import { recoveryScenarios } from './scenarios.js';
import { simulate } from './simulation.js';
import { evidenceStatus } from './attribution.js';
import { windowOpen } from './lifecycle.js';
import { RevenueRecoveryProvider } from './provider.js';
import { runtimeDefinition } from './service.js';

export function testConfig() {
  const config = exampleConfig();
  config.model = 'test-model';
  config.workingHours = { timezone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 };
  config.employeeQuietMinutes = 15;
  config.knowledge = config.knowledge.map((k) => ({ ...k, approved: true }));
  return config;
}
for (const scenario of recoveryScenarios)
  test(`scenario ${scenario.key}: ${scenario.expectedIntent}`, () => {
    const result = simulate(testConfig(), scenario.message, scenario.state);
    assert.equal(result.decision.intent, scenario.expectedIntent);
    assert.equal(result.sideEffects, false);
    assert.equal(result.wouldSend, false);
    if (scenario.expectedIntent === 'opt_out')
      assert.equal(result.decision.message_if_allowed, null);
    if (!scenario.state.active) assert.ok(result.blocks.includes('organization_inactive'));
    if (scenario.state.optedOut) assert.ok(result.blocks.includes('opt_out'));
    if (!scenario.state.open) assert.ok(result.blocks.includes('opportunity_closed'));
    if (scenario.state.duplicate) assert.ok(result.blocks.includes('duplicate_dispatch'));
  });
test('configuration is closed, bounded, currency-aware and requires approved knowledge', () => {
  assert.ok(recoveryScenarios.length >= 30);
  assert.deepEqual(parseConfig(testConfig()), testConfig());
  assert.throws(() => parseConfig({ ...testConfig(), vendor: 'ghl' }));
  assert.throws(() => parseConfig({ ...testConfig(), maximumAttempts: 99 }));
  assert.throws(() => parseConfig({ ...testConfig(), cadenceMinutes: [] }));
  assert.throws(() =>
    parseConfig({
      ...testConfig(),
      workingHours: { ...testConfig().workingHours, timezone: 'invalid' },
    }),
  );
  const previous = process.env.AGENT_ALLOWED_MODELS;
  process.env.AGENT_ALLOWED_MODELS = 'test-model';
  try {
    assert.throws(() =>
      validateActivation({ ...testConfig(), knowledge: exampleConfig().knowledge }),
    );
    validateActivation(testConfig());
  } finally {
    if (previous === undefined) delete process.env.AGENT_ALLOWED_MODELS;
    else process.env.AGENT_ALLOWED_MODELS = previous;
  }
});
test('model-invented facts and follow-up dates cannot enter outbound drafts', () => {
  const config = testConfig(),
    now = new Date('2026-09-08T12:00:00Z');
  const raw = {
    ...emptyClassification(),
    intent: 'information_request',
    message_if_allowed: 'We guarantee approval and offer a 50% discount.',
    next_followup_at: '2030-01-01T00:00:00Z',
  };
  const initial = normalizeDecision(config, raw, null, 0, now);
  assert.equal(initial.message_if_allowed, config.knowledge[0]!.text);
  assert.notEqual(initial.next_followup_at, raw.next_followup_at);
  assert.equal(
    normalizeDecision(config, raw, 'Can I get a discount?', 0, now).message_if_allowed,
    null,
  );
  assert.equal(normalizeDecision(config, raw, 'STOP', 0, now).intent, 'opt_out');
});
test('allowed objection responses must match approved topic knowledge exactly', () => {
  const config = testConfig();
  config.allowedObjections = ['timing'];
  config.knowledge.push({
    key: 'timing',
    topic: 'timing',
    text: 'Our team can discuss a timeline with you.',
    approved: true,
  });
  const result = normalizeDecision(
    config,
    classifyFixture('Maybe next month.'),
    'Maybe next month.',
    1,
    new Date(),
  );
  assert.equal(result.message_if_allowed, config.knowledge[2]!.text);
  assert.equal(result.recommended_action, 'handoff');
  config.restrictedTopics.push('timing');
  assert.equal(
    normalizeDecision(config, result, 'Maybe next month.', 1, new Date()).message_if_allowed,
    null,
  );
});
test('operating windows respect explicit timezone and weekdays', () => {
  const config = testConfig();
  config.workingHours = {
    timezone: 'America/New_York',
    days: [1, 2, 3, 4, 5],
    startHour: 9,
    endHour: 17,
  };
  assert.equal(windowOpen(config, new Date('2026-09-08T14:00:00Z')), true);
  assert.equal(windowOpen(config, new Date('2026-09-08T23:00:00Z')), false);
  assert.equal(windowOpen(config, new Date('2026-09-12T14:00:00Z')), false);
});
test('temporal evidence never automatically claims recovered revenue', () => {
  const base = {
    deliveredAt: new Date('2026-09-01'),
    engagedAt: new Date('2026-09-02'),
    employeeAt: null,
    outcomeAt: new Date('2026-09-03'),
    windowDays: 14,
    validOutcome: true,
  };
  assert.equal(evidenceStatus(base), 'AI_ASSISTED');
  assert.equal(evidenceStatus({ ...base, engagedAt: null }), 'UNCERTAIN');
  assert.equal(evidenceStatus({ ...base, deliveredAt: null }), 'NOT_ATTRIBUTED');
  assert.equal(evidenceStatus({ ...base, validOutcome: false }), 'NOT_ATTRIBUTED');
  assert.equal(evidenceStatus({ ...base, outcomeAt: new Date('2027-01-01') }), 'NOT_ATTRIBUTED');
});
test('specialized provider uses registered runtime decisions and never forwards model reply prose', async () => {
  const provider = new RevenueRecoveryProvider({
    classify: () =>
      Promise.resolve({
        ...classifyFixture('I am interested'),
        message_if_allowed: 'Invented company facts',
      }),
  });
  const response = await provider.decide(
    {
      definition: runtimeDefinition(testConfig()),
      context: {
        subjectId: '00000000-0000-4000-8000-000000000001',
        records: [],
        suppressed: false,
        fingerprint: 'fixture',
      },
      history: [],
      trigger: { recovery: { inbound: 'I am interested', channel: 'sms' } },
    },
    new AbortController().signal,
  );
  assert.equal(response.tool, 'record_recovery_decision');
  assert.equal(
    parseClassification(JSON.parse(response.input.text!) as unknown).message_if_allowed,
    null,
  );
});
