import type { Prisma } from '@prisma/client';

import type {
  AdapterValidationResult,
  LeadSourceAdapter,
  NormalizedSignal,
} from '../ingestion/types.js';

export const OUTSCRAPER_SIGNAL_KEYS = {
  GOOGLE_REVIEW_COUNT: 'google_review_count',
  GOOGLE_RATING: 'google_rating',
  HAS_WEBSITE: 'has_website',
  HAS_BOOKING_LINK: 'has_booking_link',
  HAS_APPOINTMENT_LINK: 'has_appointment_link',
  IS_24_HOUR: 'is_24_hour',
  GOOGLE_VERIFIED: 'google_verified',
  PHOTO_COUNT: 'photo_count',
  AREA_SERVICE_BUSINESS: 'area_service_business',
} as const;

export type OutscraperGoogleMapsPayload = Record<string, unknown> & { name: string };

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number(value.replaceAll(',', '').trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : undefined;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['true', 'yes', '1', 'verified'].includes(normalized)) return true;
  if (['false', 'no', '0', 'unverified'].includes(normalized)) return false;
  return undefined;
}

function jsonValue(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Prisma.InputJsonValue;
    } catch {
      return value;
    }
  }
  return value;
}

function listValue(value: unknown): Prisma.InputJsonValue | undefined {
  const parsed = jsonValue(value);
  if (typeof parsed === 'string') {
    const items = parsed
      .split(/[|,]/)
      .map((item) => item.trim())
      .filter(Boolean);
    return items.length ? items : undefined;
  }
  return parsed;
}

function hasLink(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => hasLink(item));
  if (value && typeof value === 'object') return Object.values(value).some((item) => hasLink(item));
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

function isAlwaysOpen(value: unknown): boolean {
  const parsed = jsonValue(value);
  const isTwentyFourHours = (entry: unknown): boolean => {
    const text = Array.isArray(entry)
      ? entry
          .filter((item): item is string | number => ['string', 'number'].includes(typeof item))
          .join(' ')
      : typeof entry === 'string' || typeof entry === 'number'
        ? String(entry)
        : '';
    return /(?:open\s*)?24\s*hours|24\s*\/\s*7|00:00\s*[-–—]\s*(?:24:00|00:00)/i.test(text);
  };
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const entries = Object.entries(parsed);
    return entries.length >= 7 && entries.every(([, hours]) => isTwentyFourHours(hours));
  }
  if (Array.isArray(parsed)) return parsed.length >= 7 && parsed.every(isTwentyFourHours);
  if (typeof parsed === 'string') {
    if (/24\s*\/\s*7/i.test(parsed)) return true;
    const parts = parsed.split('|').filter(Boolean);
    return parts.length >= 7 && parts.every(isTwentyFourHours);
  }
  return false;
}

function directEvidence(...sourceFields: string[]): Prisma.InputJsonValue {
  return { origin: 'DIRECT', provider: 'outscraper_google_maps', sourceFields };
}

function signal(
  key: string,
  value: Prisma.InputJsonValue | undefined,
  kind: NormalizedSignal['kind'],
  sourceFields: string[],
): NormalizedSignal | undefined {
  if (value === undefined) return undefined;
  return { key, value, kind, evidence: directEvidence(...sourceFields) };
}

export class OutscraperGoogleMapsAdapter implements LeadSourceAdapter<OutscraperGoogleMapsPayload> {
  readonly provider = 'outscraper_google_maps';

  getExternalIdentifier(payload: unknown): string | undefined {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
    const record = payload as Record<string, unknown>;
    return stringValue(record.place_id) ?? stringValue(record.google_id) ?? stringValue(record.cid);
  }

  validate(payload: unknown): AdapterValidationResult<OutscraperGoogleMapsPayload> {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { valid: false, errors: ['Outscraper record must be an object'] };
    }
    const record = payload as Record<string, unknown>;
    if (!stringValue(record.name)) {
      return { valid: false, errors: ['Outscraper field name is required'] };
    }
    const latitude = numberValue(record.latitude);
    const longitude = numberValue(record.longitude);
    if (record.latitude !== undefined && latitude === undefined) {
      return { valid: false, errors: ['Outscraper latitude must be numeric'] };
    }
    if (record.longitude !== undefined && longitude === undefined) {
      return { valid: false, errors: ['Outscraper longitude must be numeric'] };
    }
    return { valid: true, value: record as OutscraperGoogleMapsPayload };
  }

  normalize(payload: OutscraperGoogleMapsPayload) {
    const website = stringValue(payload.website ?? payload.site);
    const workingHours = jsonValue(payload.working_hours ?? payload.working_hours_csv_compatible);
    const reservationLinks = jsonValue(payload.reservation_links ?? payload.booking_links);
    const appointmentLink = stringValue(
      payload.booking_appointment_link ?? payload.appointment_link ?? payload.appointment_url,
    );
    const verified = booleanValue(payload.verified ?? payload.is_verified);
    const areaService = booleanValue(
      payload.area_service ?? payload.is_area_service_business ?? payload.service_area_business,
    );
    const signals: Array<NormalizedSignal | undefined> = [
      signal(
        OUTSCRAPER_SIGNAL_KEYS.GOOGLE_REVIEW_COUNT,
        numberValue(payload.reviews ?? payload.reviews_count ?? payload.review_count),
        'number',
        [
          payload.reviews !== undefined
            ? 'reviews'
            : payload.reviews_count !== undefined
              ? 'reviews_count'
              : 'review_count',
        ],
      ),
      signal(OUTSCRAPER_SIGNAL_KEYS.GOOGLE_RATING, numberValue(payload.rating), 'number', [
        'rating',
      ]),
      signal(OUTSCRAPER_SIGNAL_KEYS.HAS_WEBSITE, Boolean(website), 'boolean', [
        payload.website !== undefined ? 'website' : 'site',
      ]),
      signal(OUTSCRAPER_SIGNAL_KEYS.HAS_BOOKING_LINK, hasLink(reservationLinks), 'boolean', [
        'reservation_links',
        'booking_links',
      ]),
      signal(OUTSCRAPER_SIGNAL_KEYS.HAS_APPOINTMENT_LINK, Boolean(appointmentLink), 'boolean', [
        'booking_appointment_link',
        'appointment_link',
      ]),
      workingHours === undefined
        ? undefined
        : {
            key: OUTSCRAPER_SIGNAL_KEYS.IS_24_HOUR,
            value: isAlwaysOpen(workingHours),
            kind: 'boolean',
            evidence: {
              origin: 'DERIVED',
              provider: this.provider,
              sourceFields: ['working_hours', 'working_hours_csv_compatible'],
              rule: 'All seven daily schedules explicitly indicate 24-hour operation',
              sourceValue: workingHours,
            },
          },
      signal(OUTSCRAPER_SIGNAL_KEYS.GOOGLE_VERIFIED, verified, 'boolean', [
        payload.verified !== undefined ? 'verified' : 'is_verified',
      ]),
      signal(
        OUTSCRAPER_SIGNAL_KEYS.PHOTO_COUNT,
        numberValue(payload.photos_count ?? payload.photo_count),
        'number',
        [payload.photos_count !== undefined ? 'photos_count' : 'photo_count'],
      ),
      signal(OUTSCRAPER_SIGNAL_KEYS.AREA_SERVICE_BUSINESS, areaService, 'boolean', [
        'area_service',
      ]),
      signal('google_subtypes', listValue(payload.subtypes), 'json', ['subtypes']),
      signal('google_services', listValue(payload.services), 'json', ['services']),
      signal('google_id', stringValue(payload.google_id), 'text', ['google_id']),
      signal('google_business_status', stringValue(payload.business_status), 'text', [
        'business_status',
      ]),
      signal('google_working_hours', workingHours, 'json', [
        payload.working_hours !== undefined ? 'working_hours' : 'working_hours_csv_compatible',
      ]),
      signal('google_booking_links', reservationLinks, 'json', ['reservation_links']),
      signal('google_appointment_url', appointmentLink, 'text', ['booking_appointment_link']),
      signal(
        'google_owner_information',
        jsonValue({
          id: stringValue(payload.owner_id) ?? null,
          title: stringValue(payload.owner_title) ?? null,
          url: stringValue(payload.owner_link) ?? null,
        }),
        'json',
        ['owner_id', 'owner_title', 'owner_link'],
      ),
      signal('google_description', stringValue(payload.description), 'text', ['description']),
      signal('google_about', jsonValue(payload.about), 'json', ['about']),
    ];

    const ownerSignal = signals.find((entry) => entry?.key === 'google_owner_information');
    if (!payload.owner_id && !payload.owner_title && !payload.owner_link && ownerSignal) {
      signals.splice(signals.indexOf(ownerSignal), 1);
    }

    return {
      externalId: this.getExternalIdentifier(payload),
      sourceUrl: stringValue(payload.location_link ?? payload.google_maps_url),
      business: {
        name: stringValue(payload.name)!,
        website,
        phone: stringValue(payload.phone),
        addressLine1: stringValue(payload.street ?? payload.full_address ?? payload.address),
        city: stringValue(payload.city),
        state: stringValue(payload.state ?? payload.state_code),
        postalCode: stringValue(payload.postal_code ?? payload.zip),
        countryCode: stringValue(payload.country_code),
        latitude: numberValue(payload.latitude),
        longitude: numberValue(payload.longitude),
        googlePlaceId: stringValue(payload.place_id),
        googleCid: stringValue(payload.cid),
        category: stringValue(payload.category ?? payload.type),
        niche: stringValue(payload.type ?? payload.category),
      },
      signals: signals.filter((entry): entry is NormalizedSignal => Boolean(entry)),
    };
  }
}
