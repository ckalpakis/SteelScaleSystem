export interface OutscraperImportField {
  target: string;
  label: string;
  required?: boolean;
  aliases: string[];
}

export type OutscraperFieldMapping = Record<string, string>;

export const OUTSCRAPER_IMPORT_FIELDS: OutscraperImportField[] = [
  {
    target: 'name',
    label: 'Business name',
    required: true,
    aliases: ['name', 'business_name', 'company_name', 'title'],
  },
  { target: 'category', label: 'Category', aliases: ['category', 'type', 'primary_category'] },
  {
    target: 'subtypes',
    label: 'Subtypes',
    aliases: ['subtypes', 'additional_categories', 'categories'],
  },
  { target: 'services', label: 'Services', aliases: ['services', 'service_options'] },
  {
    target: 'phone',
    label: 'Phone',
    aliases: ['phone', 'phone_number', 'international_phone_number'],
  },
  { target: 'website', label: 'Website', aliases: ['website', 'site', 'domain'] },
  {
    target: 'full_address',
    label: 'Full address',
    aliases: ['full_address', 'address', 'formatted_address'],
  },
  { target: 'street', label: 'Street', aliases: ['street', 'street_address', 'address_line_1'] },
  { target: 'city', label: 'City', aliases: ['city', 'locality'] },
  { target: 'state', label: 'State', aliases: ['state', 'state_code', 'region'] },
  { target: 'postal_code', label: 'Postal code', aliases: ['postal_code', 'zip', 'zip_code'] },
  { target: 'country_code', label: 'Country code', aliases: ['country_code', 'country'] },
  { target: 'latitude', label: 'Latitude', aliases: ['latitude', 'lat'] },
  { target: 'longitude', label: 'Longitude', aliases: ['longitude', 'lng', 'lon'] },
  { target: 'rating', label: 'Google rating', aliases: ['rating', 'google_rating'] },
  {
    target: 'reviews',
    label: 'Google review count',
    aliases: ['reviews', 'reviews_count', 'review_count'],
  },
  { target: 'place_id', label: 'Google Place ID', aliases: ['place_id', 'google_place_id'] },
  { target: 'google_id', label: 'Google ID', aliases: ['google_id'] },
  { target: 'cid', label: 'Google CID', aliases: ['cid', 'google_cid'] },
  { target: 'business_status', label: 'Business status', aliases: ['business_status', 'status'] },
  {
    target: 'working_hours',
    label: 'Working hours',
    aliases: ['working_hours', 'working_hours_csv_compatible', 'hours'],
  },
  {
    target: 'reservation_links',
    label: 'Booking links',
    aliases: ['reservation_links', 'booking_links', 'booking_url'],
  },
  {
    target: 'booking_appointment_link',
    label: 'Appointment URL',
    aliases: ['booking_appointment_link', 'appointment_link', 'appointment_url'],
  },
  { target: 'verified', label: 'Google verified', aliases: ['verified', 'is_verified'] },
  { target: 'owner_id', label: 'Owner ID', aliases: ['owner_id'] },
  { target: 'owner_title', label: 'Owner name/title', aliases: ['owner_title', 'owner_name'] },
  { target: 'owner_link', label: 'Owner profile URL', aliases: ['owner_link', 'owner_url'] },
  {
    target: 'location_link',
    label: 'Google Maps URL',
    aliases: ['location_link', 'google_maps_url', 'maps_url'],
  },
  { target: 'photos_count', label: 'Photo count', aliases: ['photos_count', 'photo_count'] },
  { target: 'description', label: 'Description', aliases: ['description', 'business_description'] },
  { target: 'about', label: 'About data', aliases: ['about'] },
  {
    target: 'area_service',
    label: 'Area-service business',
    aliases: ['area_service', 'is_area_service_business', 'service_area_business'],
  },
];

function normalizedField(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function suggestOutscraperFieldMapping(fields: string[]): OutscraperFieldMapping {
  const sourceByNormalized = new Map(fields.map((field) => [normalizedField(field), field]));
  return Object.fromEntries(
    OUTSCRAPER_IMPORT_FIELDS.flatMap((definition) => {
      const source = definition.aliases
        .map((alias) => sourceByNormalized.get(normalizedField(alias)))
        .find(Boolean);
      return source ? [[definition.target, source]] : [];
    }),
  );
}

export function applyOutscraperFieldMapping(
  records: unknown[],
  mapping: OutscraperFieldMapping,
): unknown[] {
  const allowedTargets = new Set(OUTSCRAPER_IMPORT_FIELDS.map(({ target }) => target));
  return records.map((record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
    const original = record as Record<string, unknown>;
    const mapped = { ...original };
    for (const [target, source] of Object.entries(mapping)) {
      if (!allowedTargets.has(target) || !source || original[source] === undefined) continue;
      mapped[target] = original[source];
    }
    return mapped;
  });
}
