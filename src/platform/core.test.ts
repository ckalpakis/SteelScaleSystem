/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registrations. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedInteger, databaseUrl, queueConnection, queuePrefix } from './config.js';
import { agentTrace } from './trace.js';
import type { AgentRun } from '@prisma/client';

test('deployment settings are bounded and existing database pool options are preserved', () => {
  assert.throws(() => boundedInteger('0', 5, 1, 50));
  assert.throws(() => boundedInteger('NaN', 5, 1, 50));
  assert.equal(boundedInteger(undefined, 5, 1, 50), 5);
  const url = new URL(
    databaseUrl('postgresql://user:pass@localhost/db?connection_limit=3&sslmode=require')!,
  );
  assert.equal(url.searchParams.get('connection_limit'), '3');
  assert.equal(url.searchParams.get('sslmode'), 'require');
  assert.equal(url.searchParams.get('pool_timeout'), '10');
  assert.throws(() => databaseUrl('http://localhost/db'));
});
test('Redis requires a valid URL, TLS stays verified, and namespace is constrained', () => {
  assert.throws(() => queueConnection(''));
  assert.throws(() => queueConnection('https://localhost'));
  assert.throws(() => queueConnection('redis://private-password@host:bad-port'), {
    message: 'Invalid connection URL',
  });
  const options = queueConnection('rediss://user:pass@localhost:6379/2');
  assert.deepEqual(options.tls, {});
  assert.equal(options.db, 2);
  assert.equal(options.maxRetriesPerRequest, null);
  const previous = process.env.QUEUE_PREFIX;
  try {
    process.env.QUEUE_PREFIX = 'bad:prefix';
    assert.throws(queuePrefix);
  } finally {
    if (previous === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = previous;
  }
});
test('agent log projection includes trace IDs without context contents or model reasoning', () => {
  const run = {
    id: 'run',
    organizationId: 'org',
    agentId: 'agent',
    eventId: 'event',
    correlationId: 'correlation',
    subjectId: 'opportunity',
  } as AgentRun;
  const trace = agentTrace(run, {
    subjectId: 'opportunity',
    fingerprint: 'hash',
    suppressed: false,
    records: [
      { id: 'contact', type: 'contact', version: 1, data: { phone: 'private' } },
      { id: 'opportunity', type: 'opportunity', version: 1, data: {} },
    ],
  });
  assert.equal(trace.contactId, 'contact');
  assert.equal(trace.opportunityId, 'opportunity');
  assert.equal(trace.correlationId, 'correlation');
  assert.equal(JSON.stringify(trace).includes('private'), false);
});
