import { blankBlueprint, parseBlueprint, type AgentBlueprint } from './blueprint.js';
import { WorkforceError } from '../workforce/shared.js';

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;
const list = (value: unknown): string[] =>
  value === undefined
    ? []
    : Array.isArray(value)
      ? value.map((v) => {
          if (typeof v !== 'string') throw new WorkforceError(400, 'invalid_form');
          return v;
        })
      : typeof value === 'string'
        ? [value]
        : [];
const lines = (value: unknown) =>
  text(value)
    ?.split('\n')
    .map((s) => s.trim())
    .filter(Boolean) ?? [];
const number = (value: unknown) => (text(value) === null ? null : Number(text(value)));
export function formBlueprint(v: Record<string, unknown>): AgentBlueprint {
  const b = blankBlueprint();
  const read = (field: string) => text(v[field]);
  if (![null, 'true', 'false'].includes(read('cadenceEnabled')))
    throw new WorkforceError(400, 'invalid_cadence');
  const triggerConditions: AgentBlueprint['triggerConditions'] = [];
  for (let i = 0; i < 21; i++) {
    const p = `condition_${i}_`;
    const field = read(p + 'field');
    if (!field || v[p + 'remove'] === 'true') continue;
    let amount = number(v[p + 'number']);
    if (field === 'amount_minor' && amount !== null) {
      const raw = read(p + 'number')!;
      if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) throw new WorkforceError(400, 'invalid_amount');
      const [whole, fraction = ''] = raw.split('.');
      amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    }
    triggerConditions.push({
      field: field as never,
      operator: read(p + 'operator') as never,
      value: read(p + 'value'),
      number: amount,
      values: (read(p + 'values') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    });
  }
  const escalationRules: AgentBlueprint['escalationRules'] = [];
  for (let i = 0; i < 21; i++) {
    const p = `escalation_${i}_`,
      condition = read(p + 'condition');
    if (!condition || v[p + 'remove'] === 'true') continue;
    escalationRules.push({
      condition: condition as never,
      route: read(p + 'route') as never,
      memberId: read(p + 'memberId'),
    });
  }
  const knowledgeRequirements: AgentBlueprint['knowledgeRequirements'] = [];
  for (let i = 0; i < 11; i++) {
    const p = `knowledge_${i}_`,
      name = read(p + 'name');
    if (!name || v[p + 'remove'] === 'true') continue;
    knowledgeRequirements.push({
      name,
      content: read(p + 'content'),
      approved: v[p + 'approved'] === 'true',
    });
  }
  return parseBlueprint({
    ...b,
    name: read('name'),
    objective: read('objective'),
    businessContext: read('businessContext'),
    communicationStyle: read('communicationStyle'),
    eligibleEntityTypes: list(v.eligibleEntityTypes),
    triggerEvent: read('triggerEvent'),
    triggerConditions,
    delayMinutes: number(v.delayMinutes),
    cadence: {
      enabled: read('cadenceEnabled') === null ? null : read('cadenceEnabled') === 'true',
      intervalMinutes: number(v.cadenceInterval),
      maximumAttempts: number(v.maximumAttempts),
    },
    allowedActions: list(v.allowedActions),
    automaticActions: list(v.automaticActions),
    prohibitedActions: list(v.prohibitedActions),
    escalationRules,
    communicationChannels: list(v.communicationChannels),
    successCriteria: { kind: read('goalKind'), description: read('goalDescription') },
    stopConditions: list(v.stopConditions),
    operatingHours: {
      timezone: read('timezone'),
      days: list(v.days).map(Number),
      startHour: number(v.startHour),
      endHour: number(v.endHour),
    },
    knowledgeRequirements,
    currency: read('currency'),
    mode: read('mode'),
    humanApprovalMode: read('humanApprovalMode'),
    runtimeModel: read('runtimeModel'),
    missingConfiguration: lines(v.missingConfiguration),
    unsupportedRequests: lines(v.unsupportedRequests),
  });
}
