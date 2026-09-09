/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registrations. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  parseEntity,
  parseField,
  validateFieldValue,
  timezone,
  timestamp,
  resource,
} from './validation.js';
import { money } from './views.js';

test('native contacts require no provider IDs and normalize email', () => {
  assert.deepEqual(parseEntity('contacts', { name: '  Alex  ', email: 'Alex@Example.test' }).data, {
    name: 'Alex',
    email: 'alex@example.test',
  });
  for (const input of [
    { name: '' },
    { name: 'Alex', organizationId: randomUUID() },
    { name: 'Alex', externalId: 'ghl-1' },
    { name: 'Alex', phone: '555' },
  ])
    assert.throws(() => parseEntity('contacts', input));
  assert.throws(() => resource('__proto__'));
});
test('optimistic versions and immutable fields are validated', () => {
  assert.throws(() => parseEntity('contacts', { name: 'Alex' }, true));
  assert.throws(() =>
    parseEntity('stages', { expectedVersion: 1, pipelineId: randomUUID() }, true),
  );
  assert.equal(
    parseEntity('contacts', { expectedVersion: 3, assignedMemberId: null }, true).expectedVersion,
    3,
  );
});
test('custom fields enforce typed values, options and real dates', () => {
  const cases = [
    { fieldType: 'text' as const, valid: 'Any industry', invalid: 2 },
    { fieldType: 'number' as const, valid: -1.25, invalid: '2' },
    { fieldType: 'boolean' as const, valid: false, invalid: 'false' },
    { fieldType: 'date' as const, valid: '2028-02-29', invalid: '2027-02-29' },
    { fieldType: 'single_select' as const, valid: 'A', invalid: 'C' },
    { fieldType: 'multi_select' as const, valid: ['A', 'B'], invalid: ['A', 'A'] },
  ];
  for (const c of cases) {
    const field = { fieldType: c.fieldType, options: ['A', 'B'] };
    assert.doesNotThrow(() => validateFieldValue(field, c.valid));
    assert.throws(() => validateFieldValue(field, c.invalid));
  }
  assert.throws(() =>
    parseField({
      entityType: 'contact',
      key: 'segment',
      label: 'Segment',
      fieldType: 'single_select',
    }),
  );
  assert.throws(() => parseField({ entityType: 'roof', key: 'x', label: 'X', fieldType: 'text' }));
});
test('appointments accept future zoned times, not ambiguous local timestamps', () => {
  assert.equal(timestamp('2030-01-01T10:00:00-05:00').toISOString(), '2030-01-01T15:00:00.000Z');
  assert.throws(() => timestamp('2030-01-01T10:00:00'));
  assert.throws(() => timestamp('2030-02-30T10:00:00Z'));
  assert.throws(() => timezone('not-a-zone'));
});
test('recorded message storage cannot impersonate delivery', () => {
  assert.throws(() =>
    parseEntity('messages', {
      conversationId: randomUUID(),
      direction: 'outbound',
      body: 'Hi',
      status: 'sent',
      occurredAt: new Date().toISOString(),
    }),
  );
});
test('money displays currency minor units without assuming every currency has cents', () => {
  assert.equal(money(12345, 'USD'), '$123.45');
  assert.equal(money(12345, 'JPY'), '¥12,345');
});
