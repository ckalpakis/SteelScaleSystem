import { createHash } from 'node:crypto';

export function normalizeBusinessName(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replaceAll('&', ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function normalizeLocationPart(value: string | undefined): string | undefined {
  const normalized = value?.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  return normalized || undefined;
}

export function normalizeDomain(value: string | undefined): string | undefined {
  const input = value?.trim();
  if (!input) return undefined;

  try {
    const url = new URL(input.includes('://') ? input : `https://${input}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    const hostname = url.hostname.toLocaleLowerCase('en-US').replace(/\.$/, '');
    return hostname.startsWith('www.') ? hostname.slice(4) : hostname || undefined;
  } catch {
    return undefined;
  }
}

export function normalizePhone(
  value: string | undefined,
  defaultCountryCallingCode?: string,
): string | undefined {
  const input = value?.trim();
  if (!input) return undefined;
  const extensionRemoved = input.replace(/(?:ext\.?|x)\s*\d+$/i, '').trim();
  const digits = extensionRemoved.replace(/\D/g, '');

  if (extensionRemoved.startsWith('+')) {
    return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : undefined;
  }

  const countryDigits = defaultCountryCallingCode?.replace(/\D/g, '');
  if (!countryDigits || !/^[1-9]\d{0,2}$/.test(countryDigits)) return undefined;

  const nationalDigits =
    countryDigits === '1' && digits.length === 11 && digits.startsWith('1')
      ? digits.slice(1)
      : digits;
  const combined = `${countryDigits}${nationalDigits}`;
  return /^[1-9]\d{7,14}$/.test(combined) ? `+${combined}` : undefined;
}

export function normalizeEmail(value: string | undefined): string | undefined {
  const normalized = value?.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return undefined;
  return normalized;
}

export function normalizeProvider(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '_');
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

export function payloadHash(payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(payload)))
    .digest('hex');
}

export function sourceRecordKey(input: {
  externalId?: string;
  sourceUrl?: string;
  rawPayload: unknown;
}): string {
  const externalId = input.externalId?.trim();
  if (externalId) return `external:${externalId}`;

  const sourceUrl = input.sourceUrl?.trim();
  if (sourceUrl) {
    try {
      const url = new URL(sourceUrl);
      url.hash = '';
      return `url:${url.toString()}`;
    } catch {
      // Fall through to a deterministic payload key for malformed source URLs.
    }
  }

  return `payload:${payloadHash(input.rawPayload)}`;
}
