import { createHmac, timingSafeEqual } from 'node:crypto';

export function validTwilioSignature(
  url: string,
  body: Record<string, unknown>,
  signature: string,
  secret: string,
) {
  if (!secret || !signature || Object.values(body).some((value) => typeof value !== 'string'))
    return false;
  const parameters = Object.keys(body)
    .sort()
    .map((key) => `${key}${body[key] as string}`)
    .join('');
  const expected = Buffer.from(
    createHmac('sha1', secret)
      .update(url + parameters)
      .digest('base64'),
  );
  const provided = Buffer.from(signature);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}
export function deliveryTransition(current: string, next: string) {
  if (current === next) return current;
  if (['delivered', 'failed', 'cancelled'].includes(current)) return current;
  if (next === 'delivered' || next === 'failed') return next;
  if (current === 'sent' && next === 'accepted') return current;
  if (['accepted', 'sent'].includes(current) && ['queued', 'sending', 'unknown'].includes(next))
    return current;
  return next;
}
