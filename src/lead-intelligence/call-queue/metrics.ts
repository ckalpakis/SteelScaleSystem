import { ProspectCallStatus } from '@prisma/client';

import { db } from '../../db/client.js';

const REACHED = new Set<ProspectCallStatus>([
  ProspectCallStatus.owner_reached,
  ProspectCallStatus.interested,
  ProspectCallStatus.follow_up,
  ProspectCallStatus.demo_booked,
]);
const INTERESTED = new Set<ProspectCallStatus>([
  ProspectCallStatus.interested,
  ProspectCallStatus.follow_up,
  ProspectCallStatus.demo_booked,
]);

export interface ConversionRow {
  label: string;
  calls: number;
  ownersReached: number;
  interested: number;
  demosBooked: number;
  conversionRate: number;
}

function summarize(
  attempts: Array<{
    status: ProspectCallStatus;
    niche: string | null;
    scoreBand: string | null;
    pitchAngle: string;
  }>,
  selector: (attempt: (typeof attempts)[number]) => string,
): ConversionRow[] {
  const groups = new Map<string, typeof attempts>();
  for (const attempt of attempts) {
    const label = selector(attempt) || 'Unknown';
    groups.set(label, [...(groups.get(label) ?? []), attempt]);
  }
  return [...groups.entries()]
    .map(([label, rows]) => {
      const ownersReached = rows.filter(({ status }) => REACHED.has(status)).length;
      const interested = rows.filter(({ status }) => INTERESTED.has(status)).length;
      const demosBooked = rows.filter(
        ({ status }) => status === ProspectCallStatus.demo_booked,
      ).length;
      return {
        label,
        calls: rows.length,
        ownersReached,
        interested,
        demosBooked,
        conversionRate: rows.length ? demosBooked / rows.length : 0,
      };
    })
    .sort((left, right) => right.calls - left.calls || right.conversionRate - left.conversionRate);
}

export async function getCallPerformance(input: { clientId?: string; now?: Date } = {}) {
  const now = input.now ?? new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const attempts = await db.callAttempt.findMany({
    where: { clientId: input.clientId },
    select: { status: true, niche: true, scoreBand: true, pitchAngle: true, occurredAt: true },
  });
  const today = attempts.filter(({ occurredAt }) => occurredAt >= startOfDay);
  const reached = (rows: typeof attempts) =>
    rows.filter(({ status }) => REACHED.has(status)).length;
  return {
    callsToday: today.length,
    ownersReached: reached(today),
    interested: today.filter(({ status }) => INTERESTED.has(status)).length,
    demosBooked: today.filter(({ status }) => status === ProspectCallStatus.demo_booked).length,
    byNiche: summarize(attempts, ({ niche }) => niche ?? 'Unknown'),
    byScoreBand: summarize(attempts, ({ scoreBand }) => scoreBand ?? 'Unscored'),
    byPitchAngle: summarize(attempts, ({ pitchAngle }) => pitchAngle),
  };
}
