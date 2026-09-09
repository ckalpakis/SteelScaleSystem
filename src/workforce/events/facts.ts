import { EventPublisher } from '../../events/publisher.js';
import type { Transaction } from '../shared.js';

export function publishAgentFact(
  tx: Transaction,
  organizationId: string,
  actor: string,
  type: 'agent.handoff_created' | 'agent.action_completed' | 'opportunity.recovered',
  opportunityId: string,
  key: string,
  data: Record<string, unknown>,
) {
  return new EventPublisher().publishInTransaction(
    tx,
    { organizationId, actor, provider: 'steel_scale', system: 'steel_scale_workforce' },
    {
      version: 2,
      type,
      idempotencyKey: `${type}:${key}`,
      occurredAt: new Date().toISOString(),
      entity: { type: 'opportunity', id: opportunityId },
      data: { changes: data },
    },
  );
}
