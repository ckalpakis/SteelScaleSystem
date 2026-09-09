import { json, type Transaction } from '../shared.js';

// Append-only through the application. No update/delete API; not tamper-proof against DB admins.
export async function audit(
  tx: Transaction,
  organizationId: string,
  actor: string,
  type: string,
  subjectId: string,
  details: unknown = {},
): Promise<void> {
  await tx.auditLog.create({
    data: {
      organizationId,
      actor,
      type,
      subjectId,
      details: json(details),
    },
  });
}
