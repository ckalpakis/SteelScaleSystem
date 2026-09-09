import {
  boolean,
  currency,
  date,
  integer,
  keys,
  object,
  string,
  WorkforceError,
} from '../shared.js';

export interface CustomerData {
  externalId: string;
  name: string;
  email?: string;
  phone?: string;
  doNotContact?: boolean;
}
export interface OpportunityData {
  externalId: string;
  customerExternalId: string;
  title: string;
  status: 'open' | 'estimate_sent' | 'won' | 'lost';
  amountMinor: number;
  currency: string;
  lastActivityAt: string;
}
export type LegacyBusinessEvent = {
  id: string;
  version: 1;
  occurredAt: string;
} & (
  | { type: 'customer.upserted'; data: CustomerData }
  | { type: 'opportunity.upserted'; data: OpportunityData }
  | { type: 'recovery.scan.requested'; data: Record<string, never> }
);

export function parseEvent(value: unknown, now = new Date()): LegacyBusinessEvent {
  const input = object(value);
  keys(input, ['id', 'version', 'occurredAt', 'type', 'data']);
  if (input.version !== 1) throw new WorkforceError(400, 'unsupported_event_version');
  const base = {
    id: string(input.id),
    version: 1 as const,
    occurredAt: date(input.occurredAt, now).toISOString(),
  };
  const data = object(input.data);
  if (input.type === 'customer.upserted') {
    keys(data, ['externalId', 'name', 'email', 'phone', 'doNotContact']);
    const email = data.email === undefined ? undefined : string(data.email, 254);
    const phone = data.phone === undefined ? undefined : string(data.phone, 20);
    if (
      (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ||
      (phone && !/^\+[1-9]\d{7,14}$/.test(phone))
    )
      throw new WorkforceError(400, 'invalid_contact');
    return {
      ...base,
      type: input.type,
      data: {
        externalId: string(data.externalId),
        name: string(data.name),
        email,
        phone,
        doNotContact: data.doNotContact === undefined ? undefined : boolean(data.doNotContact),
      },
    };
  }
  if (input.type === 'opportunity.upserted') {
    keys(data, [
      'externalId',
      'customerExternalId',
      'title',
      'status',
      'amountMinor',
      'currency',
      'lastActivityAt',
    ]);
    if (
      data.status !== 'open' &&
      data.status !== 'estimate_sent' &&
      data.status !== 'won' &&
      data.status !== 'lost'
    ) {
      throw new WorkforceError(400, 'invalid_opportunity_status');
    }
    const lastActivityAt = date(data.lastActivityAt, now).toISOString();
    if (lastActivityAt > base.occurredAt) throw new WorkforceError(400, 'activity_after_event');
    return {
      ...base,
      type: input.type,
      data: {
        externalId: string(data.externalId),
        customerExternalId: string(data.customerExternalId),
        title: string(data.title),
        status: data.status,
        amountMinor: integer(data.amountMinor, 0, 2_147_483_647),
        currency: currency(data.currency),
        lastActivityAt,
      },
    };
  }
  if (input.type === 'recovery.scan.requested') {
    keys(data, []);
    return { ...base, type: input.type, data: {} };
  }
  throw new WorkforceError(400, 'unsupported_event_type');
}
