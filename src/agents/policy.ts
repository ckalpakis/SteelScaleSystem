import type { Definition, ToolName } from './contracts.js';
import type { RunContext } from './context.js';

export type PolicyResult = {
  outcome: 'deny' | 'allow' | 'require_approval' | 'recommend';
  reason: string;
  version: 'agent-policy-v1';
};
export function operatingNow(config: Pick<Definition, 'operatingHours'>, now: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: config.operatingHours.timezone,
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
    parts.find((p) => p.type === 'weekday')!.value,
  );
  const hour = Number(parts.find((p) => p.type === 'hour')!.value);
  return (
    config.operatingHours.days.includes(day) &&
    hour >= config.operatingHours.startHour &&
    hour < config.operatingHours.endHour
  );
}
export function evaluate(
  config: Definition,
  input: {
    tool: ToolName;
    effect: 'read' | 'internal' | 'external' | 'control' | 'observation';
    enabled: boolean;
    currentVersion: boolean;
    context: RunContext;
    automaticAvailable: boolean;
    actions: number;
    attempts: number;
    now: Date;
    approved?: boolean;
    channel?: string | null;
  },
): PolicyResult {
  const result = (outcome: PolicyResult['outcome'], reason: string): PolicyResult => ({
    outcome,
    reason,
    version: 'agent-policy-v1',
  });
  const permission = config.permissions.find((p) => p.tool === input.tool);
  if (!input.enabled || !input.currentVersion)
    return result('deny', 'agent_disabled_or_version_changed');
  if (!permission || config.restrictedActions.includes(input.tool))
    return result('deny', 'tool_not_allowed');
  if (input.channel && !config.enabledChannels.includes(input.channel as 'sms' | 'email'))
    return result('deny', 'channel_not_allowed');
  if (input.effect === 'read' || input.tool === 'stop_agent_run')
    return result('allow', 'registered_read_or_stop');
  // Registered observations can journal classifications in every mode, but cannot send,
  // schedule customer contact or relax CRM suppression. A specialized safety observation
  // may impose an opt-out; its scoped executor independently validates this.
  if (input.effect === 'observation') return result('allow', 'registered_observation');
  if (!operatingNow(config, input.now)) return result('deny', 'outside_operating_hours');
  if (input.actions >= config.limits.maxActions || input.attempts >= config.maximumAttempts)
    return result('deny', 'action_limit');
  if (
    input.context.suppressed &&
    ['send_message', 'book_appointment', 'schedule_followup'].includes(input.tool)
  )
    return result('deny', 'customer_suppressed');
  if (config.mode === 'ADVISORY') return result('recommend', 'advisory_only');
  // Approval cannot enable an absent adapter, override a restriction or grant new permissions.
  if (!input.automaticAvailable) return result('deny', 'adapter_unavailable');
  if (input.tool === 'schedule_followup' && !config.followupStrategy.enabled)
    return result('deny', 'followup_disabled');
  if (input.approved) return result('allow', 'human_approved_and_revalidated');
  if (
    input.tool === 'request_human_approval' ||
    input.tool === 'update_opportunity' ||
    config.mode === 'COPILOT' ||
    config.humanApprovalMode === 'all_mutations' ||
    !permission.automatic ||
    input.effect === 'external'
  )
    return result('require_approval', 'human_review_required');
  return result('allow', 'explicit_automatic_permission');
}
