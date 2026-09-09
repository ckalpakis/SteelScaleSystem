import { eventTypes } from '../events/contracts.js';
import {
  subjectTypes,
  toolNames,
  type Mode,
  type SubjectType,
  type ToolName,
} from '../agents/contracts.js';
import { timezone } from '../crm/validation.js';
import { object, WorkforceError } from '../workforce/shared.js';

export const businessActions = [
  'answer_approved_questions',
  'offer_discount',
  'negotiate_price',
  'other',
] as const;
export const actions = [...toolNames, ...businessActions] as const;
export type BlueprintAction = (typeof actions)[number];
export const conditions = [
  'status',
  'amount_minor',
  'inactive_days',
  'elapsed_minutes',
  'other',
] as const;
export const operators = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in'] as const;
export const escalationConditions = [
  'policy_denied',
  'customer_suppressed',
  'model_error',
  'pricing_negotiation',
  'customer_requests_human',
  'other',
] as const;
export const routes = ['review_queue', 'assigned_salesperson', 'selected_employee'] as const;
export const stops = [
  'action_limit',
  'customer_opt_out',
  'goal_met',
  'customer_replied',
  'estimate_accepted',
  'human_handoff',
  'other',
] as const;
export const goals = [
  'recommendation',
  'task_created',
  'note_added',
  'opportunity_updated',
  'estimate_recovered',
  'appointment_booked',
  'other',
] as const;
export const channels = ['sms', 'email', 'phone', 'webchat'] as const;
export interface AgentBlueprint {
  schemaVersion: 1;
  name: string | null;
  objective: string | null;
  businessContext: string | null;
  communicationStyle: string | null;
  eligibleEntityTypes: SubjectType[];
  triggerEvent: string | null;
  triggerConditions: {
    field: (typeof conditions)[number];
    operator: (typeof operators)[number];
    value: string | null;
    number: number | null;
    values: string[];
  }[];
  delayMinutes: number | null;
  cadence: {
    enabled: boolean | null;
    intervalMinutes: number | null;
    maximumAttempts: number | null;
  };
  allowedActions: BlueprintAction[];
  automaticActions: ToolName[];
  prohibitedActions: BlueprintAction[];
  escalationRules: {
    condition: (typeof escalationConditions)[number];
    route: (typeof routes)[number] | null;
    memberId: string | null;
  }[];
  communicationChannels: (typeof channels)[number][];
  successCriteria: { kind: (typeof goals)[number] | null; description: string | null };
  stopConditions: (typeof stops)[number][];
  operatingHours: {
    timezone: string | null;
    days: number[];
    startHour: number | null;
    endHour: number | null;
  } | null;
  knowledgeRequirements: { name: string; content: string | null; approved: boolean }[];
  currency: string | null;
  mode: Mode | null;
  humanApprovalMode: 'all_mutations' | 'sensitive_only' | null;
  runtimeModel: string | null;
  missingConfiguration: string[];
  unsupportedRequests: string[];
}
interface Spec {
  type: 'object' | 'array' | 'string' | 'integer' | 'boolean';
  nullable?: boolean;
  values?: readonly (string | number)[];
  fields?: Record<string, Spec>;
  items?: Spec;
  max?: number;
  min?: number;
}
const text = (max = 500, nullable = true): Spec => ({ type: 'string', max, nullable });
const enumeration = (values: readonly (string | number)[], nullable = false): Spec => ({
  type: 'string',
  values,
  nullable,
});
const number = (min: number, max: number, nullable = true): Spec => ({
  type: 'integer',
  min,
  max,
  nullable,
});
const bool = (nullable = false): Spec => ({ type: 'boolean', nullable });
const list = (items: Spec, max = 20): Spec => ({ type: 'array', items, max });
const group = (fields: Record<string, Spec>, nullable = false): Spec => ({
  type: 'object',
  fields,
  nullable,
});
const specification = group({
  schemaVersion: { type: 'integer', values: [1] },
  name: text(120),
  objective: text(2000),
  businessContext: text(3000),
  communicationStyle: text(1000),
  eligibleEntityTypes: list(enumeration(subjectTypes), 7),
  triggerEvent: enumeration(eventTypes, true),
  triggerConditions: list(
    group({
      field: enumeration(conditions),
      operator: enumeration(operators),
      value: text(100),
      number: number(0, 2147483647),
      values: list(text(100, false)),
    }),
  ),
  delayMinutes: number(0, 525600),
  cadence: group({
    enabled: bool(true),
    intervalMinutes: number(15, 525600),
    maximumAttempts: number(1, 20),
  }),
  allowedActions: list(enumeration(actions)),
  automaticActions: list(enumeration(toolNames)),
  prohibitedActions: list(enumeration(actions)),
  escalationRules: list(
    group({
      condition: enumeration(escalationConditions),
      route: enumeration(routes, true),
      memberId: text(36),
    }),
  ),
  communicationChannels: list(enumeration(channels), 4),
  successCriteria: group({ kind: enumeration(goals, true), description: text(1000) }),
  stopConditions: list(enumeration(stops)),
  operatingHours: group(
    {
      timezone: text(100),
      days: list(number(0, 6, false), 7),
      startHour: number(0, 23),
      endHour: number(1, 24),
    },
    true,
  ),
  knowledgeRequirements: list(
    group({ name: text(150, false), content: text(2000), approved: bool() }),
    10,
  ),
  currency: text(3),
  mode: enumeration(['AUTOPILOT', 'COPILOT', 'ADVISORY'], true),
  humanApprovalMode: enumeration(['all_mutations', 'sensitive_only'], true),
  runtimeModel: text(100),
  missingConfiguration: list(text(300, false)),
  unsupportedRequests: list(text(300, false)),
});
function schema(spec: Spec): unknown {
  return {
    type: spec.nullable ? [spec.type, 'null'] : spec.type,
    ...(spec.values ? { enum: spec.nullable ? [...spec.values, null] : spec.values } : {}),
    ...(spec.type === 'object'
      ? {
          properties: Object.fromEntries(
            Object.entries(spec.fields!).map(([k, v]) => [k, schema(v)]),
          ),
          required: Object.keys(spec.fields!),
          additionalProperties: false,
        }
      : {}),
    ...(spec.type === 'array' ? { items: schema(spec.items!), maxItems: spec.max } : {}),
    ...(spec.type === 'string' && spec.max ? { maxLength: spec.max } : {}),
    ...(spec.type === 'integer'
      ? {
          ...(spec.min !== undefined ? { minimum: spec.min } : {}),
          ...(spec.max !== undefined ? { maximum: spec.max } : {}),
        }
      : {}),
  };
}
export const blueprintSchema = schema(specification);
function validate(spec: Spec, value: unknown, path = 'blueprint'): unknown {
  const fail = (): never => {
    throw new WorkforceError(400, `invalid_blueprint:${path}`);
  };
  if (value === null) {
    if (spec.nullable) return null;
    return fail();
  }
  if (spec.values && !spec.values.includes(value as string | number)) return fail();
  if (spec.type === 'object') {
    const raw = object(value),
      fields = spec.fields!;
    if (
      Object.getPrototypeOf(raw) !== Object.prototype ||
      Object.keys(raw).some((k) => !Object.hasOwn(fields, k))
    )
      return fail();
    return Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, validate(v, raw[k], `${path}.${k}`)]),
    );
  }
  if (spec.type === 'array') {
    if (!Array.isArray(value) || value.length > spec.max!) return fail();
    const result = value.map((v, i) => validate(spec.items!, v, `${path}.${i}`));
    if (new Set(result.map((v) => JSON.stringify(v))).size !== result.length) return fail();
    return result;
  }
  if (spec.type === 'string') {
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      (spec.max !== undefined && value.length > spec.max)
    )
      return fail();
    return value.trim();
  }
  if (spec.type === 'integer') {
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      (spec.min !== undefined && value < spec.min) ||
      (spec.max !== undefined && value > spec.max)
    )
      return fail();
    return value;
  }
  if (typeof value !== 'boolean') return fail();
  return value;
}
export function parseBlueprint(value: unknown): AgentBlueprint {
  const result = validate(specification, value) as AgentBlueprint;
  if (result.currency && !/^[A-Z]{3}$/.test(result.currency))
    throw new WorkforceError(400, 'invalid_blueprint:currency');
  if (result.operatingHours?.timezone) timezone(result.operatingHours.timezone);
  return result;
}
export function blankBlueprint(): AgentBlueprint {
  return {
    schemaVersion: 1,
    name: null,
    objective: null,
    businessContext: null,
    communicationStyle: null,
    eligibleEntityTypes: [],
    triggerEvent: null,
    triggerConditions: [],
    delayMinutes: null,
    cadence: { enabled: null, intervalMinutes: null, maximumAttempts: null },
    allowedActions: [],
    automaticActions: [],
    prohibitedActions: [],
    escalationRules: [],
    communicationChannels: [],
    successCriteria: { kind: null, description: null },
    stopConditions: [],
    operatingHours: null,
    knowledgeRequirements: [],
    currency: null,
    mode: null,
    humanApprovalMode: null,
    runtimeModel: null,
    missingConfiguration: [],
    unsupportedRequests: [],
  };
}
