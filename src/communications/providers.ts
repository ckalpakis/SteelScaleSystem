/** Providers perform transport only. They cannot select tenants, authorize claims or clear DND. */
export interface MessageRequest {
  organizationId: string;
  idempotencyKey: string;
  from: string;
  to: string;
  body: string;
  statusCallback?: string;
}
export interface ProviderResult {
  status: 'accepted' | 'delivered' | 'failed' | 'unknown' | 'not_sent';
  externalId: string | null;
  errorCode?: string;
  retryable?: boolean;
}
export interface MessageProvider {
  readonly id: string;
}
export interface SmsProvider extends MessageProvider {
  sendSms(input: MessageRequest): Promise<ProviderResult>;
}
export interface EmailProvider extends MessageProvider {
  sendEmail(input: MessageRequest & { subject: string }): Promise<ProviderResult>;
}
export type Provider = SmsProvider | EmailProvider;

/** Reuses the existing Twilio REST transport, with explicit acceptance/unknown semantics. */
export class TwilioSmsProvider implements SmsProvider {
  readonly id = 'twilio';
  constructor(
    readonly accountSid: string,
    private readonly authToken: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async sendSms(input: MessageRequest): Promise<ProviderResult> {
    if (!/^AC[a-f0-9]{32}$/i.test(this.accountSid) || !this.authToken)
      return { status: 'not_sent', externalId: null, errorCode: 'provider_not_configured' };
    try {
      const response = await this.fetcher(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}/Messages.json`,
        {
          method: 'POST',
          redirect: 'error',
          headers: {
            authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            From: input.from,
            To: input.to,
            Body: input.body,
            ...(input.statusCallback ? { StatusCallback: input.statusCallback } : {}),
          }),
          signal: AbortSignal.timeout(10000),
        },
      );
      const body = (await response.json()) as Record<string, unknown>;
      if (response.status === 429 && body.code === 20429)
        return { status: 'not_sent', externalId: null, retryable: true, errorCode: 'twilio_20429' };
      if (response.status >= 500)
        return { status: 'unknown', externalId: null, errorCode: 'provider_outcome_unknown' };
      if (!response.ok)
        return {
          status: 'failed',
          externalId: null,
          errorCode: body.code === 21610 ? 'provider_opt_out' : `provider_http_${response.status}`,
        };
      if (typeof body.sid !== 'string' || !/^[A-Z]{2}[a-f0-9]{32}$/i.test(body.sid))
        return { status: 'unknown', externalId: null, errorCode: 'invalid_provider_receipt' };
      if (['failed', 'undelivered', 'canceled'].includes(String(body.status)))
        return {
          status: 'failed',
          externalId: body.sid,
          errorCode: body.error_code === 21610 ? 'provider_opt_out' : 'provider_delivery_failed',
        };
      return {
        status: body.status === 'delivered' ? 'delivered' : 'accepted',
        externalId: body.sid,
      };
    } catch {
      // A timeout may occur after provider acceptance. Never retry an ambiguous send.
      return { status: 'unknown', externalId: null, errorCode: 'provider_outcome_unknown' };
    }
  }
}
