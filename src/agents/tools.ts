import { CrmService } from '../crm/service.js';
import { timestamp } from '../crm/validation.js';
import { uuid, WorkforceError, type Database, type Transaction } from '../workforce/shared.js';
import type { Definition, ToolInput, ToolName } from './contracts.js';
import { toolNames } from './contracts.js';
import type { RunContext } from './context.js';
import { executeRecoveryTool } from '../recovery/tools.js';
import { retrieve } from '../knowledge/retrieval.js';

export interface Tool {
  name: ToolName;
  effect: 'read' | 'internal' | 'external' | 'control' | 'observation';
  available: boolean;
  fields: (keyof ToolInput)[];
  required: (keyof ToolInput)[];
}
const entries: Tool[] = [
  {
    name: 'get_business_knowledge',
    effect: 'read',
    available: true,
    fields: ['text'],
    required: ['text'],
  },
  {
    name: 'record_recovery_decision',
    effect: 'observation',
    available: true,
    fields: ['targetId', 'text'],
    required: ['targetId', 'text'],
  },
  {
    name: 'send_recovery_message',
    effect: 'external',
    available: true,
    fields: ['targetId', 'text', 'channel'],
    required: ['targetId', 'text', 'channel'],
  },
  ...(['get_contact', 'get_opportunity', 'get_estimate', 'get_conversation'] as const).map(
    (name) => ({
      name,
      effect: 'read' as const,
      available: true,
      fields: ['targetId'] as (keyof ToolInput)[],
      required: ['targetId'] as (keyof ToolInput)[],
    }),
  ),
  {
    name: 'send_message',
    effect: 'external',
    available: false,
    fields: ['targetId', 'text', 'channel'],
    required: ['targetId', 'text', 'channel'],
  },
  {
    name: 'book_appointment',
    effect: 'external',
    available: false,
    fields: ['targetId', 'title', 'dueAt'],
    required: ['targetId', 'title', 'dueAt'],
  },
  {
    name: 'create_task',
    effect: 'internal',
    available: true,
    fields: ['targetId', 'title', 'text', 'dueAt', 'memberId'],
    required: ['targetId', 'title'],
  },
  {
    name: 'add_note',
    effect: 'internal',
    available: true,
    fields: ['targetId', 'text'],
    required: ['targetId', 'text'],
  },
  {
    name: 'update_opportunity',
    effect: 'internal',
    available: true,
    fields: ['targetId', 'stageId'],
    required: ['targetId', 'stageId'],
  },
  {
    name: 'notify_employee',
    effect: 'internal',
    available: true,
    fields: ['targetId', 'title', 'text', 'memberId'],
    required: ['targetId', 'title', 'memberId'],
  },
  {
    name: 'schedule_followup',
    effect: 'internal',
    available: true,
    fields: ['targetId', 'dueAt'],
    required: ['targetId', 'dueAt'],
  },
  {
    name: 'request_human_approval',
    effect: 'control',
    available: true,
    fields: ['text'],
    required: ['text'],
  },
  {
    name: 'stop_agent_run',
    effect: 'control',
    available: true,
    fields: ['text'],
    required: ['text'],
  },
];
export function getTool(name: string): Tool {
  const tool = entries.find((t) => t.name === name);
  if (!tool) throw new WorkforceError(403, 'tool_not_registered');
  return { ...tool, fields: [...tool.fields], required: [...tool.required] };
}
export function catalog() {
  return toolNames.map(getTool);
}
export function validateTool(
  tool: Tool,
  input: ToolInput,
  context: RunContext,
  config: Definition,
  now: Date,
) {
  if (
    Object.entries(input).some(
      ([k, v]) => v !== null && !tool.fields.includes(k as keyof ToolInput),
    ) ||
    tool.required.some((k) => input[k] === null)
  )
    throw new WorkforceError(400, 'invalid_tool_arguments');
  if (input.targetId) {
    uuid(input.targetId);
    const record = context.records.find((r) => r.id === input.targetId);
    if (!record) throw new WorkforceError(403, 'tool_target_outside_context');
    const type = tool.name.startsWith('get_')
      ? tool.name.slice(4)
      : tool.name === 'update_opportunity'
        ? 'opportunity'
        : tool.name === 'send_message'
          ? 'contact'
          : null;
    if (type && record.type !== type) throw new WorkforceError(400, 'tool_target_type');
  }
  if (input.stageId) uuid(input.stageId);
  if (input.memberId) uuid(input.memberId);
  if (input.channel && !['sms', 'email'].includes(input.channel))
    throw new WorkforceError(400, 'invalid_channel');
  if (input.dueAt) {
    const due = timestamp(input.dueAt);
    const minimum =
      tool.name === 'schedule_followup' ? config.followupStrategy.delayMinutes * 60000 : 0;
    if (due.getTime() < now.getTime() + minimum || due.getTime() > now.getTime() + 366 * 86400000)
      throw new WorkforceError(400, 'invalid_action_time');
  }
}
export async function executeTool(
  tx: Transaction,
  database: Database,
  organizationId: string,
  agentId: string,
  runId: string,
  actionId: string,
  tool: Tool,
  input: ToolInput,
  context: RunContext,
) {
  if (!tool.available) throw new WorkforceError(403, 'adapter_unavailable');
  if (tool.name === 'get_business_knowledge') {
    if (process.env.BUSINESS_KNOWLEDGE_ENABLED !== 'true')
      throw new WorkforceError(403, 'business_knowledge_disabled');
    return retrieve(tx, organizationId, input.text);
  }
  if (tool.name === 'record_recovery_decision' || tool.name === 'send_recovery_message')
    return executeRecoveryTool(tx, organizationId, agentId, runId, actionId, tool.name, input);
  if (tool.effect === 'read') return context.records.find((r) => r.id === input.targetId)!;
  if (tool.name === 'stop_agent_run') return { stopped: true };
  if (tool.name === 'request_human_approval') return { acknowledged: true };
  if (tool.name === 'schedule_followup') {
    if ((await tx.agentSchedule.count({ where: { organizationId, enabled: true } })) >= 100)
      throw new WorkforceError(409, 'schedule_limit');
    const schedule = await tx.agentSchedule.create({
      data: {
        organizationId,
        agentId,
        subjectId: context.subjectId,
        nextRunAt: timestamp(input.dueAt),
        remainingRuns: 1,
      },
    });
    return { scheduleId: schedule.id, nextRunAt: schedule.nextRunAt };
  }
  const crm = new CrmService(database, {
    organizationId,
    credentialId: 'agent-runtime',
    actor: `agent:${agentId}`,
    scopes: ['crm:write'],
    role: 'member',
  });
  const metadata = {
    source: {
      organizationId,
      system: 'steel_scale_agent',
      provider: 'steel_scale',
      actor: `agent:${agentId}`,
    },
    idempotencyKey: `agent-action:${actionId}`,
    correlationId: runId,
  };
  if (tool.name === 'update_opportunity') {
    const stage = await tx.pipelineStage.findFirst({
      where: { organizationId, id: input.stageId!, record: { archivedAt: null } },
    });
    if (!stage) throw new WorkforceError(404, 'stage_not_found');
    const record = context.records.find((r) => r.id === input.targetId)!;
    // Moving a stage cannot silently move a record to another pipeline or change money.
    if (stage.pipelineId !== record.data.pipelineId)
      throw new WorkforceError(409, 'stage_pipeline_mismatch');
    const row = await crm.applyAgentMutation(
      tx,
      'opportunities',
      input.targetId!,
      { stageId: stage.id, expectedVersion: record.version },
      metadata,
    );
    return { recordId: row.id, version: row.record.version, status: row.status };
  }
  if (tool.name === 'add_note') {
    const row = await crm.applyAgentMutation(
      tx,
      'notes',
      undefined,
      { body: input.text, relatedRecordId: input.targetId },
      metadata,
    );
    return { recordId: row.id };
  }
  if (tool.name === 'create_task' || tool.name === 'notify_employee') {
    const row = await crm.applyAgentMutation(
      tx,
      'tasks',
      undefined,
      {
        title: input.title,
        relatedRecordId: input.targetId,
        ...(input.text ? { description: input.text } : {}),
        ...(input.dueAt ? { dueAt: input.dueAt } : {}),
        ...(input.memberId ? { assignedMemberId: input.memberId } : {}),
      },
      metadata,
    );
    return {
      recordId: row.id,
      notification: tool.name === 'notify_employee' ? 'assigned_internal_task' : 'none',
      deliveryStatus: 'not_sent',
    };
  }
  throw new WorkforceError(403, 'tool_not_executable');
}
