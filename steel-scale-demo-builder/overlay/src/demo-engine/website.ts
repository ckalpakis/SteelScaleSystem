import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { emptyEvidence, extractEvidence, normalizeBusinessUrl, type WebsiteEvidence } from './core.js';

/** Conservative deny rules: reject literals/resolution to private, special or non-global ranges. */
export function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0, c = 0] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(ip) !== 6) return false;
  // Only ordinary global-unicast IPv6; exclude mapped IPv4, tunnels, documentation and special-use ranges.
  const first = parseInt(ip.split(':')[0] ?? '', 16);
  const normalized = ip.toLowerCase();
  return first >= 0x2000 && first <= 0x3fff && !/^2001:|^2002:|^3fff:/i.test(normalized);
}
export function permittedHostname(value: string): boolean {
  const host = value.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  return !isIP(host) && host.includes('.') && !/(^|\.)(localhost|local|internal|test|invalid|example|onion)$/.test(host);
}
const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 10000;
const baseHost = (value: string) => value.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');

async function getHomepage(input: string): Promise<{ html: string; url: string }> {
  let url = new URL(normalizeBusinessUrl(input));
  const initialHost = baseHost(url.hostname);
  const abort = AbortSignal.timeout(TIMEOUT_MS);
  for (let redirects = 0; redirects <= 2; redirects += 1) {
    if (!permittedHostname(url.hostname) || baseHost(url.hostname) !== initialHost) throw new Error('Unsafe website host or cross-domain redirect.');
    const addresses = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
      if (abort.aborted) { reject(new Error('Website lookup timed out.')); return; }
      const stop = () => reject(new Error('Website lookup timed out.'));
      abort.addEventListener('abort', stop, { once: true });
      lookup(url.hostname, { all: true, verbatim: true }).then(resolve, reject).finally(() => abort.removeEventListener('abort', stop));
    });
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error('Website resolves to a non-public address.');
    const address = addresses[0];
    if (!address) throw new Error('No public address.');
    const result = await new Promise<{ status: number; location?: string; html: string }>((resolve, reject) => {
      const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
      // Pin DNS at connection time. The original URL preserves Host and TLS hostname verification.
      const req = transport(url, {
        agent: false, family: address.family, signal: abort,
        lookup: (_hostname, options, callback) => {
          if (typeof options === 'object' && options.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
        headers: { 'user-agent': 'SteelScaleDemoResearch/1.0', accept: 'text/html', 'accept-encoding': 'identity' },
      }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) { const location = res.headers.location; res.destroy(); resolve({ status, ...(location ? { location } : {}), html: '' }); return; }
        if (status < 200 || status >= 300 || !String(res.headers['content-type']).toLowerCase().includes('text/html') || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
          res.destroy(); reject(new Error('Website did not return uncompressed HTML.')); return;
        }
        if (Number(res.headers['content-length'] ?? 0) > MAX_BYTES) { res.destroy(); reject(new Error('Website response too large.')); return; }
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) { res.destroy(); reject(new Error('Website response too large.')); }
          else chunks.push(chunk);
        });
        res.on('end', () => resolve({ status, html: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('Website response interrupted.')));
      });
      req.on('error', reject); req.end();
    });
    if (result.status >= 300 && result.status < 400) {
      if (!result.location || redirects === 2) throw new Error('Too many or invalid redirects.');
      const nextUrl = new URL(result.location, url);
      if (url.protocol === 'https:' && nextUrl.protocol !== 'https:') throw new Error('Refusing HTTPS downgrade.');
      url = new URL(normalizeBusinessUrl(nextUrl.toString()));
    } else return { html: result.html, url: url.toString() };
  }
  throw new Error('Unable to read website.');
}
export async function researchHomepage(url: string): Promise<WebsiteEvidence> {
  try {
    const result = await getHomepage(url);
    return extractEvidence(result.html, result.url, new Date().toISOString());
  } catch {
    // Do not expose resolved internal IPs, network diagnostics or confidential response bodies.
    return { ...emptyEvidence(url), status: 'unavailable', checkedAt: new Date().toISOString(), warning: 'Homepage could not be safely fetched. Use operator-entered information; no findings have been invented. Google Business Profile was not fetched.' };
  }
}
