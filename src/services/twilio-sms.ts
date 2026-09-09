import { randomUUID } from 'node:crypto';

import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { db } from '../db/client.js';
import { TwilioSmsProvider } from '../communications/providers.js';
import {
  legacySmsBlocked,
  recordLegacyOutbound,
  recordLegacyResult,
} from '../communications/legacy.js';

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
  if (await legacySmsBlocked(db, input.clientId, input.to)) throw new Error('contact_opted_out');
  if (env.TWILIO_SMS_DRY_RUN) {
    const sid = `dry-run-${randomUUID()}`;
    logger.info({ clientId: input.clientId, sid }, 'Twilio SMS dry run completed');
    return { sid };
  }

  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required to send SMS');
  }

  const delivery = await recordLegacyOutbound(db, input);
  const result = await new TwilioSmsProvider(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN).sendSms(
    {
      organizationId: input.clientId,
      idempotencyKey: randomUUID(),
      from: input.from,
      to: input.to,
      body: input.body,
      ...(delivery && env.APP_URL?.startsWith('https://')
        ? {
            statusCallback: new URL(
              `/webhooks/twilio/sms-status/${delivery.id}`,
              env.APP_URL,
            ).toString(),
          }
        : {}),
    },
  );
  if (result.errorCode === 'provider_opt_out')
    await db.smsConversation.upsert({
      where: { clientId_customerNumber: { clientId: input.clientId, customerNumber: input.to } },
      create: { clientId: input.clientId, customerNumber: input.to, status: 'opted_out' },
      update: { status: 'opted_out' },
    });
  if (delivery)
    await recordLegacyResult(
      db,
      delivery.id,
      result.status === 'not_sent' ? 'failed' : result.status,
      result.externalId,
      result.errorCode ?? null,
    );
  if (!result.externalId || !['accepted', 'delivered'].includes(result.status))
    throw new Error(result.errorCode ?? 'sms_not_accepted');
  logger.info({ clientId: input.clientId, messageSid: result.externalId }, 'Twilio SMS accepted');
  return { sid: result.externalId };
}
