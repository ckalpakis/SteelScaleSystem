import { Prisma, SmsAttemptStatus } from '@prisma/client';

import { db } from '../db/client.js';
import { logger } from '../utils/logger.js';
import { sendSms } from './twilio-sms.js';

interface OwnerNotificationInput {
  clientId: string;
  from: string;
  to: string;
  type: string;
  eventKey: string;
  body: string;
}

export async function sendOwnerNotification(input: OwnerNotificationInput): Promise<boolean> {
  let notification: { id: string };
  try {
    notification = await db.ownerNotification.create({
      data: {
        clientId: input.clientId,
        notificationType: input.type,
        eventKey: input.eventKey,
        recipient: input.to,
        status: SmsAttemptStatus.pending,
      },
      select: { id: true },
    });
  } catch (error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      logger.info(
        { clientId: input.clientId, type: input.type, eventKey: input.eventKey },
        'Owner notification already processed',
      );
      return false;
    }
    logger.error(
      { err: error, clientId: input.clientId, type: input.type, eventKey: input.eventKey },
      'Could not create owner notification record',
    );
    return false;
  }

  try {
    const sms = await sendSms({
      clientId: input.clientId,
      from: input.from,
      to: input.to,
      body: input.body,
    });
    await db.ownerNotification.update({
      where: { id: notification.id },
      data: { status: SmsAttemptStatus.sent, outboundSmsSid: sms.sid },
    });
    return true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await db.ownerNotification.update({
      where: { id: notification.id },
      data: { status: SmsAttemptStatus.failed, errorMessage: message },
    });
    logger.error(
      { err: error, clientId: input.clientId, type: input.type, eventKey: input.eventKey },
      'Owner SMS notification failed',
    );
    return false;
  }
}

export function localDateTime(value: string | Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}
