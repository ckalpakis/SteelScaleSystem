import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import type { WebsiteAuditOptions, WebsiteFetcher, WebsitePage } from './types.js';

export const WEBSITE_AUDIT_USER_AGENT =
  'SteelScaleWebsiteIntelligence/1.0 (+https://steelscale.example/website-audit)';

export function normalizeAuditUrl(value: string): URL {
  const input = value.trim();
  const url = new URL(input.includes('://') ? input : `https://${input}`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Website URL must use HTTP or HTTPS');
  }
  if (url.username || url.password) throw new Error('Website URL must not contain credentials');
  url.hash = '';
  if (
    (url.protocol === 'https:' && url.port === '443') ||
    (url.protocol === 'http:' && url.port === '80')
  ) {
    url.port = '';
  }
  return url;
}

export function isAllowedBusinessDomain(hostname: string, normalizedDomain: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
  const domain = normalizedDomain
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
  return host === domain || host.endsWith(`.${domain}`);
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  const [first, second] = parts;
  if (parts.length !== 4 || first === undefined || second === undefined) return true;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127) ||
    first >= 224
  );
}

export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return isPrivateIpv4(address);
  if (isIP(address) !== 6) return true;
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) return isPrivateIpv4(normalized.slice(7));
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized)
  );
}

async function assertPublicHostname(hostname: string): Promise<void> {
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('Website hostname resolves to a private or reserved network address');
  }
}

async function limitedText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Website response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error(`Website response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export class SafeWebsiteFetcher implements WebsiteFetcher {
  constructor(private readonly options: WebsiteAuditOptions) {}

  async fetchPage(input: string, allowedDomain: string): Promise<WebsitePage> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.options.retries + 1; attempt += 1) {
      try {
        let current = normalizeAuditUrl(input);
        for (let redirect = 0; redirect <= this.options.maxRedirects; redirect += 1) {
          if (!isAllowedBusinessDomain(current.hostname, allowedDomain)) {
            throw new Error(`Refusing to leave business domain: ${current.hostname}`);
          }
          await assertPublicHostname(current.hostname);
          const response = await fetch(current, {
            redirect: 'manual',
            headers: {
              'user-agent': WEBSITE_AUDIT_USER_AGENT,
              accept: 'text/html,application/xhtml+xml;q=0.9',
            },
            signal: AbortSignal.timeout(this.options.timeoutMs),
          });
          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (!location) throw new Error(`HTTP ${response.status} redirect has no Location`);
            if (redirect === this.options.maxRedirects) throw new Error('Too many redirects');
            current = normalizeAuditUrl(new URL(location, current).toString());
            continue;
          }
          if (retryableStatus(response.status))
            throw new Error(`Retryable HTTP ${response.status}`);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
          if (
            contentType &&
            !contentType.includes('text/html') &&
            !contentType.includes('application/xhtml')
          ) {
            throw new Error(`Unsupported website content type: ${contentType}`);
          }
          return {
            requestedUrl: input,
            finalUrl: current.toString(),
            statusCode: response.status,
            html: await limitedText(response, this.options.maxResponseBytes),
            attempts: attempt,
          };
        }
      } catch (error) {
        lastError = error;
        if (attempt <= this.options.retries) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(250 * 2 ** (attempt - 1), 1_000)),
          );
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
