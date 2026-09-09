import { Router } from 'express';
import type { Database } from '../workforce/shared.js';

export const lifecycle = { stopping: false };

// Coalesce probes and bound response latency, including when a dependency is unavailable.
export function healthRoutes(
  probe: () => Promise<void>,
  alive: () => boolean = () => !lifecycle.stopping,
) {
  const router = Router();
  let pending: Promise<boolean> | undefined;
  let cached = false,
    checkedAt = 0;
  router.get('/health', (_req, res) =>
    res.status(alive() ? 200 : 503).json({ status: alive() ? 'ok' : 'stopping' }),
  );
  router.get('/ready', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!alive()) {
      res.status(503).json({ status: 'not_ready' });
      return;
    }
    if (!pending && Date.now() - checkedAt > 1000) {
      pending = probe()
        .then(
          () => true,
          () => false,
        )
        .then((ok) => {
          cached = ok;
          checkedAt = Date.now();
          pending = undefined;
          return ok;
        });
    }
    let timer: NodeJS.Timeout | undefined;
    const ready = pending
      ? await Promise.race([
          pending,
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), 2000);
          }),
        ])
      : cached;
    if (timer) clearTimeout(timer);
    res
      .status(ready && alive() ? 200 : 503)
      .json({ status: ready && alive() ? 'ready' : 'not_ready' });
  });
  return router;
}

export async function databaseReady(database: Database) {
  await database.$queryRaw`SELECT 1`;
  // Also verifies the additive deployment migration is present, not only DB connectivity.
  await database.backgroundTask.findFirst({ select: { id: true } });
  const failed = await database.$queryRaw<
    Array<{ id: string }>
  >`SELECT id FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL LIMIT 1`;
  if (failed.length) throw new Error('Migration incomplete');
}
