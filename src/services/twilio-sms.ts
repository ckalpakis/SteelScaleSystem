import { randomUUID } from 'node:crypto';

import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export interface SendSmsInput {
  clientId: string;
  from: string;
  to: string;
  body: string;
}

export interface SendSmsResult {
  sid: string;
}

export async function sendSms(input: SendSmsInput): Promise<SendSmsResult> {
  if (env.TWILIO_SMS_DRY_RUN) {
    const sid = `dry-run-${randomUUID()}`;
    logger.info({ ...input, sid }, 'Twilio SMS dry run completed');
    return { sid };
  }

  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required to send SMS');
  }

  logger.info({ from: input.from, to: input.to }, 'Sending Twilio SMS');

  const credentials = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString(
    'base64',
  );
  let response: Response;
  try {
    response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${credentials}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ From: input.from, To: input.to, Body: input.body }),
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch (error: unknown) {
    logger.error(
      { err: error, clientId: input.clientId, attempted: 'twilio_sms', to: input.to },
      'Twilio API request failed',
    );
    throw error;
  }

  const responseBody: unknown = await response.json();

  if (!response.ok) {
    logger.error(
      { clientId: input.clientId, attempted: 'twilio_sms', to: input.to, status: response.status },
      'Twilio API rejected SMS',
    );
    throw new Error(
      `Twilio SMS request failed (${response.status}): ${JSON.stringify(responseBody)}`,
    );
  }

  if (
    !responseBody ||
    typeof responseBody !== 'object' ||
    !('sid' in responseBody) ||
    typeof responseBody.sid !== 'string'
  ) {
    throw new Error('Twilio SMS response did not contain a message SID');
  }

  logger.info(
    { clientId: input.clientId, messageSid: responseBody.sid, to: input.to },
    'Twilio SMS accepted',
  );
  return { sid: responseBody.sid };
}
