import {
  boolean,
  integer,
  keys,
  object,
  string,
  uuid,
  WorkforceError,
} from '../workforce/shared.js';
export const categoryFields = {
  company: ['name', 'phone', 'email', 'website', 'description'],
  services: ['names', 'description'],
  service_areas: ['areas', 'exclusions'],
  business_hours: ['timezone', 'hours', 'exceptions'],
  pricing: ['rules', 'currency', 'limitations'],
  financing: ['provider', 'availability', 'limitations'],
  warranties: ['coverage', 'duration', 'exclusions'],
  faq: ['answer'],
  scheduling: ['rules', 'leadTime', 'cancellation'],
  offers: ['description', 'validUntil', 'conditions'],
  policies: ['description', 'conditions'],
  employees: ['name', 'role', 'publicContact'],
  products: ['name', 'description'],
  service_descriptions: ['name', 'description'],
  escalation_contacts: ['name', 'role', 'contact'],
  communication_template: ['topic'],
} as const;
export type Category = keyof typeof categoryFields;
export const categories = Object.keys(categoryFields) as Category[];
export function category(value: unknown): Category {
  if (typeof value !== 'string' || !categories.includes(value as Category))
    throw new WorkforceError(400, 'invalid_knowledge_category');
  return value as Category;
}
export function riskFor(kind: Category, content: string) {
  return [
    'pricing',
    'financing',
    'warranties',
    'offers',
    'policies',
    'scheduling',
    'employees',
    'escalation_contacts',
  ].includes(kind) ||
    /\$|\b(?:financ\w*|warrant\w*|guarantee\w*|discount\w*|insurance|legal|payment|APR|interest rate|refund|permission|ignore.*instructions|system prompt)\b/i.test(
      content,
    )
    ? 'restricted'
    : 'general';
}
export function parseEntry(raw: unknown, updating = false) {
  const v = object(raw);
  keys(v, [
    'sourceId',
    'documentId',
    'category',
    'audience',
    'title',
    'question',
    'content',
    'facts',
    ...(updating ? ['expectedRevision'] : []),
  ]);
  const kind = category(v.category),
    facts = object(v.facts ?? {});
  keys(facts, [...categoryFields[kind]]);
  for (const value of Object.values(facts)) {
    if (Array.isArray(value)) {
      if (value.length > 30) throw new WorkforceError(400, 'too_many_knowledge_values');
      value.forEach((x) => string(x, 500));
    } else string(value, 2000);
  }
  const audience = v.audience ?? 'internal';
  if (audience !== 'public' && audience !== 'internal')
    throw new WorkforceError(400, 'invalid_knowledge_audience');
  const content = string(v.content, 4000),
    title = string(v.title, 160),
    question = v.question == null || v.question === '' ? null : string(v.question, 500);
  if (kind === 'faq' && !question) throw new WorkforceError(400, 'faq_question_required');
  return {
    sourceId: uuid(v.sourceId),
    documentId: v.documentId == null || v.documentId === '' ? null : uuid(v.documentId),
    category: kind,
    audience,
    title,
    question,
    content,
    facts,
    risk: riskFor(kind, `${title} ${question ?? ''} ${content} ${JSON.stringify(facts)}`),
    expectedRevision: updating ? integer(v.expectedRevision, 1, 2147483646) : 0,
  };
}
export function parseToggle(raw: unknown) {
  const v = object(raw);
  keys(v, ['active', 'expectedRevision']);
  return {
    active: boolean(v.active),
    expectedRevision: integer(v.expectedRevision, 1, 2147483646),
  };
}
export function parseDocument(raw: unknown) {
  const v = object(raw);
  keys(v, ['sourceId', 'filename', 'content']);
  const filename = string(v.filename, 100),
    content = string(v.content, 40000);
  if (
    !/^[\p{L}\p{N} _.-]+\.(txt|md)$/iu.test(filename) ||
    filename.includes('..') ||
    Buffer.byteLength(content, 'utf8') > 40000 ||
    [...content].some((c) => c.charCodeAt(0) < 32 && !['\t', '\n', '\r'].includes(c))
  )
    throw new WorkforceError(400, 'plain_text_document_required');
  return { sourceId: uuid(v.sourceId), filename, content };
}
