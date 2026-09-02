import {
  normalizeBusinessName,
  normalizeDomain,
  normalizeEmail,
  normalizePhone,
} from './normalization.js';
import type { NormalizedProspect } from './types.js';

const SIGNAL_KEY = /^[a-z][a-z0-9_]{0,99}$/;

export function validateNormalizedProspect(
  prospect: NormalizedProspect,
  defaultCountryCallingCode?: string,
): string[] {
  const errors: string[] = [];
  const business = prospect.business;

  if (!normalizeBusinessName(business.name ?? '')) errors.push('business.name is required');
  if (business.website && !normalizeDomain(business.website)) {
    errors.push('business.website must be a valid HTTP(S) URL or domain');
  }
  if (business.phone && !normalizePhone(business.phone, defaultCountryCallingCode)) {
    errors.push('business.phone cannot be normalized to E.164');
  }
  if (business.latitude !== undefined && (business.latitude < -90 || business.latitude > 90)) {
    errors.push('business.latitude must be between -90 and 90');
  }
  if (business.longitude !== undefined && (business.longitude < -180 || business.longitude > 180)) {
    errors.push('business.longitude must be between -180 and 180');
  }
  if (business.sourceCreatedAt && Number.isNaN(business.sourceCreatedAt.valueOf())) {
    errors.push('business.sourceCreatedAt is invalid');
  }
  if (prospect.sourceCreatedAt && Number.isNaN(prospect.sourceCreatedAt.valueOf())) {
    errors.push('sourceCreatedAt is invalid');
  }

  const hasStableSourceIdentity = Boolean(
    prospect.externalId?.trim() ||
    business.googlePlaceId?.trim() ||
    business.googleCid?.trim() ||
    normalizeDomain(business.website) ||
    normalizePhone(business.phone, defaultCountryCallingCode),
  );
  const hasCarefulBusinessIdentity = Boolean(
    normalizeBusinessName(business.name ?? '') && business.city?.trim() && business.state?.trim(),
  );
  if (!hasStableSourceIdentity && !hasCarefulBusinessIdentity) {
    errors.push(
      'record needs an external ID, place ID, CID, domain, phone, or name with city and state',
    );
  }

  for (const [index, contact] of (prospect.contacts ?? []).entries()) {
    if (contact.sourceCreatedAt && Number.isNaN(contact.sourceCreatedAt.valueOf())) {
      errors.push(`contacts[${index}].sourceCreatedAt is invalid`);
    }
    if (contact.phone && !normalizePhone(contact.phone, defaultCountryCallingCode)) {
      errors.push(`contacts[${index}].phone cannot be normalized to E.164`);
    }
    if (contact.email && !normalizeEmail(contact.email)) {
      errors.push(`contacts[${index}].email is invalid`);
    }
    if (
      !contact.fullName &&
      !contact.firstName &&
      !contact.lastName &&
      !contact.phone &&
      !contact.email
    ) {
      errors.push(`contacts[${index}] has no usable identity or name`);
    }
  }

  for (const [index, signal] of (prospect.signals ?? []).entries()) {
    if (!SIGNAL_KEY.test(signal.key)) errors.push(`signals[${index}].key is invalid`);
    if (
      signal.confidence !== undefined &&
      (signal.confidence < 0 || signal.confidence > 1 || !Number.isFinite(signal.confidence))
    ) {
      errors.push(`signals[${index}].confidence must be between 0 and 1`);
    }
    if (signal.expiresAt && signal.observedAt && signal.expiresAt < signal.observedAt) {
      errors.push(`signals[${index}].expiresAt precedes observedAt`);
    }
    if (signal.observedAt && Number.isNaN(signal.observedAt.valueOf())) {
      errors.push(`signals[${index}].observedAt is invalid`);
    }
    if (signal.expiresAt && Number.isNaN(signal.expiresAt.valueOf())) {
      errors.push(`signals[${index}].expiresAt is invalid`);
    }
  }

  return errors;
}
