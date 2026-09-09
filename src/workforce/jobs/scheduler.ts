import { ingestEvent } from '../events/service.js';
import type { Database } from '../shared.js';

// Identical hourly IDs AND payloads across replicas, so scheduling is idempotent.
export async function scheduleRecoveryScans(database: Database, now = new Date()): Promise<void> {
  const hour = new Date(now);
  hour.setUTCMinutes(0, 0, 0);
  let after: string | undefined;
  for (;;) {
    const organizations = await database.organization.findMany({
      where: {
        agents: { some: { enabled: true, kind: 'revenue_recovery' } },
        ...(after ? { id: { gt: after } } : {}),
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 100,
    });
    for (const organization of organizations) {
      await ingestEvent(database, organization.id, 'scheduler', 'scheduler', {
        id: `recovery:${hour.toISOString()}`,
        version: 1,
        occurredAt: hour.toISOString(),
        type: 'recovery.scan.requested',
        data: {},
      });
    }
    if (organizations.length < 100) return;
    after = organizations.at(-1)?.id;
  }
}
