import { DeliveryDestination } from '@prisma/client';

import { env } from '../../config/env.js';
import type { DeliveryTarget, QualifiedLeadPayload } from './types.js';

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as unknown) : {};
  if (!response.ok)
    throw new Error(`Delivery returned HTTP ${response.status}: ${text.slice(0, 500)}`);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

export class GhlLeadDeliveryTarget implements DeliveryTarget {
  readonly destination = DeliveryDestination.GHL;

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly apiKey = env.GHL_API_KEY,
    private readonly locationId = env.GHL_LOCATION_ID,
  ) {}

  async deliver(payload: QualifiedLeadPayload, deliveryRecordId: string) {
    if (!this.apiKey || !this.locationId) throw new Error('GHL delivery is not configured');
    const response = await this.fetcher(
      `${env.GHL_API_BASE_URL.replace(/\/$/, '')}/contacts/upsert`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          version: 'v3',
          'content-type': 'application/json',
          'x-idempotency-key': deliveryRecordId,
        },
        body: JSON.stringify({
          locationId: this.locationId,
          name: payload.name,
          phone: payload.phone ?? undefined,
          email: payload.email ?? undefined,
          website: payload.website ?? undefined,
          city: payload.location.city ?? undefined,
          state: payload.location.state ?? undefined,
          source: `Steel Scale Lead Intelligence — ${payload.campaignKey}`,
          tags: ['lead-intelligence', payload.offer.toLowerCase(), 'manual-review'],
          customFields: [{ key: 'steel_scale_delivery_id', field_value: deliveryRecordId }],
        }),
        signal: AbortSignal.timeout(8_000),
      },
    );
    const result = await responseJson(response);
    const contact =
      result.contact && typeof result.contact === 'object'
        ? (result.contact as Record<string, unknown>)
        : undefined;
    if (typeof contact?.id !== 'string')
      throw new Error('GHL response did not contain a contact ID');
    return { externalId: contact.id };
  }
}

export class ZapierLeadDeliveryTarget implements DeliveryTarget {
  readonly destination = DeliveryDestination.ZAPIER_WEBHOOK;
  constructor(
    private readonly webhookUrl: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async deliver(payload: QualifiedLeadPayload, deliveryRecordId: string) {
    const url = new URL(this.webhookUrl);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
      throw new Error('Zapier webhook must use HTTPS');
    }
    const response = await this.fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-delivery-id': deliveryRecordId },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8_000),
    });
    const result = await responseJson(response);
    return { externalId: typeof result.id === 'string' ? result.id : deliveryRecordId };
  }
}

export class CallQueueDeliveryTarget implements DeliveryTarget {
  readonly destination = DeliveryDestination.CALL_QUEUE;
  deliver(_payload: QualifiedLeadPayload, deliveryRecordId: string) {
    return Promise.resolve({ externalId: `call-queue:${deliveryRecordId}` });
  }
}

export class CsvLeadDeliveryTarget implements DeliveryTarget {
  readonly destination = DeliveryDestination.CSV_EXPORT;
  deliver(_payload: QualifiedLeadPayload, deliveryRecordId: string) {
    return Promise.resolve({ externalId: `csv:${deliveryRecordId}` });
  }
}
