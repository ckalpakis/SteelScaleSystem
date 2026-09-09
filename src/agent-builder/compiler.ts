import {
  parseDefinition,
  subjectTypes,
  toolNames,
  type Definition,
  type ToolName,
} from '../agents/contracts.js';
import { getTool } from '../agents/tools.js';
import { eligible, type RunContext } from '../agents/context.js';
import { evaluate } from '../agents/policy.js';
import { hash, integer, keys, object, uuid, WorkforceError } from '../workforce/shared.js';
import { parseBlueprint, type AgentBlueprint } from './blueprint.js';
export const compilerVersion = 'blueprint-compiler-v1';
export interface Requirement {
  field: string;
  code: string;
  message: string;
}
export interface Compilation {
  compilerVersion: string;
  requirements: Requirement[];
  definition: Definition | null;
  definitionHash: string | null;
}
export function compile(
  value: unknown,
  models = (process.env.AGENT_ALLOWED_MODELS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
): Compilation {
  const b = parseBlueprint(value),
    requirements: Requirement[] = [];
  const need = (field: string, code: string, message: string) =>
    requirements.push({ field, code, message });
  for (const field of [
    'name',
    'objective',
    'businessContext',
    'communicationStyle',
    'triggerEvent',
    'mode',
    'humanApprovalMode',
    'runtimeModel',
  ] as const)
    if (!b[field])
      need(field, 'missing', `Specify ${field.replace(/[A-Z]/g, (c) => ' ' + c.toLowerCase())}.`);
  if (!b.eligibleEntityTypes.length)
    need('eligibleEntityTypes', 'missing', 'Choose at least one internal entity type.');
  if (!b.allowedActions.length)
    need('allowedActions', 'missing', 'Choose at least one permitted action.');
  if (b.runtimeModel && !models.includes(b.runtimeModel))
    need(
      'runtimeModel',
      'model_not_allowed',
      'Select a model from the operator-reviewed allowlist.',
    );
  if (b.delayMinutes === null)
    need(
      'delayMinutes',
      'missing',
      'Specify a delay, or explicitly choose zero for an immediate event trigger.',
    );
  else if (b.delayMinutes !== 0)
    need(
      'delayMinutes',
      'unsupported_delay',
      'Delayed event re-evaluation is not implemented. This request cannot be activated as an immediate trigger.',
    );
  if (b.cadence.enabled === null)
    need('cadence.enabled', 'missing', 'Choose whether repeated follow-ups are required.');
  if (b.cadence.enabled)
    need(
      'cadence',
      'unsupported_cadence',
      'Fixed follow-up cadence needs a runtime cadence controller; minimum tool delays are not equivalent.',
    );
  if (!b.cadence.maximumAttempts)
    need('cadence.maximumAttempts', 'missing', 'Set the maximum number of action proposals.');
  if (b.cadence.enabled === false && b.cadence.intervalMinutes !== null)
    need(
      'cadence.intervalMinutes',
      'conflict',
      'Remove the interval or enable the requested cadence.',
    );
  for (const action of b.allowedActions) {
    if (['record_recovery_decision', 'send_recovery_message'].includes(action))
      need(
        'allowedActions',
        'specialization_required',
        'Recovery tools require a configured Revenue Recovery program and tracked case.',
      );
    if (!(toolNames as readonly string[]).includes(action))
      need(
        'allowedActions',
        'unsupported_action',
        `The runtime has no registered ${action} capability.`,
      );
    else if (!getTool(action).available)
      need(
        'allowedActions',
        'adapter_unavailable',
        `${action} requires a safe delivery adapter before activation.`,
      );
    if (action === 'schedule_followup')
      need(
        'allowedActions',
        'unsupported_cadence',
        'Scheduled follow-up semantics need an explicit supported cadence before activation.',
      );
    if (b.prohibitedActions.includes(action))
      need('prohibitedActions', 'conflict', `${action} is both allowed and prohibited.`);
  }
  for (const action of b.prohibitedActions)
    if (!(toolNames as readonly string[]).includes(action))
      need(
        'prohibitedActions',
        'unsupported_business_guard',
        `The business prohibition “${action}” needs an enforceable content/policy guard; it will not be silently reduced to prompt text.`,
      );
  for (const action of b.automaticActions)
    if (!b.allowedActions.includes(action) || b.mode !== 'AUTOPILOT')
      need(
        'automaticActions',
        'conflict',
        'Automatic actions must be allowed and use Autopilot mode.',
      );
  for (const channel of b.communicationChannels)
    if (!['sms', 'email'].includes(channel))
      need('communicationChannels', 'unsupported_channel', `${channel} is not a runtime channel.`);
  if (b.allowedActions.includes('send_message') && !b.communicationChannels.length)
    need(
      'communicationChannels',
      'missing',
      'Choose the intended messaging channel; it cannot be inferred from “follow up.”',
    );
  const statuses: string[] = [];
  let staleAfterDays = 0;
  for (const c of b.triggerConditions) {
    if (c.field === 'status' && ['eq', 'in'].includes(c.operator)) {
      if (c.operator === 'eq' && c.value && c.number === null && !c.values.length)
        statuses.push(c.value);
      else if (c.operator === 'in' && c.values.length && c.value === null && c.number === null)
        statuses.push(...c.values);
      else
        need(
          'triggerConditions',
          'invalid_condition',
          'A status condition requires one value (equals) or a list (in).',
        );
    } else if (
      c.field === 'inactive_days' &&
      c.operator === 'gte' &&
      c.number !== null &&
      c.number <= 365 &&
      c.value === null &&
      !c.values.length &&
      b.eligibleEntityTypes.length === 1 &&
      b.eligibleEntityTypes[0] === 'opportunity'
    )
      staleAfterDays = Math.max(staleAfterDays, c.number);
    else
      need(
        'triggerConditions',
        'unsupported_condition',
        `${c.field} ${c.operator} is not supported by the current runtime eligibility engine.`,
      );
    if (c.field === 'amount_minor' && !b.currency)
      need(
        'currency',
        'missing',
        'Confirm the currency for the amount threshold; a dollar sign alone is ambiguous.',
      );
  }
  // Conjunction must not silently become a broader union of status predicates.
  if (statuses.some((status) => status.length > 40))
    need(
      'triggerConditions',
      'status_limit',
      'Runtime status values must be at most 40 characters.',
    );
  if (b.triggerConditions.filter((c) => c.field === 'status').length > 1)
    need(
      'triggerConditions',
      'unsupported_conjunction',
      'Combine status values into one “in” condition; multiple status clauses cannot be weakened to OR.',
    );
  for (const rule of b.escalationRules) {
    if (
      !['policy_denied', 'customer_suppressed', 'model_error'].includes(rule.condition) ||
      rule.route !== 'review_queue' ||
      rule.memberId !== null
    )
      need(
        'escalationRules',
        'unsupported_escalation',
        `${rule.condition} → ${rule.route ?? 'unspecified recipient'} needs a runtime detector and routing rule. Run review is the only supported route.`,
      );
  }
  if (!b.stopConditions.includes('action_limit'))
    need('stopConditions', 'missing', 'Confirm the mandatory action-budget stop condition.');
  for (const stop of b.stopConditions)
    if (stop !== 'action_limit')
      need(
        'stopConditions',
        'unsupported_stop',
        `An exact automatic “${stop}” stop rule is not implemented for all proposed actions.`,
      );
  if (!b.successCriteria.kind || !b.successCriteria.description)
    need(
      'successCriteria',
      'missing',
      'Choose a success criterion and describe the evidence required.',
    );
  else if (
    !['recommendation', 'task_created', 'note_added', 'opportunity_updated'].includes(
      b.successCriteria.kind,
    )
  )
    need(
      'successCriteria',
      'unsupported_goal',
      'This success criterion needs a verified runtime outcome evaluator.',
    );
  const goalTools: Partial<Record<string, ToolName>> = {
    task_created: 'create_task',
    note_added: 'add_note',
    opportunity_updated: 'update_opportunity',
  };
  const goalTool = b.successCriteria.kind ? goalTools[b.successCriteria.kind] : undefined;
  if (goalTool && !b.allowedActions.includes(goalTool))
    need(
      'successCriteria',
      'goal_action_missing',
      'The success criterion requires an action that is not allowed.',
    );
  if (b.mode === 'ADVISORY' && b.successCriteria.kind !== 'recommendation')
    need(
      'successCriteria',
      'advisory_no_effects',
      'Advisory agents can recommend, but cannot satisfy a mutation-based goal.',
    );
  const hours = b.operatingHours;
  if (!hours?.timezone || !hours.days.length || hours.startHour === null || hours.endHour === null)
    need(
      'operatingHours',
      'missing',
      'Confirm a timezone, operating days and start/end hours. No 24/7 default is assumed.',
    );
  else if (hours.startHour >= hours.endHour)
    need(
      'operatingHours',
      'invalid_hours',
      'End hour must be after start hour; overnight windows need separate runtime support.',
    );
  for (const knowledge of b.knowledgeRequirements)
    if (!knowledge.content || !knowledge.approved)
      need(
        'knowledgeRequirements',
        'knowledge_review',
        `Supply and approve “${knowledge.name}” before activation.`,
      );
  const context = [
    b.businessContext,
    ...b.knowledgeRequirements.map((k) => `${k.name}: ${k.content ?? ''}`),
  ]
    .filter(Boolean)
    .join('\n');
  if (context.length > 4000)
    need(
      'knowledgeRequirements',
      'context_limit',
      'Reviewed business context and knowledge must fit within 4,000 characters.',
    );
  b.missingConfiguration.forEach((message) =>
    need('missingConfiguration', 'unresolved_question', message),
  );
  b.unsupportedRequests.forEach((message) =>
    need('unsupportedRequests', 'unmapped_request', message),
  );
  if (requirements.length)
    return { compilerVersion, requirements, definition: null, definitionHash: null };
  const definition = parseDefinition({
    version: 1,
    name: b.name,
    description: 'Reviewed structured Agent Builder configuration.',
    objective: b.objective,
    businessContext: context,
    communicationStyle: b.communicationStyle,
    mode: b.mode,
    model: { provider: 'openai', model: b.runtimeModel },
    triggers: [b.triggerEvent],
    eligibility: {
      entityTypes: b.eligibleEntityTypes,
      statuses: [...new Set(statuses)],
      staleAfterDays,
    },
    permissions: b.allowedActions.map((tool) => ({
      tool,
      automatic: b.automaticActions.includes(tool as ToolName),
    })),
    restrictedActions: b.prohibitedActions,
    escalationConditions: b.escalationRules.map((r) => r.condition),
    successCriteria: b.successCriteria,
    followupStrategy: { enabled: false, delayMinutes: 15 },
    maximumAttempts: b.cadence.maximumAttempts,
    operatingHours: b.operatingHours,
    enabledChannels: b.communicationChannels,
    humanApprovalMode: b.humanApprovalMode,
    context: { includeContactDetails: false, includeMessageContent: false },
    limits: {
      maxSteps: 5,
      maxActions: Math.min(3, b.cadence.maximumAttempts!),
      maxRunSeconds: 300,
      maxRunsPerDay: 20,
      maxOutputTokens: 1024,
    },
  });
  return { compilerVersion, requirements: [], definition, definitionHash: hash(definition) };
}
export interface Scenario {
  entityType: string;
  status: string;
  inactiveDays: number;
  suppressed: boolean;
}
export function scenario(value: unknown): Scenario {
  const v = object(value);
  keys(v, ['entityType', 'status', 'inactiveDays', 'suppressed']);
  if (
    typeof v.entityType !== 'string' ||
    !subjectTypes.some((t) => t === v.entityType) ||
    typeof v.status !== 'string' ||
    v.status.length > 40 ||
    typeof v.suppressed !== 'boolean'
  )
    throw new WorkforceError(400, 'invalid_scenario');
  return {
    entityType: v.entityType,
    status: v.status,
    inactiveDays: integer(v.inactiveDays, 0, 365),
    suppressed: v.suppressed,
  };
}
export function preview(b: AgentBlueprint, input: Scenario, now = new Date()) {
  const result = compile(b);
  if (!result.definition)
    return {
      compilerVersion,
      executable: false,
      sideEffects: false,
      requirements: result.requirements,
    };
  const id = uuid('00000000-0000-4000-8000-000000000001');
  const context: RunContext = {
    subjectId: id,
    records: [
      {
        id,
        type: input.entityType,
        version: 1,
        data: {
          status: input.status,
          lastActivityAt: new Date(now.getTime() - input.inactiveDays * 86400000).toISOString(),
        },
      },
    ],
    suppressed: input.suppressed,
    fingerprint: 'fictional-preview',
  };
  return {
    compilerVersion,
    executable: true,
    sideEffects: false,
    definitionHash: result.definitionHash,
    eligible: eligible(result.definition, context, now),
    evaluatedAt: now.toISOString(),
    policies: result.definition.permissions.map((p) => {
      const tool = getTool(p.tool);
      return {
        tool: p.tool,
        ...evaluate(result.definition!, {
          tool: p.tool,
          effect: tool.effect,
          enabled: true,
          currentVersion: true,
          context,
          automaticAvailable: tool.available,
          actions: 0,
          attempts: 0,
          now,
        }),
      };
    }),
    notice:
      'Fictional eligibility/policy preview only. No model decision, CRM mutation, job, message or booking was executed.',
  };
}
