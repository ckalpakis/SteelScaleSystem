import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
export function signForm(
  secret: string,
  authorization: string,
  scope: string,
  now = Date.now(),
): string {
  const payload = `${now + 3600000}.${randomBytes(16).toString('hex')}`;
  return `${payload}.${createHmac('sha256', secret).update(`${authorization}|${scope}|${payload}`).digest('hex')}`;
}
export function verifyForm(
  value: unknown,
  secret: string,
  authorization: string,
  scope: string,
  now = Date.now(),
): boolean {
  if (typeof value !== 'string' || !/^\d{13}\.[a-f0-9]{32}\.[a-f0-9]{64}$/.test(value))
    return false;
  const [expiry = '', nonce = '', signature = ''] = value.split('.');
  if (Number(expiry) < now || Number(expiry) > now + 3600000) return false;
  const expected = createHmac('sha256', secret)
    .update(`${authorization}|${scope}|${expiry}.${nonce}`)
    .digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
