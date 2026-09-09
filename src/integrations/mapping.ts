import { hash, object, string, WorkforceError } from '../workforce/shared.js';

export function validateRaw(value: unknown, depth = 0): void {
  if (depth > 8) throw new WorkforceError(400, 'payload_too_deep');
  if (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return;
  if (typeof value === 'string' && value.length <= 16000) return;
  if (Array.isArray(value) && value.length <= 100) {
    value.forEach((item: unknown) => validateRaw(item, depth + 1));
    return;
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value);
    if (
      entries.length > 200 ||
      entries.some(([key]) => ['__proto__', 'constructor', 'prototype'].includes(key))
    )
      throw new WorkforceError(400, 'invalid_payload');
    entries.forEach(([, item]) => validateRaw(item, depth + 1));
    return;
  }
  throw new WorkforceError(400, 'invalid_payload');
}

export const sections = [
  'contact',
  'pipeline',
  'stage',
  'opportunity',
  'estimate',
  'appointment',
  'conversation',
  'message',
  'job',
  'invoice',
] as const;
const fields: Record<string, string[]> = {
  contact: ['external_id', 'name', 'first_name', 'last_name', 'email', 'phone', 'do_not_contact'],
  pipeline: ['external_id', 'name'],
  stage: ['external_id', 'name', 'position', 'outcome'],
  opportunity: ['external_id', 'title', 'amount_minor', 'currency', 'last_activity_at'],
  estimate: [
    'external_id',
    'number',
    'title',
    'amount_minor',
    'currency',
    'status',
    'issued_at',
    'expires_at',
    'accepted_at',
  ],
  appointment: ['external_id', 'title', 'starts_at', 'ends_at', 'timezone', 'location', 'status'],
  conversation: ['external_id', 'subject', 'channel'],
  message: ['external_id', 'body'],
  invoice: ['external_id', 'amount_minor', 'currency', 'due_at'],
  job: ['external_id', 'title'],
};
export function parseMapping(value: unknown): Record<string, string> {
  const map = object(value);
  if (Object.keys(map).length > 80) throw new WorkforceError(400, 'mapping_too_large');
  const allowed = [
    'event',
    'external_id',
    'occurred_at',
    ...sections.flatMap((s) => fields[s]!.map((f) => `${s}.${f}`)),
  ];
  return Object.fromEntries(
    Object.entries(map).map(([target, source]) => {
      const path = string(source, 160);
      if (
        !allowed.includes(target) ||
        !/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+){0,5}$/.test(path) ||
        path.split('.').some((p) => ['__proto__', 'prototype', 'constructor'].includes(p))
      )
        throw new WorkforceError(400, 'invalid_field_mapping');
      return [target, path];
    }),
  );
}
export function mapPayload(value: unknown, mapping: unknown): Record<string, unknown> {
  const raw = object(value);
  for (const key of ['organizationId', 'organization_id', 'source', 'provider'])
    if (raw[key] !== undefined) throw new WorkforceError(400, 'scope_fields_forbidden');
  if (raw.version !== 1) throw new WorkforceError(400, 'unsupported_integration_version');
  const result: Record<string, unknown> = {
    version: 1,
    event: raw.event,
    external_id: raw.external_id,
    occurred_at: raw.occurred_at,
  };
  for (const section of sections)
    if (raw[section] !== undefined) {
      const source = object(raw[section]);
      const selected: Record<string, unknown> = {};
      for (const field of fields[section]!) {
        const camel = field.replace(/_([a-z])/g, (_match, c: string) => c.toUpperCase());
        const v = Object.hasOwn(source, field)
          ? source[field]
          : Object.hasOwn(source, camel)
            ? source[camel]
            : field === 'external_id'
              ? source.id
              : undefined;
        if (v !== undefined) selected[field] = v;
      }
      result[section] = selected;
    }
  for (const [target, path] of Object.entries(parseMapping(mapping ?? {}))) {
    let v: unknown = raw;
    for (const part of path.split('.'))
      v =
        v && typeof v === 'object' && !Array.isArray(v) && Object.hasOwn(v, part)
          ? (v as Record<string, unknown>)[part]
          : undefined;
    if (v === undefined) continue;
    const [section, field] = target.split('.');
    if (field) {
      result[section!] ??= {};
      object(result[section!])[field] = v;
    } else result[target] = v;
  }
  return result;
}
export function nativeFields(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'external_id')
      .map(([key, v]) => {
        const field = key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
        if (
          ['amountMinor', 'position'].includes(field) &&
          typeof v === 'string' &&
          /^(0|[1-9]\d*)$/.test(v)
        )
          v = Number(v);
        if (field === 'doNotContact' && (v === 'true' || v === 'false')) v = v === 'true';
        return [field, v];
      }),
  );
}
export function safeSummary(value: unknown) {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  // Never retain arbitrary metadata, raw keys, field values, tokens, message bodies or HTTP headers.
  return {
    format: 'redacted-shape.v1',
    bodyHash: hash(raw),
    sections: sections.filter((s) => raw[s] !== undefined),
    fieldCount: Math.min(Object.keys(raw).length, 1000),
  };
}
