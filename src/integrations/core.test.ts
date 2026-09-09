/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mapPayload, nativeFields, parseMapping, safeSummary, validateRaw } from './mapping.js';
import { seal, unseal, signature, webhookUrl } from './security.js';
import { retryDelay } from './worker.js';
process.env.INTEGRATION_ENCRYPTION_KEY = 'a'.repeat(64);
test('mapping supports vendor paths, optional fields and safe numeric conversions', () => {
  const result = mapPayload(
    { version: 1, kind: 'contact.created', customer: { id: 'c1', full_name: 'Alex' } },
    { event: 'kind', 'contact.external_id': 'customer.id', 'contact.name': 'customer.full_name' },
  );
  assert.deepEqual(result.contact, { external_id: 'c1', name: 'Alex' });
  assert.deepEqual(nativeFields({ amount_minor: '1200', do_not_contact: 'true', email: null }), {
    amountMinor: 1200,
    doNotContact: true,
    email: null,
  });
  assert.deepEqual(mapPayload({ version: 1, contact: { id: '1', email: null } }, {}).contact, {
    external_id: '1',
    email: null,
  });
});
test('mapping rejects tenant spoofing and prototype paths', () => {
  assert.throws(() => mapPayload({ version: 1, organization_id: 'other' }, {}));
  assert.throws(() => parseMapping({ 'contact.name': '__proto__.name' }));
  assert.throws(() => parseMapping({ organizationId: 'tenant' }));
  assert.throws(() => mapPayload({ version: 2 }, {}));
  let deep: unknown = {};
  for (let i = 0; i < 10; i++) deep = { nested: deep };
  assert.throws(() => validateRaw(deep));
});
test('diagnostic summaries never store arbitrary fields, tokens, names or message text', () => {
  const summary = JSON.stringify(
    safeSummary({
      version: 1,
      contact: { name: 'Private Person' },
      metadata: { token: 'secret-token' },
      message: { body: 'Sensitive message' },
    }),
  );
  assert.ok(!summary.includes('Private'));
  assert.ok(!summary.includes('Sensitive'));
  assert.ok(!summary.includes('secret-token'));
  assert.ok(summary.includes('bodyHash'));
});
test('webhook secrets use authenticated encryption scoped to organization and endpoint', () => {
  const encrypted = seal('secret-url', 'tenant:endpoint');
  assert.ok(!encrypted.includes('secret-url'));
  assert.equal(unseal(encrypted, 'tenant:endpoint'), 'secret-url');
  assert.throws(() => unseal(encrypted, 'other:endpoint'));
  assert.notEqual(seal('secret-url', 'tenant:endpoint'), encrypted);
});
test('outbound URLs require public HTTPS without credentials, redirects or literal addresses', () => {
  assert.equal(
    webhookUrl('https://hooks.zapier.com/hooks/catch/123/secret/').hostname,
    'hooks.zapier.com',
  );
  for (const url of [
    'http://example.com',
    'https://localhost',
    'https://127.0.0.1',
    'https://[::1]',
    'https://169.254.169.254/',
    'https://service.internal/',
    'https://user:pass@example.com/',
    'https://example.com:8443/',
    'https://example.com/#secret',
  ])
    assert.throws(() => webhookUrl(url));
});
test('signatures cover exact timestamp/body and retry delay is exponential and capped', () => {
  assert.equal(
    signature('secret', '123', '{}'),
    `v1=${createHmac('sha256', 'secret').update('123.{}').digest('hex')}`,
  );
  assert.notEqual(signature('secret', '124', '{}'), signature('secret', '123', '{}'));
  assert.equal(retryDelay(2), retryDelay(1) * 2);
  assert.equal(retryDelay(100), 3600000);
});
