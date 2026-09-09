/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registrations. */
/* eslint-disable @typescript-eslint/require-await -- Fake asynchronous transports. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { isOptOut, address } from './safety.js';
import { deliveryTransition, validTwilioSignature } from './contracts.js';
import { TwilioSmsProvider } from './providers.js';
for (const text of [
  'STOP',
  'STOPALL',
  'Unsubscribe',
  'cancel',
  'end',
  'quit',
  'ＳＴＯＰ',
  'Please remove me',
  'Don’t email me again',
  'no more messages',
])
  test(`hard opt-out: ${text}`, () => assert.equal(isOptOut(text), true));
test('normal questions are not implicit opt-ins/opt-outs', () => {
  assert.equal(isOptOut('I am interested in an appointment.'), false);
  assert.equal(isOptOut('START'), false);
});
test('addresses are strict and email matching is case-insensitive', () => {
  assert.equal(address('email', 'Person@Example.COM'), 'person@example.com');
  assert.throws(() => address('sms', '555 1234'));
  assert.throws(() => address('email', 'person@example.com\nBcc: other@example.com'));
});
test('delivery states do not regress on delayed acceptance callbacks', () => {
  assert.equal(deliveryTransition('delivered', 'accepted'), 'delivered');
  assert.equal(deliveryTransition('sent', 'accepted'), 'sent');
  assert.equal(deliveryTransition('accepted', 'queued'), 'accepted');
  assert.equal(deliveryTransition('unknown', 'delivered'), 'delivered');
});
test('Twilio signatures bind all parameters, destination route and secret', () => {
  const url = 'https://steel.example/inbound',
    body = { Body: 'Hello', From: '+12025550101' },
    secret = 'fake-secret';
  const signature = createHmac('sha1', secret)
    .update(url + 'BodyHelloFrom+12025550101')
    .digest('base64');
  assert.equal(validTwilioSignature(url, body, signature, secret), true);
  assert.equal(validTwilioSignature(url + '/other', body, signature, secret), false);
  assert.equal(validTwilioSignature(url, { ...body, Body: 'Changed' }, signature, secret), false);
  assert.equal(validTwilioSignature(url, body, signature, ''), false);
});
const input = {
  organizationId: 'test',
  idempotencyKey: 'logical-message',
  from: '+12025550101',
  to: '+12025550102',
  body: 'Reviewed message',
};
test('Twilio acceptance is not delivery and transport uses the fixed provider endpoint', async () => {
  const p = new TwilioSmsProvider('AC' + 'a'.repeat(32), 'fake-token', async (url, options) => {
    assert.ok(
      typeof url === 'string' && url.startsWith('https://api.twilio.com/2010-04-01/Accounts/AC'),
    );
    assert.equal(options?.redirect, 'error');
    assert.equal((options?.body as URLSearchParams).get('Body'), input.body);
    return new Response(JSON.stringify({ sid: 'SM' + 'b'.repeat(32), status: 'queued' }), {
      status: 201,
    });
  });
  assert.equal((await p.sendSms(input)).status, 'accepted');
});
test('timeouts and provider server errors never authorize retries', async () => {
  for (const fetcher of [
    async () => {
      throw new Error('timeout with possible acceptance');
    },
    async () => new Response('{}', { status: 503 }),
  ]) {
    const result = await new TwilioSmsProvider(
      'AC' + 'a'.repeat(32),
      'fake-token',
      fetcher,
    ).sendSms(input);
    assert.equal(result.status, 'unknown');
    assert.notEqual(result.retryable, true);
  }
});
test('only confirmed rate-limit rejection is retryable; provider DND is explicit', async () => {
  const retry = await new TwilioSmsProvider(
    'AC' + 'a'.repeat(32),
    'fake-token',
    async () => new Response('{"code":20429}', { status: 429 }),
  ).sendSms(input);
  assert.equal(retry.status, 'not_sent');
  assert.equal(retry.retryable, true);
  const blocked = await new TwilioSmsProvider(
    'AC' + 'a'.repeat(32),
    'fake-token',
    async () => new Response('{"code":21610}', { status: 400 }),
  ).sendSms(input);
  assert.equal(blocked.errorCode, 'provider_opt_out');
  assert.notEqual(blocked.retryable, true);
});
