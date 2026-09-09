import { randomBytes, randomUUID } from 'node:crypto';
import {
  authenticate,
  authorize,
  issueCredential,
  type Principal,
} from '../workforce/tenancy/service.js';
import { audit } from '../workforce/audit/service.js';
import {
  boolean,
  json,
  keys,
  object,
  string,
  uuid,
  tenantTransaction,
  WorkforceError,
  type Database,
  type Transaction,
} from '../workforce/shared.js';
import { parseMapping } from './mapping.js';
import { enqueueTest, outboundEvents } from './outbox.js';
import { seal, webhookUrl } from './security.js';

export class IntegrationService {
  constructor(
    private db: Database,
    readonly principal: Principal,
  ) {}
  private async transaction<T>(
    fn: (tx: Transaction, organizationId: string) => Promise<T>,
  ): Promise<T> {
    authorize(this.principal, 'integrations:write');
    return tenantTransaction(this.db, this.principal.organizationId, async (tx) => {
      if (this.principal.credentialId !== 'platform-operator') {
        const current = await tx.workforceCredential.findFirst({
          where: {
            organizationId: this.principal.organizationId,
            id: this.principal.credentialId,
            revokedAt: null,
            expiresAt: { gt: new Date() },
            membership: { active: true, role: { in: ['owner', 'admin'] } },
          },
        });
        if (!current?.scopes.includes('integrations:write'))
          throw new WorkforceError(403, 'credential_changed');
      }
      return fn(tx, this.principal.organizationId);
    });
  }
  async overview() {
    return this.transaction(async (tx, organizationId) => {
      const [organization, connections, endpoints, inbound, deliveries] = await Promise.all([
        tx.organization.findUniqueOrThrow({ where: { id: organizationId } }),
        tx.externalConnection.findMany({
          where: { organizationId, provider: { in: ['zapier', 'generic_webhook'] } },
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: {
            id: true,
            name: true,
            provider: true,
            enabled: true,
            webhookMapping: true,
            credentials: {
              select: { id: true, expiresAt: true, revokedAt: true, createdAt: true },
              orderBy: { createdAt: 'desc' },
              take: 20,
            },
          },
        }),
        tx.webhookEndpoint.findMany({
          where: { organizationId },
          select: {
            id: true,
            name: true,
            host: true,
            enabled: true,
            events: true,
            includeExternal: true,
            includeContactData: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
        tx.integrationActivity.findMany({
          where: { organizationId },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
        tx.outboundDelivery.findMany({
          where: { organizationId },
          select: {
            id: true,
            endpointId: true,
            status: true,
            attempts: true,
            lastErrorCode: true,
            createdAt: true,
            availableAt: true,
            history: { orderBy: { attempt: 'desc' }, take: 10 },
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
      ]);
      return { organization, connections, endpoints, inbound, deliveries };
    });
  }
  async createConnection(value: unknown) {
    const b = object(value);
    keys(b, ['name', 'provider', 'mapping']);
    const name = string(b.name, 200);
    const provider = b.provider ?? 'zapier';
    if (typeof provider !== 'string' || !['zapier', 'generic_webhook'].includes(provider))
      throw new WorkforceError(400, 'unsupported_integration');
    const mapping = parseMapping(b.mapping ?? {});
    return this.transaction(async (tx, organizationId) => {
      if ((await tx.externalConnection.count({ where: { organizationId } })) >= 50)
        throw new WorkforceError(409, 'connection_limit');
      const connection = await tx.externalConnection.create({
        data: { organizationId, name, provider, webhookMapping: json(mapping) },
      });
      const credential = await issueCredential(
        tx,
        organizationId,
        { integrationId: connection.id },
        ['events:write'],
      );
      await audit(tx, organizationId, this.principal.actor, 'integration.created', connection.id);
      await audit(
        tx,
        organizationId,
        this.principal.actor,
        'credential.issued',
        credential.credentialId,
        { connectionId: connection.id },
      );
      return { connectionId: connection.id, ...credential };
    });
  }
  async issue(connectionId: string) {
    uuid(connectionId);
    return this.transaction(async (tx, organizationId) => {
      if (
        !(await tx.externalConnection.findFirst({
          where: {
            organizationId,
            id: connectionId,
            enabled: true,
            provider: { in: ['zapier', 'generic_webhook'] },
          },
        }))
      )
        throw new WorkforceError(404, 'connection_not_found');
      if (
        (await tx.workforceCredential.count({
          where: {
            organizationId,
            integrationId: connectionId,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
        })) >= 5
      )
        throw new WorkforceError(409, 'active_credential_limit');
      const credential = await issueCredential(
        tx,
        organizationId,
        { integrationId: connectionId },
        ['events:write'],
      );
      await audit(
        tx,
        organizationId,
        this.principal.actor,
        'credential.issued',
        credential.credentialId,
        { connectionId },
      );
      return credential;
    });
  }
  async revoke(id: string) {
    uuid(id);
    return this.transaction(async (tx, organizationId) => {
      const changed = await tx.workforceCredential.updateMany({
        where: { organizationId, id, integrationId: { not: null }, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (!changed.count) throw new WorkforceError(404, 'credential_not_found');
      await audit(tx, organizationId, this.principal.actor, 'credential.revoked', id);
      return { revoked: true };
    });
  }
  async createEndpoint(value: unknown) {
    const b = object(value);
    keys(b, ['name', 'url', 'events', 'includeExternal', 'includeContactData']);
    const url = webhookUrl(b.url);
    const name = string(b.name, 200);
    if (
      !Array.isArray(b.events) ||
      !b.events.length ||
      b.events.length > 20 ||
      b.events.some((v) => !(outboundEvents as readonly unknown[]).includes(v))
    )
      throw new WorkforceError(400, 'invalid_webhook_events');
    const events = [...new Set(b.events as string[])];
    const includeExternal = boolean(b.includeExternal ?? false);
    const includeContactData = boolean(b.includeContactData ?? false);
    return this.transaction(async (tx, organizationId) => {
      if ((await tx.webhookEndpoint.count({ where: { organizationId } })) >= 20)
        throw new WorkforceError(409, 'endpoint_limit');
      const id = randomUUID();
      const secret = randomBytes(32).toString('hex');
      const context = `${organizationId}:${id}`;
      await tx.webhookEndpoint.create({
        data: {
          id,
          organizationId,
          name,
          host: url.hostname,
          encryptedUrl: seal(url.href, `${context}:url`),
          encryptedSecret: seal(secret, `${context}:secret`),
          events,
          includeExternal,
          includeContactData,
        },
      });
      await audit(tx, organizationId, this.principal.actor, 'webhook.configured', id, {
        host: url.hostname,
        events,
        includeExternal,
        includeContactData,
      });
      return { id, signingSecret: secret };
    });
  }
  async endpoint(id: string, operation: 'test' | 'enable' | 'disable') {
    uuid(id);
    return this.transaction(async (tx, organizationId) => {
      const endpoint = await tx.webhookEndpoint.findFirst({ where: { organizationId, id } });
      if (!endpoint) throw new WorkforceError(404, 'endpoint_not_found');
      if (operation === 'test' && !endpoint.enabled)
        throw new WorkforceError(409, 'endpoint_disabled');
      const result =
        operation === 'test'
          ? await enqueueTest(tx, organizationId, id)
          : await tx.webhookEndpoint.update({
              where: { organizationId_id: { organizationId, id } },
              data: { enabled: operation === 'enable' },
              select: { id: true, enabled: true },
            });
      await audit(tx, organizationId, this.principal.actor, `webhook.${operation}`, id);
      return { id: result.id };
    });
  }
  async retry(id: string) {
    uuid(id);
    return this.transaction(async (tx, organizationId) => {
      const row = await tx.outboundDelivery.findFirst({
        where: { organizationId, id, status: 'dead', endpoint: { enabled: true } },
      });
      if (!row) throw new WorkforceError(409, 'dead_delivery_with_enabled_endpoint_required');
      await tx.outboundDelivery.update({
        where: { organizationId_id: { organizationId, id } },
        data: {
          status: 'pending',
          attemptsAllowed: row.attempts + 8,
          availableAt: new Date(),
          leaseToken: null,
          leasedUntil: null,
        },
      });
      await audit(tx, organizationId, this.principal.actor, 'webhook.retry_requested', id);
      return { queued: true };
    });
  }
}

export async function organizationAdmin(db: Database, authorization?: string) {
  const principal = await authenticate(db, authorization);
  authorize(principal, 'integrations:write');
  return principal;
}
