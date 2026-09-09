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
import { timezone } from '../crm/validation.js';

export const intents = [
  'interested',
  'not_interested',
  'price_objection',
  'competitor_comparison',
  'timing',
  'needs_spouse_or_partner',
  'financing_question',
  'scheduling_request',
  'information_request',
  'pricing_negotiation',
  'angry_customer',
  'legal_or_compliance',
  'wrong_person',
  'opt_out',
  'unknown',
] as const;
export type Intent = (typeof intents)[number];
export const mandatoryHandoffs: readonly Intent[] = [
  'pricing_negotiation',
  'angry_customer',
  'legal_or_compliance',
  'wrong_person',
  'unknown',
];
export function one<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T))
    throw new WorkforceError(400, 'invalid_recovery_choice');
  return value as T;
}
function list<T>(value: unknown, parse: (v: unknown) => T, max = 30): T[] {
  if (!Array.isArray(value) || value.length > max)
    throw new WorkforceError(400, 'invalid_recovery_list');
  const result = value.map(parse);
  if (new Set(result.map((v) => JSON.stringify(v))).size !== result.length)
    throw new WorkforceError(400, 'duplicate_recovery_item');
  return result;
}
export interface RecoveryConfig {
  version: 1;
  name: string;
  model: string;
  mode: 'AUTOPILOT' | 'COPILOT' | 'ADVISORY';
  minimumValueMinor: number;
  currency: string;
  pipelineIds: string[];
  stageIds: string[];
  delayMinutes: number;
  cadenceMinutes: number[];
  maximumAttempts: number;
  channels: ('sms' | 'email')[];
  workingHours: { timezone: string; days: number[]; startHour: number; endHour: number };
  employeeQuietMinutes: number;
  attributionDays: number;
  allowedObjections: Intent[];
  restrictedTopics: Intent[];
  handoffConditions: Intent[];
  knowledge: {
    key: string;
    topic: Intent | 'initial' | 'followup';
    text: string;
    approved: boolean;
    versionId?: string;
  }[];
}
export function parseConfig(value: unknown): RecoveryConfig {
  const v = object(value);
  keys(v, [
    'version',
    'name',
    'model',
    'mode',
    'minimumValueMinor',
    'currency',
    'pipelineIds',
    'stageIds',
    'delayMinutes',
    'cadenceMinutes',
    'maximumAttempts',
    'channels',
    'workingHours',
    'employeeQuietMinutes',
    'attributionDays',
    'allowedObjections',
    'restrictedTopics',
    'handoffConditions',
    'knowledge',
  ]);
  if (v.version !== 1) throw new WorkforceError(400, 'unsupported_recovery_version');
  const h = object(v.workingHours);
  keys(h, ['timezone', 'days', 'startHour', 'endHour']);
  const result: RecoveryConfig = {
    version: 1,
    name: string(v.name, 120),
    model: string(v.model, 100),
    mode: one(v.mode, ['AUTOPILOT', 'COPILOT', 'ADVISORY']),
    minimumValueMinor: integer(v.minimumValueMinor, 0, 2147483647),
    currency: currency(v.currency),
    pipelineIds: list(v.pipelineIds, uuid),
    stageIds: list(v.stageIds, uuid),
    delayMinutes: integer(v.delayMinutes, 15, 525600),
    // Cadence is an ordered sequence: repeated intervals are valid.
    cadenceMinutes:
      Array.isArray(v.cadenceMinutes) && v.cadenceMinutes.length <= 9
        ? v.cadenceMinutes.map((n) => integer(n, 60, 525600))
        : (() => {
            throw new WorkforceError(400, 'invalid_cadence');
          })(),
    maximumAttempts: integer(v.maximumAttempts, 1, 10),
    channels: list(v.channels, (x) => one(x, ['sms', 'email']), 2),
    workingHours: {
      timezone: timezone(h.timezone),
      days: list(h.days, (n) => integer(n, 0, 6), 7),
      startHour: integer(h.startHour, 0, 23),
      endHour: integer(h.endHour, 1, 24),
    },
    employeeQuietMinutes: integer(v.employeeQuietMinutes, 15, 10080),
    attributionDays: integer(v.attributionDays, 1, 90),
    allowedObjections: list(v.allowedObjections, (x) => one(x, intents)),
    restrictedTopics: list(v.restrictedTopics, (x) => one(x, intents)),
    handoffConditions: list(v.handoffConditions, (x) => one(x, intents)),
    knowledge: list(
      v.knowledge,
      (x) => {
        const k = object(x);
        keys(k, ['key', 'topic', 'text', 'approved', 'versionId']);
        return {
          key: string(k.key, 50),
          topic: one(k.topic, [...intents, 'initial', 'followup']),
          text: string(k.text, 1000),
          approved: boolean(k.approved),
          ...(k.versionId === undefined ? {} : { versionId: uuid(k.versionId) }),
        };
      },
      20,
    ),
  };
  if (
    !result.channels.length ||
    !result.workingHours.days.length ||
    result.workingHours.startHour >= result.workingHours.endHour ||
    result.cadenceMinutes.length !== result.maximumAttempts - 1
  )
    throw new WorkforceError(400, 'incomplete_recovery_schedule');
  if (
    new Set(result.knowledge.map((k) => k.key)).size !== result.knowledge.length ||
    new Set(result.knowledge.map((k) => k.topic)).size !== result.knowledge.length
  )
    throw new WorkforceError(400, 'ambiguous_recovery_knowledge');
  return result;
}
export function validateActivation(config: RecoveryConfig) {
  const models = (process.env.AGENT_ALLOWED_MODELS ?? '').split(',').map((s) => s.trim());
  if (!models.includes(config.model)) throw new WorkforceError(400, 'recovery_model_not_allowed');
  if (
    config.knowledge.some((k) => !k.approved) ||
    !config.knowledge.some((k) => k.topic === 'initial') ||
    (config.maximumAttempts > 1 && !config.knowledge.some((k) => k.topic === 'followup'))
  )
    throw new WorkforceError(400, 'approved_recovery_knowledge_required');
}
export interface RecoveryDecisionValue {
  intent: Intent;
  interest_level: 'high' | 'medium' | 'low' | 'none' | 'unknown';
  recommended_action: 'send_message' | 'handoff' | 'stop' | 'wait';
  human_required: boolean;
  reason: string;
  next_followup_at: string | null;
  message_if_allowed: string | null;
}
export function parseClassification(value: unknown): RecoveryDecisionValue {
  const v = object(value);
  keys(v, [
    'intent',
    'interest_level',
    'recommended_action',
    'human_required',
    'reason',
    'next_followup_at',
    'message_if_allowed',
  ]);
  return {
    intent: one(v.intent, intents),
    interest_level: one(v.interest_level, ['high', 'medium', 'low', 'none', 'unknown']),
    recommended_action: one(v.recommended_action, ['send_message', 'handoff', 'stop', 'wait']),
    human_required: boolean(v.human_required),
    reason: string(v.reason, 300),
    next_followup_at: v.next_followup_at === null ? null : string(v.next_followup_at, 40),
    message_if_allowed: v.message_if_allowed === null ? null : string(v.message_if_allowed, 1000),
  };
}
export const classificationSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'intent',
    'interest_level',
    'recommended_action',
    'human_required',
    'reason',
    'next_followup_at',
    'message_if_allowed',
  ],
  properties: {
    intent: { type: 'string', enum: intents },
    interest_level: { type: 'string', enum: ['high', 'medium', 'low', 'none', 'unknown'] },
    recommended_action: { type: 'string', enum: ['send_message', 'handoff', 'stop', 'wait'] },
    human_required: { type: 'boolean' },
    reason: { type: 'string', maxLength: 300 },
    next_followup_at: { type: ['string', 'null'] },
    message_if_allowed: { type: ['string', 'null'], maxLength: 1000 },
  },
};
export function exampleConfig(): RecoveryConfig {
  return {
    version: 1,
    name: 'Revenue Recovery',
    model: 'select-an-approved-model',
    mode: 'COPILOT',
    minimumValueMinor: 0,
    currency: 'USD',
    pipelineIds: [],
    stageIds: [],
    delayMinutes: 2880,
    cadenceMinutes: [4320, 10080],
    maximumAttempts: 3,
    channels: ['sms'],
    workingHours: {
      timezone: 'America/New_York',
      days: [1, 2, 3, 4, 5],
      startHour: 9,
      endHour: 17,
    },
    employeeQuietMinutes: 1440,
    attributionDays: 14,
    allowedObjections: ['timing', 'information_request'],
    restrictedTopics: ['financing_question', 'legal_or_compliance'],
    handoffConditions: [...mandatoryHandoffs],
    knowledge: [
      {
        key: 'initial',
        topic: 'initial',
        text: 'Would you like to discuss your estimate or next steps with our team?',
        approved: false,
      },
      {
        key: 'followup',
        topic: 'followup',
        text: 'Checking whether you still want help with your proposal. You can reply to reach our team or ask us to stop.',
        approved: false,
      },
    ],
  };
}
