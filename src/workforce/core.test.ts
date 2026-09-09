/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registrations. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultRecoveryConfig,
  parseRecoveryConfig,
  proposeRecoveryConfig,
} from './agents/config.js';
import { parseEvent } from './events/contracts.js';
import { inboundAdapter } from './integrations/adapters.js';
import { evaluatePolicy } from './policy/engine.js';
import { getTool } from './tools/registry.js';
import { authorize, tokenHash, type Principal } from './tenancy/service.js';
import { hash } from './shared.js';

const event = {
  id: 'crm-123',
  version: 1,
  type: 'customer.upserted',
  occurredAt: '2026-09-01T12:00:00Z',
  data: { externalId: 'customer-1', name: 'Test Customer' },
};

test('event contract rejects tenant spoofing, unsupported versions, executable fields and invalid money', () => {
  for (const invalid of [
    null,
    [],
    { ...event, organizationId: 'spoof' },
    { ...event, version: 2 },
    { ...event, data: { ...event.data, tools: ['send_sms'] } },
    { ...event, occurredAt: 'invalid' },
    { ...event, type: 'payment.send' },
  ])
    assert.throws(() => parseEvent(invalid));
  const opportunity = {
    ...event,
    type: 'opportunity.upserted',
    data: {
      externalId: 'o1',
      customerExternalId: 'c1',
      title: 'Roof estimate',
      status: 'estimate_sent',
      amountMinor: 10050,
      currency: 'USD',
      lastActivityAt: event.occurredAt,
    },
  };
  assert.equal(parseEvent(opportunity).type, 'opportunity.upserted');
  for (const amountMinor of [-1, 0.5, 2_147_483_648, NaN, '100']) {
    assert.throws(() => parseEvent({ ...opportunity, data: { ...opportunity.data, amountMinor } }));
  }
  assert.throws(() =>
    parseEvent({
      ...opportunity,
      data: { ...opportunity.data, lastActivityAt: '2026-09-02T12:00:00Z' },
    }),
  );
});

test('normalization and canonical hashes make key order irrelevant', () => {
  assert.equal(hash({ a: 1, b: { c: 2, d: 3 } }), hash({ b: { d: 3, c: 2 }, a: 1 }));
  assert.equal(parseEvent(event).occurredAt, '2026-09-01T12:00:00.000Z');
  assert.notEqual(hash(event), hash({ ...event, id: 'different' }));
});

test('Zapier and generic adapters accept canonical events without any GHL dependency', () => {
  assert.deepEqual(
    inboundAdapter('zapier').normalize(event),
    inboundAdapter('generic_webhook').normalize(event),
  );
  assert.throws(() => inboundAdapter('ghl'));
  assert.throws(() =>
    inboundAdapter('zapier').normalize({ ...event, type: 'recovery.scan.requested', data: {} }),
  );
});

test('config proposals remain drafts; untrusted compiler output cannot grant tools or skip review', async () => {
  const proposal = await proposeRecoveryConfig('Follow up on old estimates');
  assert.equal(proposal.requiresReview, true);
  assert.equal(proposal.provenance, 'template_defaults');
  for (const override of [
    { requireApproval: false },
    { allowedTools: ['sms.send'] },
    { staleAfterDays: 0 },
    { shell: 'curl' },
  ]) {
    assert.throws(() => parseRecoveryConfig({ ...defaultRecoveryConfig, ...override }));
  }
  await assert.rejects(
    proposeRecoveryConfig('Send money', {
      compile: () => Promise.resolve({ ...defaultRecoveryConfig, allowedTools: ['payment.send'] }),
    }),
  );
});

test('policy denies unknown tools, suppression, disabled agents and closed opportunities', () => {
  const context = {
    enabled: true,
    tool: 'recovery.prepare_handoff',
    config: defaultRecoveryConfig,
    doNotContact: false,
    opportunityStatus: 'estimate_sent',
  };
  assert.equal(evaluatePolicy(context).outcome, 'require_approval');
  for (const override of [
    { enabled: false },
    { doNotContact: true },
    { opportunityStatus: 'won' },
    { opportunityStatus: 'lost' },
    { tool: 'sms.send' },
    { tool: 'constructor' },
  ]) {
    assert.equal(evaluatePolicy({ ...context, ...override }).outcome, 'deny');
  }
});

test('tool registry cannot execute external actions and handoffs never claim delivery', () => {
  assert.throws(() => getTool('sms.send'));
  assert.throws(() => getTool('__proto__'));
  const tool = getTool('recovery.prepare_handoff');
  const input = tool.validate({
    opportunityId: '11111111-1111-4111-8111-111111111111',
    customerId: '22222222-2222-4222-8222-222222222222',
    message: 'Follow-up draft',
  });
  assert.equal(tool.execute(input).deliveryStatus, 'not_sent');
  assert.throws(() => tool.validate({ ...input, webhookUrl: 'https://example.com' }));
});

test('roles and scopes independently restrict human and integration credentials', () => {
  const actor: Principal = {
    organizationId: 'o',
    actor: 'member:m',
    credentialId: 'k',
    scopes: ['crm:read', 'crm:write', 'approvals:write', 'events:write'],
    role: 'owner',
  };
  assert.doesNotThrow(() => authorize(actor, 'approvals:write'));
  assert.throws(() => authorize({ ...actor, role: 'member' }, 'approvals:write'));
  assert.throws(() => authorize({ ...actor, role: 'viewer' }, 'crm:write'));
  assert.throws(() => authorize({ ...actor, scopes: [] }, 'crm:read'));
  assert.throws(() => authorize({ ...actor, integrationId: 'i' }, 'crm:write'));
  assert.doesNotThrow(() =>
    authorize({ ...actor, integrationId: 'i', role: undefined }, 'events:write'),
  );
  assert.equal(tokenHash('secret').length, 64);
  assert.notEqual(tokenHash('secret'), tokenHash('other'));
});
