import { parseEvent, type LegacyBusinessEvent } from '../events/contracts.js';
import { WorkforceError } from '../shared.js';

export interface InboundAdapter {
  normalize(payload: unknown): LegacyBusinessEvent;
}

const canonicalWebhook: InboundAdapter = {
  normalize(payload) {
    const event = parseEvent(payload);
    if (event.type === 'recovery.scan.requested')
      throw new WorkforceError(403, 'internal_event_only');
    return event;
  },
};

export function inboundAdapter(provider: string): InboundAdapter {
  if (provider === 'zapier' || provider === 'generic_webhook') return canonicalWebhook;
  // Reserved provider value: existing GHL booking/delivery adapters remain in legacy services.
  throw new WorkforceError(422, 'integration_adapter_not_available');
}
