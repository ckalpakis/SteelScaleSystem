/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { blueprintSchema, blankBlueprint, parseBlueprint } from './blueprint.js';
import { compile, preview } from './compiler.js';
import { exampleBlueprint, readyBlueprint, sourceRequest } from './test-fixtures.js';
import { OpenAIBlueprintExtractor } from './extractor.js';
import { object } from '../workforce/shared.js';
import { formBlueprint } from './form.js';

test('blueprints are closed, versioned and preserve missing information instead of guessing', () => {
  assert.deepEqual(parseBlueprint(blankBlueprint()), blankBlueprint());
  assert.throws(() => parseBlueprint({ ...blankBlueprint(), organizationId: 'spoof' }));
  assert.throws(() => parseBlueprint({ ...blankBlueprint(), schemaVersion: 2 }));
  assert.throws(() => parseBlueprint({ ...blankBlueprint(), allowedActions: ['eval'] }));
  assert.throws(() => parseBlueprint({ ...blankBlueprint(), currency: 'usd' }));
  assert.throws(() =>
    parseBlueprint({
      ...blankBlueprint(),
      operatingHours: { timezone: 'wrong/zone', days: [1], startHour: 9, endHour: 17 },
    }),
  );
});
test('the estimate example retains strict amount, unaccepted state, delay, pricing guard and escalation', () => {
  const b = parseBlueprint(exampleBlueprint()),
    result = compile({ ...b, missingConfiguration: [] }, ['test-model']);
  assert.equal(b.triggerConditions[0]!.operator, 'gt');
  assert.equal(b.triggerConditions[0]!.number, 250000);
  assert.equal(b.triggerConditions[1]!.operator, 'neq');
  assert.equal(b.delayMinutes, 2880);
  assert.equal(b.currency, null);
  assert.deepEqual(b.communicationChannels, []);
  assert.equal(result.definition, null);
  for (const code of [
    'unsupported_condition',
    'unsupported_delay',
    'unsupported_cadence',
    'adapter_unavailable',
    'unsupported_business_guard',
    'unsupported_escalation',
    'unsupported_goal',
  ])
    assert.ok(
      result.requirements.some((r) => r.code === code),
      code,
    );
  assert.ok(result.requirements.some((r) => r.field === 'currency'));
  assert.ok(result.requirements.some((r) => r.field === 'operatingHours'));
});
test('compilation reuses runtime definitions and defaults to bounded human-reviewed permissions', () => {
  const result = compile(readyBlueprint(), ['test-model']);
  assert.deepEqual(result.requirements, []);
  assert.ok(result.definition);
  assert.equal(result.definition.mode, 'COPILOT');
  assert.equal(result.definition.limits.maxActions, 1);
  assert.equal(result.definition.context.includeContactDetails, false);
  assert.ok(result.definition.permissions.every((p) => !p.automatic));
  assert.equal(result.definition.description.includes(sourceRequest), false);
});
test('unsafe contradictions and unreviewed knowledge cannot disappear behind model questions', () => {
  const b = readyBlueprint();
  assert.equal(
    compile({ ...b, prohibitedActions: ['create_task'] }, ['test-model']).definition,
    null,
  );
  assert.equal(
    compile({ ...b, automaticActions: ['create_task'] }, ['test-model']).definition,
    null,
  );
  assert.equal(
    compile(
      {
        ...b,
        knowledgeRequirements: [
          { name: 'Service facts', content: 'Unverified text', approved: false },
        ],
      },
      ['test-model'],
    ).definition,
    null,
  );
  assert.equal(
    compile(
      {
        ...b,
        triggerConditions: [
          { field: 'status', operator: 'eq', value: 'open', number: null, values: [] },
          { field: 'status', operator: 'eq', value: 'closed', number: null, values: [] },
        ],
      },
      ['test-model'],
    ).definition,
    null,
  );
  assert.equal(compile({ ...b, runtimeModel: 'unapproved' }, ['test-model']).definition, null);
  assert.equal(compile({ ...b, mode: 'ADVISORY' }, ['test-model']).definition, null);
  assert.equal(
    compile(
      {
        ...b,
        triggerConditions: [
          { field: 'status', operator: 'eq', value: 'x'.repeat(41), number: null, values: [] },
        ],
      },
      ['test-model'],
    ).requirements.some((r) => r.code === 'status_limit'),
    true,
  );
});
test('dry run uses eligibility and policy without model calls or tool effects', () => {
  const prior = process.env.AGENT_ALLOWED_MODELS;
  process.env.AGENT_ALLOWED_MODELS = 'test-model';
  try {
    const report = preview(
      readyBlueprint(),
      { entityType: 'contact', status: 'open', inactiveDays: 0, suppressed: false },
      new Date('2026-09-08T12:00:00Z'),
    );
    assert.equal(report.sideEffects, false);
    assert.equal(report.executable, true);
    assert.equal(report.eligible, true);
    assert.equal(
      report.policies?.find((p) => p.tool === 'create_task')?.outcome,
      'require_approval',
    );
    assert.equal(
      preview(exampleBlueprint(), {
        entityType: 'estimate',
        status: 'sent',
        inactiveDays: 3,
        suppressed: false,
      }).executable,
      false,
    );
  } finally {
    if (prior === undefined) delete process.env.AGENT_ALLOWED_MODELS;
    else process.env.AGENT_ALLOWED_MODELS = prior;
  }
});
test('form mapping represents amounts exactly and preserves each editable structured item', () => {
  const form = {
    condition_0_field: 'amount_minor',
    condition_0_operator: 'gt',
    condition_0_number: '2500.01',
    condition_1_field: 'status',
    condition_1_operator: 'neq',
    condition_1_value: 'accepted',
    delayMinutes: '2880',
    allowedActions: ['send_message'],
    prohibitedActions: ['offer_discount'],
    escalation_0_condition: 'pricing_negotiation',
    escalation_0_route: 'assigned_salesperson',
    missingConfiguration: 'Currency?\nChannel?',
    knowledge_0_name: 'Facts',
    knowledge_0_content: 'Services offered',
    knowledge_0_approved: 'true',
  };
  const b = formBlueprint(form);
  assert.equal(b.triggerConditions[0]!.number, 250001);
  assert.equal(b.triggerConditions[1]!.value, 'accepted');
  assert.deepEqual(b.missingConfiguration, ['Currency?', 'Channel?']);
  assert.equal(b.knowledgeRequirements[0]!.approved, true);
  assert.throws(() => formBlueprint({ ...form, condition_0_number: '2500.001' }));
});
test('AI extraction is strict schema-only, with source text in user data and no executable tools', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, {
    AGENT_BUILDER_AI_ENABLED: 'true',
    AGENT_BUILDER_MODEL: 'test-model',
    AGENT_ALLOWED_MODELS: 'test-model',
    OPENAI_API_KEY: 'fictional-test-only',
  });
  try {
    const extractor = new OpenAIBlueprintExtractor((url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.ok(typeof options?.body === 'string');
      const body = object(JSON.parse(options.body) as unknown);
      assert.equal(body.store, false);
      assert.equal(body.tools, undefined);
      assert.equal(String(body.instructions).includes(sourceRequest), false);
      assert.equal(JSON.stringify(body.input).includes('$2,500'), true);
      const format = object(object(body.text).format);
      assert.equal(format.strict, true);
      assert.deepEqual(format.schema, blueprintSchema);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status: 'completed',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: JSON.stringify(exampleBlueprint()) }],
              },
            ],
          }),
        ),
      );
    });
    assert.deepEqual(
      await extractor.extract(sourceRequest, new AbortController().signal),
      exampleBlueprint(),
    );
  } finally {
    for (const key of [
      'AGENT_BUILDER_AI_ENABLED',
      'AGENT_BUILDER_MODEL',
      'AGENT_ALLOWED_MODELS',
      'OPENAI_API_KEY',
    ])
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
  }
});
