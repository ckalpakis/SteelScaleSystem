import { keys, object, string, uuid, WorkforceError } from '../shared.js';

export interface HandoffInput {
  opportunityId: string;
  customerId: string;
  message: string;
}
export interface WorkforceTool {
  name: string;
  effect: 'internal';
  validate(input: unknown): HandoffInput;
  execute(input: HandoffInput): {
    handoff: HandoffInput;
    deliveryStatus: 'not_sent';
    nextStep: string;
  };
}

const handoff: WorkforceTool = {
  name: 'recovery.prepare_handoff',
  effect: 'internal',
  validate(value) {
    const input = object(value);
    keys(input, ['opportunityId', 'customerId', 'message']);
    return {
      opportunityId: uuid(input.opportunityId),
      customerId: uuid(input.customerId),
      message: string(input.message, 2000),
    };
  },
  execute(input) {
    return {
      handoff: input,
      deliveryStatus: 'not_sent',
      nextStep: 'A team member must review contact permission and perform the follow-up.',
    };
  },
};

// External SMS/email/payment/booking tools are deliberately not registered in this milestone.
// Such adapters need consent, delivery receipts, provider idempotency and uncertain-outcome handling.
export function getTool(name: string): WorkforceTool {
  if (name !== handoff.name) throw new WorkforceError(403, 'tool_not_registered');
  return handoff;
}
