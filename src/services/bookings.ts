import { BookingStatus, DestinationType, Prisma } from '@prisma/client';

import { env } from '../config/env.js';
import { db } from '../db/client.js';
import type { InternalBookingRequest, InternalBookingResult } from '../types/booking.js';
import { logger } from '../utils/logger.js';
import { createGhlAppointment } from './ghl.js';
import { localDateTime, sendOwnerNotification } from './owner-notifications.js';
import { sendBookingToZapier } from './zapier.js';
import { alertFailedBooking } from './slack-alerts.js';

interface DeliveryResult {
  externalBookingId?: string;
}

interface NotificationClient {
  id: string;
  businessName: string;
  phoneNumber: string;
  timezone: string;
  ownerNotificationNumber: string | null;
  notifyBookingSms: boolean;
  notifyFailedBookingSms: boolean;
}

async function notifyOwnerOfBooking(
  client: NotificationClient,
  request: InternalBookingRequest,
  bookingAttemptId: string,
  needsFollowUp = false,
): Promise<void> {
  if (!client.ownerNotificationNumber) return;
  if (needsFollowUp ? !client.notifyFailedBookingSms : !client.notifyBookingSms) return;

  const heading = needsFollowUp ? 'BOOKING FOLLOW-UP NEEDED' : 'NEW BOOKING';
  const status = needsFollowUp
    ? 'The calendar could not be fully confirmed. Please contact the caller.'
    : 'The appointment was added to the calendar.';
  await sendOwnerNotification({
    clientId: client.id,
    from: client.phoneNumber,
    to: client.ownerNotificationNumber,
    type: needsFollowUp ? 'booking_follow_up' : 'booking_success',
    eventKey: bookingAttemptId,
    body: `${heading} — ${client.businessName}\n${request.customerName} · ${request.phoneNumber}\n${localDateTime(request.preferredTime, client.timezone)}\n${status}`,
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function tryTwice(
  bookingAttemptId: string,
  destination: DestinationType,
  operation: () => Promise<DeliveryResult>,
): Promise<{ result?: DeliveryResult; errors: string[] }> {
  const errors: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return { result: await operation(), errors };
    } catch (error: unknown) {
      const message = errorMessage(error);
      errors.push(`attempt ${attempt}: ${message}`);
      logger.error(
        { err: error, bookingAttemptId, destination, attempt },
        'Primary booking delivery failed',
      );
    }
  }
  return { errors };
}

export async function createBookingAttempt(
  request: InternalBookingRequest,
): Promise<InternalBookingResult> {
  if (request.providerRequestId) {
    const existing = await db.bookingAttempt.findUnique({
      where: { providerRequestId: request.providerRequestId },
    });
    if (existing) {
      return {
        accepted: existing.status === BookingStatus.success,
        bookingAttemptId: existing.id,
        message:
          existing.status === BookingStatus.success
            ? 'Booking request was already delivered.'
            : 'Booking request was already processed but delivery was unsuccessful.',
        destination: existing.deliveredDestinationType ?? undefined,
        fallbackUsed: existing.fallbackUsed,
        manualFollowUpRequired: existing.manualFollowUpRequired,
      };
    }
  }

  const client = await db.client.findUnique({
    where: { id: request.clientId },
    include: { destination: true },
  });
  if (!client) throw new Error(`Client ${request.clientId} was not found`);

  const bookingAttempt = await db.bookingAttempt.create({
    data: {
      clientId: client.id,
      source: request.source,
      status: BookingStatus.pending,
      destinationType: client.destination?.destinationType,
      providerRequestId: request.providerRequestId,
      providerCallId: request.providerCallId,
      requestPayload: request as unknown as Prisma.InputJsonValue,
    },
  });

  if (env.BOOKING_DELIVERY_DRY_RUN) {
    await db.bookingAttempt.update({
      where: { id: bookingAttempt.id },
      data: {
        status: BookingStatus.success,
        deliveredDestinationType: client.destination?.destinationType,
        primaryAttemptCount: 1,
        externalBookingId: `dry-run-${bookingAttempt.id}`,
        completedAt: new Date(),
      },
    });
    await notifyOwnerOfBooking(client, request, bookingAttempt.id);
    return {
      accepted: true,
      bookingAttemptId: bookingAttempt.id,
      message: 'Your appointment was booked successfully (delivery dry run).',
      destination: client.destination?.destinationType,
      fallbackUsed: false,
      manualFollowUpRequired: false,
    };
  }

  const primaryErrors: string[] = [];

  if (client.destination) {
    const primary = await tryTwice(
      bookingAttempt.id,
      client.destination.destinationType,
      async () => {
        if (client.destination?.destinationType === DestinationType.zapier) {
          if (!client.destination.zapierWebhookUrl) {
            throw new Error('Client destination has no Zapier webhook URL');
          }
          await sendBookingToZapier(
            client.destination.zapierWebhookUrl,
            bookingAttempt.id,
            client.businessName,
            request,
          );
          return {};
        }
        if (!client.destination?.ghlCalendarId) {
          throw new Error('Client destination has no GHL calendar ID');
        }
        const ghl = await createGhlAppointment(
          client.destination.ghlCalendarId,
          bookingAttempt.id,
          client.businessName,
          request,
        );
        return { externalBookingId: ghl.appointmentId };
      },
    );
    primaryErrors.push(...primary.errors);

    if (primary.result) {
      await db.bookingAttempt.update({
        where: { id: bookingAttempt.id },
        data: {
          status: BookingStatus.success,
          deliveredDestinationType: client.destination.destinationType,
          primaryAttemptCount: primary.errors.length + 1,
          externalBookingId: primary.result.externalBookingId,
          completedAt: new Date(),
        },
      });
      await notifyOwnerOfBooking(client, request, bookingAttempt.id);
      return {
        accepted: true,
        bookingAttemptId: bookingAttempt.id,
        message: 'Your appointment was booked successfully.',
        destination: client.destination.destinationType,
        fallbackUsed: false,
        manualFollowUpRequired: false,
      };
    }
  } else {
    primaryErrors.push('Client has no active destination');
  }

  const primaryErrorMessage = primaryErrors.join(' | ');
  try {
    if (!env.GHL_FALLBACK_CALENDAR_ID) {
      throw new Error('GHL_FALLBACK_CALENDAR_ID is not configured');
    }
    const fallback = await createGhlAppointment(
      env.GHL_FALLBACK_CALENDAR_ID,
      bookingAttempt.id,
      client.businessName,
      request,
    );
    await db.bookingAttempt.update({
      where: { id: bookingAttempt.id },
      data: {
        status: BookingStatus.success,
        deliveredDestinationType: DestinationType.ghl_fallback,
        primaryAttemptCount: client.destination ? 2 : 0,
        fallbackUsed: true,
        manualFollowUpRequired: true,
        externalBookingId: fallback.appointmentId,
        errorMessage: `Primary delivery failed: ${primaryErrorMessage}`,
        completedAt: new Date(),
      },
    });
    logger.warn(
      { bookingAttemptId: bookingAttempt.id, primaryErrorMessage },
      'Booking delivered to safety-net GHL calendar; manual follow-up required',
    );
    await notifyOwnerOfBooking(client, request, bookingAttempt.id, true);
    return {
      accepted: true,
      bookingAttemptId: bookingAttempt.id,
      message:
        'Your appointment request was secured, but our team must manually confirm the final calendar placement.',
      destination: DestinationType.ghl_fallback,
      fallbackUsed: true,
      manualFollowUpRequired: true,
    };
  } catch (fallbackError: unknown) {
    const combinedError = `Primary delivery failed: ${primaryErrorMessage}. Safety-net GHL failed: ${errorMessage(fallbackError)}`;
    await db.bookingAttempt.update({
      where: { id: bookingAttempt.id },
      data: {
        status: BookingStatus.failed,
        primaryAttemptCount: client.destination ? 2 : 0,
        fallbackUsed: true,
        manualFollowUpRequired: true,
        errorMessage: combinedError,
        completedAt: new Date(),
      },
    });
    logger.error(
      {
        err: fallbackError,
        clientId: client.id,
        bookingAttemptId: bookingAttempt.id,
        primaryErrorMessage,
        attempted: 'safety_net_booking',
      },
      'Primary and safety-net booking delivery failed',
    );
    await alertFailedBooking({
      clientId: client.id,
      businessName: client.businessName,
      bookingAttemptId: bookingAttempt.id,
      callerName: request.customerName,
      callerPhone: request.phoneNumber,
      service: request.service,
      preferredTime: request.preferredTime,
      error: combinedError,
    });
    await notifyOwnerOfBooking(client, request, bookingAttempt.id, true);
    return {
      accepted: false,
      bookingAttemptId: bookingAttempt.id,
      message: 'We could not confirm the appointment. A team member must follow up manually.',
      fallbackUsed: true,
      manualFollowUpRequired: true,
    };
  }
}
