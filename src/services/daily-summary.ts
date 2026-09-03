import { BookingStatus, CallType } from '@prisma/client';

import { db } from '../db/client.js';
import { sendSlackMessage } from './slack-alerts.js';
import { sendOwnerNotification } from './owner-notifications.js';

export interface DailySummary {
  periodStart: string;
  periodEnd: string;
  totalCalls: number;
  missedCalls: number;
  bookings: number;
  failedBookingAttempts: Array<{
    id: string;
    clientId: string;
    businessName: string;
    source: string;
    errorMessage: string | null;
    createdAt: string;
  }>;
  slackSent: boolean;
  ownerSmsAttempted: number;
  ownerSmsSent: number;
}

export async function createDailySummary(now = new Date()): Promise<DailySummary> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
  const [totalCalls, missedCalls, bookings, failedAttempts] = await Promise.all([
    db.callLog.count({ where: { createdAt: { gte: since, lte: now } } }),
    db.callLog.count({
      where: { createdAt: { gte: since, lte: now }, callType: CallType.missed },
    }),
    db.bookingAttempt.count({
      where: { createdAt: { gte: since, lte: now }, status: BookingStatus.success },
    }),
    db.bookingAttempt.findMany({
      where: { createdAt: { gte: since, lte: now }, status: BookingStatus.failed },
      include: { client: { select: { businessName: true } } },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const failures = failedAttempts.map((attempt) => ({
    id: attempt.id,
    clientId: attempt.clientId,
    businessName: attempt.client.businessName,
    source: attempt.source,
    errorMessage: attempt.errorMessage,
    createdAt: attempt.createdAt.toISOString(),
  }));
  const failureLines = failures.length
    ? failures
        .slice(0, 20)
        .map(
          (attempt) =>
            `• ${attempt.businessName} — ${attempt.id}: ${attempt.errorMessage ?? 'No error recorded'}`,
        )
    : ['• None'];
  if (failures.length > 20) failureLines.push(`• …and ${failures.length - 20} more`);

  const slackSent = await sendSlackMessage(
    [
      ':bar_chart: *Steel Scale daily summary — last 24 hours*',
      `Period: ${since.toISOString()} to ${now.toISOString()}`,
      `Total calls: ${totalCalls}`,
      `Missed calls: ${missedCalls}`,
      `Successful bookings: ${bookings}`,
      `Failed booking attempts: ${failures.length}`,
      '*Failures:*',
      ...failureLines,
    ].join('\n'),
    { attempted: 'daily_summary' },
  );

  const notificationClients = await db.client.findMany({
    where: { ownerNotificationNumber: { not: null }, dailySummarySms: true },
    select: {
      id: true,
      businessName: true,
      phoneNumber: true,
      ownerNotificationNumber: true,
    },
  });
  let ownerSmsSent = 0;
  const eventKey = now.toISOString().slice(0, 10);
  for (const client of notificationClients) {
    if (!client.ownerNotificationNumber) continue;
    const [clientCalls, clientMissed, clientBookings, clientFailures] = await Promise.all([
      db.callLog.count({
        where: { clientId: client.id, createdAt: { gte: since, lte: now } },
      }),
      db.callLog.count({
        where: {
          clientId: client.id,
          createdAt: { gte: since, lte: now },
          callType: CallType.missed,
        },
      }),
      db.bookingAttempt.count({
        where: {
          clientId: client.id,
          createdAt: { gte: since, lte: now },
          status: BookingStatus.success,
        },
      }),
      db.bookingAttempt.count({
        where: {
          clientId: client.id,
          createdAt: { gte: since, lte: now },
          status: BookingStatus.failed,
        },
      }),
    ]);
    const sent = await sendOwnerNotification({
      clientId: client.id,
      from: client.phoneNumber,
      to: client.ownerNotificationNumber,
      type: 'daily_summary',
      eventKey,
      body: `DAILY SUMMARY — ${client.businessName}\nCalls: ${clientCalls} · Missed: ${clientMissed}\nBookings: ${clientBookings} · Failed: ${clientFailures}`,
    });
    if (sent) ownerSmsSent += 1;
  }

  return {
    periodStart: since.toISOString(),
    periodEnd: now.toISOString(),
    totalCalls,
    missedCalls,
    bookings,
    failedBookingAttempts: failures,
    slackSent,
    ownerSmsAttempted: notificationClients.length,
    ownerSmsSent,
  };
}
