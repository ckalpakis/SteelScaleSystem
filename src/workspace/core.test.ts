/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceFilters } from './service.js';
import { money } from '../crm/views.js';

test('workspace filters are bounded and default salesperson work to assigned handoffs', () => {
  assert.deepEqual(workspaceFilters(undefined, undefined, 'member'), { days: 30, queue: 'mine' });
  assert.deepEqual(workspaceFilters('7', 'unassigned', 'owner'), { days: 7, queue: 'unassigned' });
  assert.deepEqual(workspaceFilters(undefined, undefined, 'admin'), { days: 30, queue: 'all' });
  for (const days of ['0', '365', ['30'], {}, 30, '30 days'])
    assert.throws(() => workspaceFilters(days, undefined));
  for (const queue of ['other-org', ['mine'], {}, 1])
    assert.throws(() => workspaceFilters(undefined, queue));
});
test('commercial money formatting respects currency minor units', () => {
  assert.equal(money(12345, 'USD'), '$123.45');
  assert.equal(money(12345, 'JPY'), '¥12,345');
  assert.match(money(12345, 'KWD'), /12\.345/);
});
