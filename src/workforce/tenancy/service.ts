import { createHash, randomBytes } from 'node:crypto';
import type { OrganizationRole } from '@prisma/client';
import { audit } from '../audit/service.js';
import { WorkforceError, type Transaction, type Database } from '../shared.js';

export const scopes = [
  'crm:read',
  'crm:write',
  'agents:write',
  'approvals:write',
  'audit:read',
  'revenue:write',
  'integrations:write',
  'events:write',
] as const;
export type Scope = (typeof scopes)[number];
export interface Principal {
  organizationId: string;
  credentialId: string;
  actor: string;
  scopes: string[];
  role?: OrganizationRole;
  integrationId?: string;
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function issueCredential(
  tx: Transaction,
  organizationId: string,
  owner: { membershipId: string } | { integrationId: string },
  permissions: Scope[],
  now = new Date(),
) {
  const token = `ssw_${randomBytes(32).toString('hex')}`;
  const credential = await tx.workforceCredential.create({
    data: {
      organizationId,
      ...owner,
      scopes: permissions,
      tokenHash: tokenHash(token),
      expiresAt: new Date(now.getTime() + 90 * 86_400_000),
    },
  });
  return { token, credentialId: credential.id, expiresAt: credential.expiresAt };
}

export async function authenticate(
  database: Database,
  authorization: string | undefined,
  now = new Date(),
): Promise<Principal> {
  const token = authorization?.match(/^Bearer (ssw_[a-f0-9]{64})$/)?.[1];
  if (!token) throw new WorkforceError(401, 'unauthorized');
  const credential = await database.workforceCredential.findUnique({
    where: { tokenHash: tokenHash(token) },
    include: { membership: true, integration: true },
  });
  if (
    !credential ||
    credential.revokedAt ||
    credential.expiresAt <= now ||
    (credential.membershipId !== null) === (credential.integrationId !== null) ||
    (credential.membershipId && !credential.membership?.active) ||
    (credential.integrationId && !credential.integration?.enabled)
  ) {
    throw new WorkforceError(401, 'unauthorized');
  }
  return {
    organizationId: credential.organizationId,
    credentialId: credential.id,
    actor: credential.membershipId
      ? `member:${credential.membershipId}`
      : `integration:${credential.integrationId}`,
    scopes: credential.scopes,
    role: credential.membership?.role,
    integrationId: credential.integrationId ?? undefined,
  };
}

export function authorize(principal: Principal, scope: Scope): void {
  if (
    !principal.scopes.includes(scope) ||
    (principal.integrationId && scope !== 'events:write') ||
    (scope.endsWith(':write') && principal.role === 'viewer') ||
    (['agents:write', 'approvals:write', 'revenue:write', 'integrations:write'].includes(scope) &&
      principal.role !== 'owner' &&
      principal.role !== 'admin')
  ) {
    throw new WorkforceError(403, 'forbidden');
  }
}

export async function provisionOrganization(
  database: Database,
  input: { name: string; ownerSubject: string; legacyClientId?: string },
  actor: string,
) {
  return database.$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: {
        name: input.name,
        legacyClientId: input.legacyClientId,
      },
    });
    const user = await tx.user.upsert({
      where: { externalSubject: input.ownerSubject },
      create: { externalSubject: input.ownerSubject },
      update: {},
    });
    const member = await tx.organizationMember.create({
      data: {
        organizationId: organization.id,
        subject: input.ownerSubject,
        userId: user.id,
        role: 'owner',
      },
    });
    const credential = await issueCredential(tx, organization.id, { membershipId: member.id }, [
      ...scopes,
    ]);
    await audit(tx, organization.id, actor, 'organization.created', organization.id);
    await audit(tx, organization.id, actor, 'credential.issued', credential.credentialId);
    return { organization, ...credential };
  });
}
