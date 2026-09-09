import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';

export type Transaction = Prisma.TransactionClient;
export type Database = PrismaClient;

export class WorkforceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkforceError(400, 'invalid_object');
  }
  return value as Record<string, unknown>;
}

export function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new WorkforceError(400, 'unknown_field');
  }
}

export function string(value: unknown, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new WorkforceError(400, 'invalid_string');
  }
  return value.trim();
}

export function uuid(value: unknown): string {
  const result = string(value, 36);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(result)) {
    throw new WorkforceError(400, 'invalid_id');
  }
  return result;
}

export function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new WorkforceError(400, 'invalid_integer');
  }
  return value;
}

export function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new WorkforceError(400, 'invalid_boolean');
  return value;
}

export function date(value: unknown, now = new Date()): Date {
  const text = string(value, 40);
  const result = new Date(text);
  if (
    !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(text) ||
    !Number.isFinite(result.getTime()) ||
    result.getTime() > now.getTime() + 300_000
  ) {
    throw new WorkforceError(400, 'invalid_timestamp');
  }
  return result;
}

export function currency(value: unknown): string {
  const result = string(value, 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(result)) throw new WorkforceError(400, 'invalid_currency');
  return result;
}

export function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export function hash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

// Serialize tenant mutations across replicas; operations in this boundary are DB-only.
export async function tenantTransaction<T>(
  database: Database,
  organizationId: string,
  operation: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return database.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Organization" WHERE id = ${organizationId}::uuid FOR UPDATE`;
      if (!rows.length) throw new WorkforceError(404, 'organization_not_found');
      return operation(tx);
    },
    { timeout: 15_000 },
  );
}
