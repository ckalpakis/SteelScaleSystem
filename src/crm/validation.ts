import { CrmEntityType, CustomFieldType } from '@prisma/client';
import {
  boolean,
  currency,
  integer,
  keys,
  object,
  string,
  uuid,
  WorkforceError,
} from '../workforce/shared.js';

export const resources = {
  contacts: 'contact',
  companies: 'company',
  opportunities: 'opportunity',
  pipelines: 'pipeline',
  stages: 'pipeline_stage',
  estimates: 'estimate',
  appointments: 'appointment',
  tasks: 'task',
  notes: 'note',
  conversations: 'conversation',
  messages: 'message',
  tags: 'tag',
} as const;
export type Resource = keyof typeof resources;
export type EntityType = (typeof resources)[Resource];
type Parser = (value: unknown) => unknown;
const text: Parser = (v) => string(v, 250);
const longText: Parser = (v) => string(v, 10000);
const id: Parser = uuid;
const amount: Parser = (v) => integer(v, 0, 2_147_483_647);
const optional =
  (parse: Parser): Parser =>
  (v) =>
    v === null ? null : parse(v);
const choice =
  (...values: string[]): Parser =>
  (v) => {
    if (typeof v !== 'string' || !values.includes(v))
      throw new WorkforceError(400, 'invalid_choice');
    return v;
  };
export function timestamp(value: unknown): Date {
  const raw = string(value, 40);
  const result = new Date(raw);
  const day = raw.slice(0, 10);
  if (
    !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(raw) ||
    !Number.isFinite(result.getTime()) ||
    !Number.isFinite(Date.parse(day)) ||
    new Date(day).toISOString().slice(0, 10) !== day
  ) {
    throw new WorkforceError(400, 'invalid_timestamp');
  }
  return result;
}
export function timezone(value: unknown): string {
  const zone = string(value, 100);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format();
  } catch {
    throw new WorkforceError(400, 'invalid_timezone');
  }
  return zone;
}
const email: Parser = (v) => {
  const result = string(v, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw new WorkforceError(400, 'invalid_email');
  return result;
};
const phone: Parser = (v) => {
  const result = string(v, 30);
  if (!/^\+[1-9]\d{7,14}$/.test(result)) throw new WorkforceError(400, 'invalid_phone');
  return result;
};
const specs: Record<
  Resource,
  {
    fields: Record<string, Parser>;
    required: string[];
    defaults?: Record<string, unknown>;
    immutable?: string[];
  }
> = {
  contacts: {
    fields: {
      name: text,
      firstName: optional(text),
      lastName: optional(text),
      email: optional(email),
      phone: optional(phone),
      companyId: optional(id),
      doNotContact: boolean,
    },
    required: ['name'],
  },
  companies: {
    fields: {
      name: text,
      domain: optional((v) => {
        const domain = string(v, 253).toLowerCase();
        if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(domain))
          throw new WorkforceError(400, 'invalid_domain');
        return domain;
      }),
      email: optional(email),
      phone: optional(phone),
    },
    required: ['name'],
  },
  opportunities: {
    fields: {
      title: text,
      customerId: id,
      companyId: optional(id),
      pipelineId: id,
      stageId: id,
      amountMinor: amount,
      currency,
      lastActivityAt: timestamp,
    },
    required: ['title', 'customerId', 'pipelineId', 'stageId', 'amountMinor', 'currency'],
  },
  pipelines: { fields: { name: text, description: optional(longText) }, required: ['name'] },
  stages: {
    fields: {
      name: text,
      pipelineId: id,
      position: (v) => integer(v, 0, 1000000),
      outcome: choice('open', 'won', 'lost'),
    },
    required: ['name', 'pipelineId', 'position'],
    immutable: ['pipelineId'],
    defaults: { outcome: 'open' },
  },
  estimates: {
    fields: {
      number: text,
      title: text,
      opportunityId: id,
      status: choice('draft', 'sent', 'accepted', 'declined', 'expired'),
      amountMinor: amount,
      currency,
      issuedAt: optional(timestamp),
      expiresAt: optional(timestamp),
      acceptedAt: optional(timestamp),
    },
    required: ['number', 'title', 'opportunityId', 'amountMinor', 'currency'],
    immutable: ['opportunityId', 'currency'],
    defaults: { status: 'draft' },
  },
  appointments: {
    fields: {
      title: text,
      contactId: id,
      opportunityId: optional(id),
      startsAt: timestamp,
      endsAt: timestamp,
      timezone,
      location: optional(text),
      status: choice('scheduled', 'completed', 'cancelled', 'no_show'),
    },
    required: ['title', 'contactId', 'startsAt', 'endsAt', 'timezone'],
    defaults: { status: 'scheduled' },
  },
  tasks: {
    fields: {
      title: text,
      description: optional(longText),
      status: choice('open', 'in_progress', 'completed', 'cancelled'),
      priority: choice('low', 'normal', 'high', 'urgent'),
      dueAt: optional(timestamp),
      relatedRecordId: optional(id),
    },
    required: ['title'],
    defaults: { status: 'open', priority: 'normal' },
  },
  notes: {
    fields: { body: longText, relatedRecordId: id },
    required: ['body', 'relatedRecordId'],
    immutable: ['relatedRecordId'],
  },
  conversations: {
    fields: {
      subject: text,
      contactId: id,
      channel: choice('email', 'sms', 'phone', 'web', 'other'),
      status: choice('open', 'closed'),
    },
    required: ['subject', 'contactId', 'channel'],
    immutable: ['contactId', 'channel'],
    defaults: { status: 'open' },
  },
  messages: {
    fields: {
      conversationId: id,
      direction: choice('inbound', 'outbound', 'internal'),
      body: longText,
      status: choice('recorded', 'draft'),
      occurredAt: timestamp,
    },
    required: ['conversationId', 'direction', 'body', 'occurredAt'],
    immutable: ['conversationId', 'direction', 'occurredAt'],
    defaults: { status: 'recorded' },
  },
  tags: {
    fields: {
      name: text,
      color: (v) => {
        const value = string(v, 7);
        if (!/^#[a-f0-9]{6}$/i.test(value)) throw new WorkforceError(400, 'invalid_color');
        return value;
      },
    },
    required: ['name'],
    defaults: { color: '#526174' },
  },
};

export function resource(value: unknown): Resource {
  if (typeof value !== 'string' || !Object.hasOwn(resources, value))
    throw new WorkforceError(404, 'resource_not_found');
  return value as Resource;
}
export function entityType(value: unknown): EntityType {
  if (typeof value !== 'string' || !Object.values(CrmEntityType).includes(value as EntityType))
    throw new WorkforceError(400, 'invalid_entity_type');
  return value as EntityType;
}
export interface EntityInput {
  data: Record<string, unknown>;
  expectedVersion?: number;
  assignedMemberId?: string | null;
  tagIds?: string[];
  customFields?: Record<string, unknown>;
}
export function parseEntity(kind: Resource, value: unknown, updating = false): EntityInput {
  const raw = object(value);
  const spec = specs[kind];
  keys(raw, [
    ...Object.keys(spec.fields),
    'assignedMemberId',
    'tagIds',
    'customFields',
    ...(updating ? ['expectedVersion'] : []),
  ]);
  if (!updating && spec.required.some((key) => raw[key] === undefined))
    throw new WorkforceError(400, 'required_field_missing');
  if (updating && spec.immutable?.some((key) => Object.hasOwn(raw, key)))
    throw new WorkforceError(400, 'immutable_field');
  const data: Record<string, unknown> = updating ? {} : { ...spec.defaults };
  for (const [key, parse] of Object.entries(spec.fields))
    if (raw[key] !== undefined) data[key] = parse(raw[key]);
  const result: EntityInput = { data };
  if (updating) result.expectedVersion = integer(raw.expectedVersion, 1, 2_147_483_646);
  if (raw.assignedMemberId !== undefined)
    result.assignedMemberId = raw.assignedMemberId === null ? null : uuid(raw.assignedMemberId);
  if (raw.tagIds !== undefined) {
    if (!Array.isArray(raw.tagIds) || raw.tagIds.length > 30)
      throw new WorkforceError(400, 'invalid_tags');
    result.tagIds = [...new Set(raw.tagIds.map(uuid))];
  }
  if (raw.customFields !== undefined) {
    const values = object(raw.customFields);
    if (Object.keys(values).length > 100) throw new WorkforceError(400, 'too_many_custom_fields');
    for (const key of Object.keys(values)) uuid(key);
    result.customFields = values;
  }
  return result;
}

export function parseField(value: unknown) {
  const raw = object(value);
  keys(raw, ['entityType', 'key', 'label', 'fieldType', 'required', 'options']);
  const key = string(raw.key, 64);
  if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new WorkforceError(400, 'invalid_field_key');
  const fieldType = string(raw.fieldType) as CustomFieldType;
  if (!Object.values(CustomFieldType).includes(fieldType))
    throw new WorkforceError(400, 'invalid_field_type');
  const options = raw.options === undefined ? [] : raw.options;
  if (!Array.isArray(options) || options.length > 100)
    throw new WorkforceError(400, 'invalid_options');
  const normalized = options.map((v: unknown) => string(v, 100));
  if (
    new Set(normalized).size !== normalized.length ||
    (['single_select', 'multi_select'].includes(fieldType)
      ? normalized.length === 0
      : normalized.length !== 0)
  )
    throw new WorkforceError(400, 'invalid_options');
  return {
    entityType: entityType(raw.entityType),
    key,
    label: string(raw.label),
    fieldType,
    required: raw.required === undefined ? false : boolean(raw.required),
    options: normalized,
  };
}

export function validateFieldValue(
  field: { fieldType: CustomFieldType; options: string[] },
  value: unknown,
): void {
  let valid = false;
  switch (field.fieldType) {
    case 'text':
      valid = typeof value === 'string' && value.length <= 10000;
      break;
    case 'number':
      valid =
        typeof value === 'number' &&
        Number.isFinite(value) &&
        Math.abs(value) <= Number.MAX_SAFE_INTEGER;
      break;
    case 'boolean':
      valid = typeof value === 'boolean';
      break;
    case 'date':
      valid =
        typeof value === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        Number.isFinite(Date.parse(value)) &&
        new Date(value).toISOString().slice(0, 10) === value;
      break;
    case 'single_select':
      valid = typeof value === 'string' && field.options.includes(value);
      break;
    case 'multi_select':
      valid =
        Array.isArray(value) &&
        value.length <= 100 &&
        new Set(value).size === value.length &&
        value.every((v: unknown) => typeof v === 'string' && field.options.includes(v));
      break;
  }
  if (!valid) throw new WorkforceError(400, 'invalid_custom_field_value');
}
