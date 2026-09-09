import { createCipheriv, createDecipheriv, randomBytes, createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isPublicAddress, permittedHostname } from '../demo-engine/website.js';
import { string, WorkforceError } from '../workforce/shared.js';

function key() {
  const value = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (!value || !/^[a-f0-9]{64}$/i.test(value))
    throw new WorkforceError(503, 'integration_encryption_not_configured');
  return Buffer.from(value, 'hex');
}
export function seal(value: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}
export function unseal(value: string, context: string): string {
  const [iv, tag, data] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
  if (!iv || !tag || !data) throw new Error('invalid_ciphertext');
  const cipher = createDecipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8');
}
export function webhookUrl(value: unknown): URL {
  let url: URL;
  try {
    url = new URL(string(value, 2000));
  } catch {
    throw new WorkforceError(400, 'invalid_webhook_url');
  }
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !permittedHostname(url.hostname)
  )
    throw new WorkforceError(400, 'public_https_webhook_required');
  return url;
}
export function signature(secret: string, timestamp: string, body: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}
export interface SendRequest {
  url: string;
  body: string;
  secret: string;
  deliveryId: string;
}
export type Transport = (input: SendRequest) => Promise<number>;
/** TLS hostname verification stays on; DNS is checked and pinned, redirects are never followed. */
export const sendWebhook: Transport = async ({ url: value, body, secret, deliveryId }) => {
  const url = webhookUrl(value);
  const abort = AbortSignal.timeout(10000);
  const addresses = await new Promise<Array<{ address: string; family: number }>>(
    (resolve, reject) => {
      const stop = () => reject(new Error('dns_timeout'));
      abort.addEventListener('abort', stop, { once: true });
      lookup(url.hostname, { all: true, verbatim: true })
        .then(resolve, reject)
        .finally(() => abort.removeEventListener('abort', stop));
    },
  );
  if (
    !Array.isArray(addresses) ||
    !addresses.length ||
    addresses.some(({ address }) => !isPublicAddress(address))
  )
    throw new Error('unsafe_dns');
  const address = addresses[0]!;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  return new Promise<number>((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        agent: false,
        signal: abort,
        family: address.family,
        lookup: (_hostname, options, callback) => {
          if (typeof options === 'object' && options.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'SteelScaleWebhooks/1.0',
          'X-SteelScale-Delivery': deliveryId,
          'Idempotency-Key': deliveryId,
          'X-SteelScale-Timestamp': timestamp,
          'X-SteelScale-Signature': signature(secret, timestamp, body),
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        res.destroy();
        resolve(status);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
};
