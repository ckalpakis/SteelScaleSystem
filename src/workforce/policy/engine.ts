import type { RecoveryConfig } from '../agents/config.js';

export interface PolicyContext {
  enabled: boolean;
  tool: string;
  config: RecoveryConfig;
  doNotContact: boolean;
  opportunityStatus: string;
}
export interface PolicyDecision {
  outcome: 'deny' | 'require_approval';
  reason: string;
  version: 'recovery-policy-v1';
}

export function evaluatePolicy(context: PolicyContext): PolicyDecision {
  const deny = (reason: string): PolicyDecision => ({
    outcome: 'deny',
    reason,
    version: 'recovery-policy-v1',
  });
  if (!context.enabled) return deny('agent_disabled');
  if (
    context.tool !== 'recovery.prepare_handoff' ||
    !context.config.allowedTools.includes(context.tool)
  ) {
    return deny('tool_not_allowed');
  }
  if (context.doNotContact) return deny('customer_suppressed');
  if (!['open', 'estimate_sent'].includes(context.opportunityStatus))
    return deny('opportunity_closed');
  return {
    outcome: 'require_approval',
    reason: 'human_review_required',
    version: 'recovery-policy-v1',
  };
}
