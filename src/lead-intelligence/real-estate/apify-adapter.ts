import type {
  NormalizedRealEstateAgent,
  RealEstateAdapterValidation,
  RealEstateListingAdapter,
} from './types.js';

export type ApifyRealEstatePayload = Record<string, unknown>;

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function number(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const parsed = Number(value.replace(/[$,\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function date(value: unknown): Date | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function images(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split('|') : [];
  return values.flatMap((item) => {
    if (typeof item === 'string' && /^https?:\/\//i.test(item.trim())) return [item.trim()];
    const url = text(object(item).url ?? object(item).src);
    return url ? [url] : [];
  });
}

function social(record: Record<string, unknown>, agent: Record<string, unknown>, key: string) {
  return text(agent[key] ?? record[`agent_${key}`] ?? record[key]);
}

export class ApifyRealEstateAdapter implements RealEstateListingAdapter<ApifyRealEstatePayload> {
  readonly provider: string;

  constructor(source: string = 'real_estate') {
    this.provider = `apify_${source.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
  }

  getExternalIdentifier(payload: unknown): string | undefined {
    const record = object(payload);
    return text(
      record.externalId ??
        record.external_id ??
        record.zpid ??
        record.listingId ??
        record.listing_id ??
        record.mlsId ??
        record.mls_id,
    );
  }

  validate(payload: unknown): RealEstateAdapterValidation<ApifyRealEstatePayload> {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { valid: false, errors: ['Real-estate listing must be an object'] };
    }
    const errors: string[] = [];
    if (!this.getExternalIdentifier(payload)) errors.push('External listing ID is required');
    const record = payload as Record<string, unknown>;
    const listingAddress = object(record.listingAddress);
    if (
      !text(
        record.address ??
          record.streetAddress ??
          record.street_address ??
          listingAddress.full ??
          listingAddress.street,
      )
    ) {
      errors.push('Listing address is required');
    }
    return errors.length ? { valid: false, errors } : { valid: true, value: record };
  }

  normalize(payload: ApifyRealEstatePayload) {
    const addressObject = object(payload.address);
    const listingAddress = object(payload.listingAddress);
    const coordinates = object(payload.coordinates);
    const listingPrice = object(payload.listingPrice);
    const brokerObject = object(payload.broker);
    const agentObject = object(payload.agent ?? payload.listingAgent ?? payload.attributionInfo);
    const fullName = text(
      agentObject.name ??
        agentObject.agentName ??
        payload.agentName ??
        payload.agent_name ??
        payload.brokerName,
    );
    const firstName = text(agentObject.firstName ?? payload.agent_first_name);
    const lastName = text(agentObject.lastName ?? payload.agent_last_name);
    const agent: NormalizedRealEstateAgent | undefined =
      fullName || firstName || lastName
        ? {
            fullName: fullName ?? [firstName, lastName].filter(Boolean).join(' '),
            firstName,
            lastName,
            phone: text(
              agentObject.phone ??
                agentObject.phoneNumber ??
                agentObject.agentPhoneNumber ??
                payload.agentPhone ??
                payload.agent_phone,
            ),
            email: text(agentObject.email ?? payload.agentEmail ?? payload.agent_email),
            profileUrl: text(
              agentObject.profileUrl ?? payload.agentProfileUrl ?? payload.agent_profile_url,
            ),
            headshotUrl: text(
              agentObject.headshotUrl ??
                agentObject.photo ??
                payload.agentHeadshotUrl ??
                payload.agent_headshot_url,
            ),
            website: text(agentObject.website ?? payload.agentWebsite ?? payload.agent_website),
            instagramUrl: social(payload, agentObject, 'instagram'),
            facebookUrl: social(payload, agentObject, 'facebook'),
            tiktokUrl: social(payload, agentObject, 'tiktok'),
            brokerage: text(
              agentObject.brokerage ??
                brokerObject.name ??
                payload.brokerage ??
                payload.brokerName ??
                payload.broker_name,
            ),
            licenseNumber: text(agentObject.licenseNumber ?? payload.agent_license_number),
          }
        : undefined;
    return {
      externalId: this.getExternalIdentifier(payload)!,
      propertyUrl: text(
        payload.url ?? payload.propertyUrl ?? payload.property_url ?? payload.detailUrl,
      ),
      address: text(
        (typeof payload.address === 'string' ? payload.address : undefined) ??
          payload.streetAddress ??
          payload.street_address ??
          addressObject.streetAddress ??
          listingAddress.full ??
          listingAddress.street,
      ),
      city: text(payload.city ?? addressObject.city ?? listingAddress.city),
      state: text(
        payload.state ?? payload.stateCode ?? addressObject.state ?? listingAddress.state,
      ),
      postalCode: text(
        payload.zipcode ??
          payload.zip ??
          payload.postalCode ??
          addressObject.zipcode ??
          listingAddress.zipCode,
      ),
      latitude: number(
        payload.latitude ?? payload.lat ?? object(payload.latLong).latitude ?? coordinates.latitude,
      ),
      longitude: number(
        payload.longitude ??
          payload.lng ??
          object(payload.latLong).longitude ??
          coordinates.longitude,
      ),
      price: number(
        payload.price ?? payload.listPrice ?? payload.list_price ?? listingPrice.amount,
      ),
      bedrooms: number(payload.bedrooms ?? payload.beds),
      bathrooms: number(payload.bathrooms ?? payload.baths),
      squareFeet: number(payload.livingArea ?? payload.squareFeet ?? payload.sqft),
      status: text(
        payload.status ?? payload.homeStatus ?? payload.listing_status ?? payload.listingStatus,
      ),
      listedAt: date(
        payload.listedAt ??
          payload.onMarketDate ??
          payload.datePosted ??
          payload.datePostedString ??
          payload.listing_date ??
          payload.createdAt,
      ),
      images: images(
        payload.images ??
          payload.photos ??
          payload.listingPhotos ??
          payload.photoUrls ??
          payload.imgSrc ??
          payload.mainImage,
      ),
      brokerage:
        agent?.brokerage ?? text(payload.brokerage ?? payload.brokerName ?? brokerObject.name),
      agent,
    };
  }
}
