import type { Definition, Decision, ToolName, ToolInput } from './contracts.js';
export function definition(overrides: Partial<Definition> = {}): Definition {
  return {
    version: 1,
    name: 'Service intake assistant',
    description: 'Review service requests and propose staff tasks.',
    objective: 'Give the team a clear next step.',
    businessContext: 'A service business using the internal CRM.',
    communicationStyle: 'Concise, factual and professional.',
    mode: 'COPILOT',
    model: { provider: 'openai', model: 'test-model' },
    triggers: ['contact.created'],
    eligibility: {
      entityTypes: [
        'contact',
        'opportunity',
        'estimate',
        'conversation',
        'appointment',
        'task',
        'message',
      ],
      statuses: [],
      staleAfterDays: 0,
    },
    permissions: [
      { tool: 'get_contact', automatic: true },
      { tool: 'create_task', automatic: true },
      { tool: 'add_note', automatic: true },
      { tool: 'update_opportunity', automatic: true },
      { tool: 'schedule_followup', automatic: true },
      { tool: 'request_human_approval', automatic: true },
      { tool: 'stop_agent_run', automatic: true },
      { tool: 'send_message', automatic: true },
      { tool: 'book_appointment', automatic: true },
      { tool: 'notify_employee', automatic: true },
    ],
    restrictedActions: [],
    escalationConditions: ['policy_denied', 'customer_suppressed', 'model_error'],
    successCriteria: {
      kind: 'task_created',
      description: 'A staff task exists with an execution receipt.',
    },
    followupStrategy: { enabled: true, delayMinutes: 15 },
    maximumAttempts: 5,
    operatingHours: { timezone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 },
    enabledChannels: ['email'],
    humanApprovalMode: 'sensitive_only',
    context: { includeContactDetails: false, includeMessageContent: false },
    limits: {
      maxSteps: 5,
      maxActions: 3,
      maxRunSeconds: 300,
      maxRunsPerDay: 20,
      maxOutputTokens: 1024,
    },
    ...overrides,
  };
}
export function decision(tool: ToolName | null, input: Partial<ToolInput> = {}): Decision {
  return {
    kind: tool ? 'tool' : 'finish',
    summary: tool ? 'Propose a bounded next step.' : 'No further action needed.',
    tool,
    input: {
      targetId: null,
      text: null,
      title: null,
      channel: null,
      dueAt: null,
      stageId: null,
      memberId: null,
      ...input,
    },
  };
}
