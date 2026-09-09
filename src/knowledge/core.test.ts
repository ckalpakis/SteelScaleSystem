/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registrations. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { categories, categoryFields, parseDocument, parseEntry, riskFor } from './contracts.js';
import { claimSupported, tokens } from './retrieval.js';
for (const kind of categories)
  test(`structured category ${kind} is supported without permissions`, () => {
    const raw = {
      sourceId: randomUUID(),
      category: kind,
      audience: 'public',
      title: 'Reviewed fact',
      question: kind === 'faq' ? 'What services are offered?' : null,
      content: 'Our team offers maintenance.',
      facts: { [categoryFields[kind][0]]: 'Reviewed information' },
    };
    const entry = parseEntry(raw);
    assert.equal(entry.category, kind);
    assert.throws(() => parseEntry({ ...raw, facts: { allowedActions: ['send_message'] } }));
  });
test('FAQ requires a question; payloads cannot grant permissions or approve themselves', () => {
  const raw = {
    sourceId: randomUUID(),
    category: 'faq',
    title: 'Services',
    content: 'Maintenance',
    facts: {},
  };
  assert.throws(() => parseEntry(raw));
  assert.throws(() => parseEntry({ ...raw, question: 'Services?', approved: true }));
  assert.throws(() =>
    parseEntry({ ...raw, question: 'Services?', facts: { permissions: 'promise prices' } }),
  );
});
test('financial and warranty claims stay restricted even when mislabeled as an FAQ', () => {
  for (const text of [
    'Financing is available through ABC Finance.',
    'Your payment will be $199/month.',
    'We guarantee a lifetime warranty.',
    'We offer a discount.',
  ])
    assert.equal(riskFor('faq', text), 'restricted');
  assert.equal(
    claimSupported(
      'Financing is available through ABC Finance.',
      'Your payment will be $199/month.',
    ),
    false,
  );
  assert.equal(claimSupported('We serve Albany.', 'We serve Albany.'), true);
});
test('plain-text ingestion is bounded, path-safe and does not accept binary/document formats', () => {
  const raw = {
    sourceId: randomUUID(),
    filename: 'services.md',
    content: '# Services\nMaintenance',
  };
  assert.equal(parseDocument(raw).content, raw.content);
  for (const filename of [
    '../../secret.txt',
    'contract.pdf',
    'data.docx',
    'services.html',
    'image.png',
  ])
    assert.throws(() => parseDocument({ ...raw, filename }));
  assert.throws(() => parseDocument({ ...raw, content: 'x'.repeat(40001) }));
  assert.throws(() => parseDocument({ ...raw, content: 'é'.repeat(20001) }));
  assert.throws(() => parseDocument({ ...raw, content: 'binary\u0000data' }));
});
test('retrieval tokenization is bounded and removes generic question words', () => {
  assert.deepEqual(tokens('Do you offer HVAC maintenance?'), ['hvac', 'maintenance']);
  assert.ok(tokens(Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ')).length <= 20);
});
