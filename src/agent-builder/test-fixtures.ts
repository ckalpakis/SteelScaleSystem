import { blankBlueprint, type AgentBlueprint } from './blueprint.js';
export const sourceRequest =
  'Follow up with any estimate over $2,500 that has not been accepted within two days. Try to determine what is holding them back and get them back on the calendar. Do not offer discounts. If they want to negotiate price, notify the assigned salesperson.';
export function exampleBlueprint(): AgentBlueprint {
  return {
    ...blankBlueprint(),
    name: 'Estimate follow-up',
    objective: 'Recover an unsold estimate or arrange a salesperson conversation.',
    eligibleEntityTypes: ['estimate'],
    triggerEvent: 'estimate.sent',
    triggerConditions: [
      { field: 'amount_minor', operator: 'gt', number: 250000, value: null, values: [] },
      { field: 'status', operator: 'neq', value: 'accepted', number: null, values: [] },
    ],
    delayMinutes: 2880,
    cadence: { enabled: true, intervalMinutes: null, maximumAttempts: null },
    allowedActions: ['send_message', 'book_appointment', 'notify_employee'],
    prohibitedActions: ['offer_discount'],
    escalationRules: [
      { condition: 'pricing_negotiation', route: 'assigned_salesperson', memberId: null },
    ],
    successCriteria: {
      kind: 'estimate_recovered',
      description: 'A recovered estimate or a booked salesperson conversation.',
    },
    stopConditions: ['estimate_accepted'],
    knowledgeRequirements: [
      { name: 'Approved estimate and service answers', content: null, approved: false },
    ],
    missingConfiguration: [
      'Which currency is the threshold in?',
      'Which communication channels may be used?',
      'What cadence and maximum attempts are permitted?',
    ],
  };
}
export function readyBlueprint(): AgentBlueprint {
  return {
    ...blankBlueprint(),
    name: 'Service intake helper',
    objective: 'Create a staff task for a new service request.',
    businessContext: 'A general service business using the internal CRM.',
    communicationStyle: 'Concise, factual, professional.',
    eligibleEntityTypes: ['contact'],
    triggerEvent: 'contact.created',
    delayMinutes: 0,
    cadence: { enabled: false, intervalMinutes: null, maximumAttempts: 1 },
    allowedActions: ['get_contact', 'create_task', 'stop_agent_run'],
    prohibitedActions: ['send_message', 'book_appointment'],
    successCriteria: { kind: 'task_created', description: 'A committed staff task exists.' },
    stopConditions: ['action_limit'],
    operatingHours: { timezone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 },
    mode: 'COPILOT',
    humanApprovalMode: 'all_mutations',
    runtimeModel: 'test-model',
  };
}
