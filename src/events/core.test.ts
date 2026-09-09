/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registrations. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { parseEventInput, eventTypes } from './contracts.js';
import { parseExternalChange } from './intake.js';
import { EventRouter } from './router.js';
import { hash } from '../workforce/shared.js';

const base = {
  version: 2,
  type: 'contact.created',
  idempotencyKey: 'contact-123',
  occurredAt: '2026-09-01T12:00:00Z',
  entity: { type: 'contact', id: randomUUID() },
  data: { changes: { name: 'Alex' } },
};
test('canonical contract requires entity identity and rejects spoofed scope, versions and unregistered events', () => {
  assert.equal(parseEventInput(base).occurredAt, '2026-09-01T12:00:00.000Z');
  for (const override of [
    { organizationId: randomUUID() },
    { version: 1 },
    { source: 'ghl' },
    { type: 'OpportunityUpdate' },
    { entity: { type: 'estimate', id: randomUUID() } },
    { entity: { type: 'contact', id: null } },
  ])
    assert.throws(() => parseEventInput({ ...base, ...override }));
});
test('all requested lifecycle types are registered', () => {
  for (const type of [
    'contact.created',
    'contact.updated',
    'opportunity.created',
    'opportunity.updated',
    'opportunity.stage_changed',
    'opportunity.won',
    'opportunity.lost',
    'estimate.created',
    'estimate.sent',
    'estimate.updated',
    'estimate.accepted',
    'estimate.declined',
    'customer.message_received',
    'appointment.created',
    'appointment.booked',
    'appointment.cancelled',
    'task.created',
    'task.completed',
    'invoice.created',
    'invoice.overdue',
    'invoice.paid',
    'job.created',
    'job.completed',
  ])
    assert.ok(eventTypes.includes(type), type);
});
test('stage and status facts are structurally validated', () => {
  const stageId = randomUUID();
  const pipelineId = randomUUID();
  const stage = {
    ...base,
    type: 'opportunity.stage_changed',
    entity: { type: 'opportunity', id: randomUUID() },
    data: { fromStageId: null, fromPipelineId: null, toStageId: stageId, toPipelineId: pipelineId },
  };
  assert.doesNotThrow(() => parseEventInput(stage));
  assert.throws(() =>
    parseEventInput({
      ...stage,
      data: { ...stage.data, fromStageId: stageId, fromPipelineId: pipelineId },
    }),
  );
  assert.throws(() => parseEventInput({ ...stage, data: { toStageId: stageId } }));
  assert.throws(() =>
    parseEventInput({
      ...stage,
      type: 'opportunity.won',
      data: { previousStatus: 'won', status: 'won' },
    }),
  );
});
test('inbound message facts require matching internal message identity', () => {
  const id = randomUUID();
  const event = {
    ...base,
    type: 'customer.message_received',
    entity: { type: 'message', id },
    data: {
      messageId: id,
      contactId: randomUUID(),
      conversationId: randomUUID(),
      body: 'Hello',
      channel: 'sms',
    },
  };
  assert.doesNotThrow(() => parseEventInput(event));
  assert.throws(() =>
    parseEventInput({ ...event, data: { ...event.data, messageId: randomUUID() } }),
  );
  assert.throws(() => parseEventInput({ ...event, data: { ...event.data, sendNow: true } }));
});
test('invoice/job facts require an external identity and a related internal record', () => {
  const event = {
    ...base,
    type: 'invoice.paid',
    entity: { type: 'invoice', id: null },
    externalEntity: { type: 'invoice', id: 'inv-1' },
    relatedRecordIds: [randomUUID()],
    data: { amountMinor: 100, currency: 'USD' },
  };
  assert.doesNotThrow(() => parseEventInput(event));
  assert.throws(() => parseEventInput({ ...event, relatedRecordIds: [] }));
  assert.throws(() => parseEventInput({ ...event, data: { amountMinor: 1.5, currency: 'USD' } }));
  assert.throws(() =>
    parseEventInput({ ...event, data: { ...event.data, dueAt: '2026-02-30T12:00:00Z' } }),
  );
});
test('event data bounds and timestamps reject dangerous or ambiguous payloads', () => {
  assert.throws(() =>
    parseEventInput({ ...base, data: { changes: JSON.parse('{"__proto__":{"x":1}}') as unknown } }),
  );
  assert.throws(() => parseEventInput({ ...base, occurredAt: '2026-02-30T12:00:00Z' }));
  assert.throws(() => parseEventInput({ ...base, correlationId: 'not-uuid' }));
  assert.throws(() => parseEventInput({ ...base, data: { changes: { body: 'x'.repeat(10001) } } }));
  assert.equal(hash({ a: 1, b: 2 }), hash({ b: 2, a: 1 }));
});
test('external envelopes cannot choose organization, source or internal primary identifiers', () => {
  const event = {
    version: 2,
    id: '123',
    type: 'estimate.sent',
    occurredAt: base.occurredAt,
    entity: { type: 'estimate', externalRecordType: 'estimate', externalId: 'q1' },
    data: {},
  };
  assert.doesNotThrow(() => parseExternalChange(event));
  assert.throws(() => parseExternalChange({ ...event, organizationId: randomUUID() }));
  assert.throws(() =>
    parseExternalChange({ ...event, entity: { ...event.entity, id: randomUUID() } }),
  );
  const handler = {
    id: 'test.v1',
    types: ['contact.created' as const],
    handle: () => Promise.resolve(),
  };
  assert.throws(() => new EventRouter([handler, handler]));
});
