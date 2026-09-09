import { eventTypes } from '../events/contracts.js';
import { timezone } from '../crm/validation.js';
import { boolean, integer, keys, object, string, WorkforceError } from '../workforce/shared.js';

export const toolNames = [
  'get_business_knowledge',
  'get_contact',
  'get_opportunity',
  'get_estimate',
  'get_conversation',
  'send_message',
  'schedule_followup',
  'book_appointment',
  'create_task',
  'update_opportunity',
  'add_note',
  'notify_employee',
  'request_human_approval',
  'stop_agent_run',
  'record_recovery_decision',
  'send_recovery_message',
] as const;
export type ToolName = (typeof toolNames)[number];
export const subjectTypes = [
  'contact',
  'opportunity',
  'estimate',
  'conversation',
  'appointment',
  'task',
  'message',
] as const;
export type SubjectType = (typeof subjectTypes)[number];
export type Mode = 'AUTOPILOT' | 'COPILOT' | 'ADVISORY';
export interface Definition {
  version: 1;
  name: string;
  description: string;
  objective: string;
  businessContext: string;
  communicationStyle: string;
  mode: Mode;
  model: { provider: string; model: string };
  triggers: string[];
  eligibility: { entityTypes: SubjectType[]; statuses: string[]; staleAfterDays: number };
  permissions: { tool: ToolName; automatic: boolean }[];
  restrictedActions: ToolName[];
  escalationConditions: ('policy_denied' | 'customer_suppressed' | 'model_error')[];
  successCriteria: {
    kind: 'recommendation' | 'task_created' | 'note_added' | 'opportunity_updated';
    description: string;
  };
  followupStrategy: { enabled: boolean; delayMinutes: number };
  maximumAttempts: number;
  operatingHours: { timezone: string; days: number[]; startHour: number; endHour: number };
  enabledChannels: ('sms' | 'email')[];
  humanApprovalMode: 'all_mutations' | 'sensitive_only';
  context: { includeContactDetails: boolean; includeMessageContent: boolean };
  limits: {
    maxSteps: number;
    maxActions: number;
    maxRunSeconds: number;
    maxRunsPerDay: number;
    maxOutputTokens: number;
  };
}
export function choice<T extends string>(v: unknown, values: readonly T[]): T {
  if (typeof v !== 'string' || !values.includes(v as T))
    throw new WorkforceError(400, 'invalid_choice');
  return v as T;
}
function list<T>(value: unknown, parse: (item: unknown) => T, max = 20): T[] {
  if (!Array.isArray(value) || value.length > max) throw new WorkforceError(400, 'invalid_list');
  const result = value.map(parse);
  if (new Set(result.map((v) => JSON.stringify(v))).size !== result.length)
    throw new WorkforceError(400, 'duplicate_entry');
  return result;
}
function section(value: unknown, fields: string[]) {
  const v = object(value);
  keys(v, fields);
  return v;
}
export function parseDefinition(value: unknown): Definition {
  const v = section(value, [
    'version',
    'name',
    'description',
    'objective',
    'businessContext',
    'communicationStyle',
    'mode',
    'model',
    'triggers',
    'eligibility',
    'permissions',
    'restrictedActions',
    'escalationConditions',
    'successCriteria',
    'followupStrategy',
    'maximumAttempts',
    'operatingHours',
    'enabledChannels',
    'humanApprovalMode',
    'context',
    'limits',
  ]);
  if (v.version !== 1) throw new WorkforceError(400, 'unsupported_agent_version');
  const m = section(v.model, ['provider', 'model']);
  const e = section(v.eligibility, ['entityTypes', 'statuses', 'staleAfterDays']);
  const s = section(v.successCriteria, ['kind', 'description']);
  const f = section(v.followupStrategy, ['enabled', 'delayMinutes']);
  const h = section(v.operatingHours, ['timezone', 'days', 'startHour', 'endHour']);
  const c = section(v.context, ['includeContactDetails', 'includeMessageContent']);
  const l = section(v.limits, [
    'maxSteps',
    'maxActions',
    'maxRunSeconds',
    'maxRunsPerDay',
    'maxOutputTokens',
  ]);
  const definition: Definition = {
    version: 1,
    name: string(v.name, 120),
    description: string(v.description, 2000),
    objective: string(v.objective, 2000),
    businessContext: string(v.businessContext, 4000),
    communicationStyle: string(v.communicationStyle, 1000),
    mode: choice(v.mode, ['AUTOPILOT', 'COPILOT', 'ADVISORY']),
    model: { provider: string(m.provider, 50), model: string(m.model, 100) },
    triggers: list(v.triggers, (x) => choice(x, eventTypes)),
    eligibility: {
      entityTypes: list(e.entityTypes, (x) => choice(x, subjectTypes)),
      statuses: list(e.statuses, (x) => string(x, 40)),
      staleAfterDays: integer(e.staleAfterDays, 0, 365),
    },
    permissions: list(v.permissions, (x) => {
      const p = section(x, ['tool', 'automatic']);
      return { tool: choice(p.tool, toolNames), automatic: boolean(p.automatic) };
    }),
    restrictedActions: list(v.restrictedActions, (x) => choice(x, toolNames)),
    escalationConditions: list(v.escalationConditions, (x) =>
      choice(x, ['policy_denied', 'customer_suppressed', 'model_error']),
    ),
    successCriteria: {
      kind: choice(s.kind, ['recommendation', 'task_created', 'note_added', 'opportunity_updated']),
      description: string(s.description, 1000),
    },
    followupStrategy: {
      enabled: boolean(f.enabled),
      delayMinutes: integer(f.delayMinutes, 15, 525600),
    },
    maximumAttempts: integer(v.maximumAttempts, 1, 20),
    operatingHours: {
      timezone: timezone(h.timezone),
      days: list(h.days, (x) => integer(x, 0, 6), 7),
      startHour: integer(h.startHour, 0, 23),
      endHour: integer(h.endHour, 1, 24),
    },
    enabledChannels: list(v.enabledChannels, (x) => choice(x, ['sms', 'email']), 2),
    humanApprovalMode: choice(v.humanApprovalMode, ['all_mutations', 'sensitive_only']),
    context: {
      includeContactDetails: boolean(c.includeContactDetails),
      includeMessageContent: boolean(c.includeMessageContent),
    },
    limits: {
      maxSteps: integer(l.maxSteps, 1, 12),
      maxActions: integer(l.maxActions, 1, 6),
      maxRunSeconds: integer(l.maxRunSeconds, 30, 900),
      maxRunsPerDay: integer(l.maxRunsPerDay, 1, 100),
      maxOutputTokens: integer(l.maxOutputTokens, 256, 4096),
    },
  };
  if (
    !definition.eligibility.entityTypes.length ||
    !definition.operatingHours.days.length ||
    definition.operatingHours.startHour >= definition.operatingHours.endHour ||
    new Set(definition.permissions.map((p) => p.tool)).size !== definition.permissions.length
  )
    throw new WorkforceError(400, 'invalid_agent_definition');
  return definition;
}

// Nullable fixed fields make both the wire schema and local parsing closed and auditable.
export interface ToolInput {
  targetId: string | null;
  text: string | null;
  title: string | null;
  channel: string | null;
  dueAt: string | null;
  stageId: string | null;
  memberId: string | null;
}
export interface Decision {
  kind: 'tool' | 'finish';
  summary: string;
  tool: ToolName | null;
  input: ToolInput;
}
const inputFields = [
  'targetId',
  'text',
  'title',
  'channel',
  'dueAt',
  'stageId',
  'memberId',
] as const;
export function parseDecision(value: unknown): Decision {
  const v = section(value, ['kind', 'summary', 'tool', 'input']);
  const raw = section(v.input, [...inputFields]);
  const input = Object.fromEntries(
    inputFields.map((k) => [k, raw[k] === null ? null : string(raw[k], k === 'text' ? 2000 : 250)]),
  ) as unknown as ToolInput;
  const kind = choice(v.kind, ['tool', 'finish']);
  const tool = v.tool === null ? null : choice(v.tool, toolNames);
  if (
    (kind === 'tool') !== (tool !== null) ||
    (kind === 'finish' && Object.values(input).some((x) => x !== null))
  )
    throw new WorkforceError(400, 'invalid_decision');
  return { kind, summary: string(v.summary, 1000), tool, input };
}
export const decisionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'summary', 'tool', 'input'],
  properties: {
    kind: { type: 'string', enum: ['tool', 'finish'] },
    summary: { type: 'string', maxLength: 1000 },
    tool: { type: ['string', 'null'], enum: [...toolNames, null] },
    input: {
      type: 'object',
      additionalProperties: false,
      required: inputFields,
      properties: Object.fromEntries(
        inputFields.map((k) => [
          k,
          { type: ['string', 'null'], maxLength: k === 'text' ? 2000 : 250 },
        ]),
      ),
    },
  },
};
