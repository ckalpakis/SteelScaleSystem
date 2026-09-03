import { CallOutcome, CallType, Prisma, SmsAttemptStatus } from '@prisma/client';

import { db } from '../db/client.js';
import type { TwilioVoiceStatusEvent } from '../types/twilio.js';
import { logger } from '../utils/logger.js';
import { sendSms } from './twilio-sms.js';
import { sendOwnerNotification } from './owner-notifications.js';

const MISSED_STATUSES = new Set(['busy', 'canceled', 'failed', 'no-answer']);

function isVoicemail(answeredBy: string | undefined): boolean {
  return answeredBy === 'fax' || answeredBy?.startsWith('machine') === true;
}

function isMissedCall(event: TwilioVoiceStatusEvent): boolean {
  return MISSED_STATUSES.has(event.callStatus) || isVoicemail(event.answeredBy);
}

function renderTemplate(template: string, businessName: string): string {
  return template.replaceAll('{business_name}', businessName);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function processTwilioVoiceStatus(event: TwilioVoiceStatusEvent): Promise<void> {
  if (!isMissedCall(event)) {
    logger.info(
      { callSid: event.callSid, callStatus: event.callStatus, answeredBy: event.answeredBy },
      'Ignoring non-missed call status',
    );
    return;
  }

  const client = await db.client.findUnique({ where: { phoneNumber: event.to } });

  if (!client) {
    logger.warn({ callSid: event.callSid, calledNumber: event.to }, 'No client for called number');
    return;
  }

  let callLog: { id: string };

  try {
    callLog = await db.callLog.create({
      data: {
        clientId: client.id,
        providerCallId: event.callSid,
        callerNumber: event.from,
        callType: CallType.missed,
        durationSeconds: event.durationSeconds,
        outcome: isVoicemail(event.answeredBy) ? CallOutcome.voicemail : CallOutcome.no_answer,
        rawPayload: event.rawPayload,
        smsAttemptStatus: SmsAttemptStatus.pending,
        smsAttemptedAt: new Date(),
      },
      select: { id: true },
    });
  } catch (error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      logger.info({ callSid: event.callSid }, 'Missed-call callback already processed');
      return;
    }

    throw error;
  }

  try {
    const sms = await sendSms({
      clientId: client.id,
      from: client.phoneNumber,
      to: event.from,
      body: renderTemplate(client.missedCallSmsTemplate, client.businessName),
    });

    await db.callLog.update({
      where: { id: callLog.id },
      data: { smsAttemptStatus: SmsAttemptStatus.sent, outboundSmsSid: sms.sid },
    });
  } catch (error: unknown) {
    const message = errorMessage(error);

    logger.error(
      {
        error,
        clientId: client.id,
        callLogId: callLog.id,
        callSid: event.callSid,
        attempted: 'missed_call_sms',
      },
      'Missed-call SMS failed',
    );

    await db.callLog.update({
      where: { id: callLog.id },
      data: { smsAttemptStatus: SmsAttemptStatus.failed, smsErrorMessage: message },
    });
  }

  if (client.ownerNotificationNumber && client.notifyMissedCallSms) {
    await sendOwnerNotification({
      clientId: client.id,
      from: client.phoneNumber,
      to: client.ownerNotificationNumber,
      type: 'missed_call',
      eventKey: event.callSid,
      body: `MISSED CALL — ${client.businessName}\nCaller: ${event.from}\nPlease call them back when available.`,
    });
  }
}
