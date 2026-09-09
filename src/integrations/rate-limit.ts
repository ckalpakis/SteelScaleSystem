import type { RequestHandler } from 'express';
import { tokenHash } from '../workforce/tenancy/service.js';
import { WorkforceError, type Database } from '../workforce/shared.js';
const peers = new Map<string, { window: number; count: number }>();
export const peerLimit: RequestHandler = (req, _res, next) => {
  const now = Math.floor(Date.now() / 60000);
  const key = tokenHash(req.socket.remoteAddress ?? 'unknown');
  for (const [id, value] of peers) if (value.window !== now) peers.delete(id);
  const entry = peers.get(key) ?? { window: now, count: 0 };
  entry.count++;
  if (peers.size >= 10000 || entry.count > 300) throw new WorkforceError(429, 'rate_limited');
  peers.set(key, entry);
  next();
};
export async function organizationLimit(db: Database, organizationId: string, now = new Date()) {
  const window = new Date(Math.floor(now.getTime() / 60000) * 60000);
  const rows = await db.$queryRaw<
    Array<{ count: number }>
  >`INSERT INTO "OrganizationWebhookLimit" ("organizationId", "window", count) VALUES (${organizationId}::uuid, ${window}, 1)
    ON CONFLICT ("organizationId") DO UPDATE SET "window" = EXCLUDED."window", count = CASE WHEN "OrganizationWebhookLimit"."window" = EXCLUDED."window" THEN "OrganizationWebhookLimit".count + 1 ELSE 1 END RETURNING count`;
  if (rows[0]!.count > 120) throw new WorkforceError(429, 'organization_rate_limited');
}
