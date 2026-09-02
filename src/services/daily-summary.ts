import { BookingStatus, CallType } from '@prisma/client';

import { db } from '../db/client.js';
import { sendSlackMessage } from './slack-alerts.js';

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

  return {
    periodStart: since.toISOString(),
    periodEnd: now.toISOString(),
    totalCalls,
    missedCalls,
    bookings,
    failedBookingAttempts: failures,
    slackSent,
  };
}
