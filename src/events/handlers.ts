import { evaluateEvent } from '../workforce/agents/runtime.js';
import { agentRuntimeHandler } from '../agents/events.js';
import { universalRecoveryHandler } from '../recovery/events.js';
import { EventRouter, type EventHandler } from './router.js';

// Subscribe to base opportunity changes only. The correlated stage/won/lost facts
// serve other consumers without starting a second recovery run for the same CRM write.
export const recoveryHandler: EventHandler = {
  id: 'revenue-recovery.v1',
  types: ['opportunity.created', 'opportunity.updated', 'recovery.scan.requested'],
  handle: evaluateEvent,
};
export const eventRouter = new EventRouter([
  recoveryHandler,
  agentRuntimeHandler,
  universalRecoveryHandler,
]);
