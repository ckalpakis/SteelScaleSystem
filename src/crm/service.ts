import { randomUUID } from 'node:crypto';
import { authorize, type Principal } from '../workforce/tenancy/service.js';
import {
  integer,
  object,
  keys,
  string,
  uuid,
  boolean,
  currency,
  tenantTransaction,
  WorkforceError,
  type Database,
  type Transaction,
} from '../workforce/shared.js';
import { CrmRepository, type Entity } from './repository.js';
import { recordChange, type ChangeContext } from './events.js';
import { applyCustomFields } from './custom-fields.js';
import {
  entityType,
  parseEntity,
  parseField,
  resources,
  timezone,
  type Resource,
  type EntityInput,
} from './validation.js';

const adminResources: Resource[] = ['pipelines', 'stages', 'tags'];
const references: Record<string, Resource | undefined> = {
  customerId: 'contacts',
  contactId: 'contacts',
  companyId: 'companies',
  pipelineId: 'pipelines',
  stageId: 'stages',
  opportunityId: 'opportunities',
  conversationId: 'conversations',
  relatedRecordId: undefined,
};

export class CrmService {
  constructor(
    private readonly database: Database,
    private readonly principal: Principal,
  ) {}
  private permission(write = false, admin = false): void {
    authorize(this.principal, write ? 'crm:write' : 'crm:read');
    if (admin && !['owner', 'admin'].includes(this.principal.role ?? ''))
      throw new WorkforceError(403, 'admin_required');
  }
  private transaction<T>(
    operation: (tx: Transaction, repo: CrmRepository) => Promise<T>,
  ): Promise<T> {
    return tenantTransaction(this.database, this.principal.organizationId, async (tx) => {
      // Recheck after acquiring the tenant lock: a queued request must not use
      // a membership/credential that was revoked while it waited.
      if (this.principal.credentialId !== 'platform-operator') {
        const credential = await tx.workforceCredential.findFirst({
          where: {
            id: this.principal.credentialId,
            organizationId: this.principal.organizationId,
          },
          include: { membership: true },
        });
        if (
          !credential ||
          credential.revokedAt ||
          credential.expiresAt <= new Date() ||
          !credential.membership?.active ||
          credential.membership.role !== this.principal.role ||
          !this.principal.scopes.every((scope) => credential.scopes.includes(scope))
        )
          throw new WorkforceError(401, 'credential_changed');
      }
      return operation(tx, new CrmRepository(tx, this.principal.organizationId));
    });
  }
  async list(
    kind: Resource,
    query: { after?: string; search?: string; pipelineId?: string; stageId?: string } = {},
  ) {
    this.permission();
    if (query.search !== undefined) query = { ...query, search: string(query.search, 100) };
    return this.transaction((_tx, repo) => repo.list(kind, query));
  }
  async detail(kind: Resource, id: string) {
    this.permission();
    uuid(id);
    return this.transaction(async (tx, repo) => {
      const entity = await repo.get(kind, id);
      const organizationId = repo.organizationId;
      const [customFields, tags, activity, opportunities] = await Promise.all([
        tx.customFieldValue.findMany({
          where: { organizationId, recordId: id },
          include: { definition: true },
        }),
        tx.recordTag.findMany({
          where: { organizationId, recordId: id, tag: { record: { archivedAt: null } } },
          include: { tag: true },
        }),
        tx.businessEvent.findMany({
          where: { organizationId, links: { some: { organizationId, recordId: id } } },
          orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
          take: 100,
        }),
        kind === 'contacts'
          ? tx.opportunity.findMany({
              where: { organizationId, customerId: id, record: { archivedAt: null } },
              include: { record: true },
              take: 100,
              orderBy: { id: 'asc' },
            })
          : Promise.resolve([]),
      ]);
      return { entity, customFields, tags, activity, opportunities };
    });
  }
  async create(kind: Resource, value: unknown) {
    this.permission(true, adminResources.includes(kind));
    const input = parseEntity(kind, value);
    return this.transaction((tx, repo) => this.createRecord(tx, repo, kind, input, value));
  }
  private async createRecord(
    tx: Transaction,
    repo: CrmRepository,
    kind: Resource,
    input: EntityInput,
    value: unknown,
    context: ChangeContext = {},
  ) {
    await this.validateRelations(tx, repo, kind, input.data);
    if (
      kind === 'stages' &&
      (await tx.pipelineStage.count({
        where: {
          organizationId: repo.organizationId,
          pipelineId: input.data.pipelineId as string,
        },
      })) >= 100
    )
      throw new WorkforceError(409, 'stage_limit');
    if (kind === 'opportunities')
      input.data.lastActivityAt ??= new Date(context.occurredAt ?? Date.now());
    const row = await repo.create(kind, input.data);
    await this.metadata(tx, repo, kind, row.id, input, true);
    await recordChange(
      tx,
      repo.organizationId,
      this.principal.actor,
      `${resources[kind]}.created`,
      row.id,
      value,
      this.relatedIds(input.data),
      context,
    );
    return repo.get(kind, row.id);
  }
  async update(kind: Resource, id: string, value: unknown) {
    this.permission(true, adminResources.includes(kind));
    uuid(id);
    const input = parseEntity(kind, value, true);
    return this.transaction((tx, repo) => this.updateRecord(tx, repo, kind, id, input, value));
  }
  private async updateRecord(
    tx: Transaction,
    repo: CrmRepository,
    kind: Resource,
    id: string,
    input: EntityInput,
    value: unknown,
    context: ChangeContext = {},
  ) {
    const current = await repo.get(kind, id);
    if (current.record.version !== input.expectedVersion)
      throw new WorkforceError(409, 'record_version_conflict');
    if (kind === 'contacts' && current.doNotContact === true && input.data.doNotContact === false)
      throw new WorkforceError(409, 'consent_workflow_required');
    if (kind === 'messages' && current.status !== 'draft')
      throw new WorkforceError(409, 'message_is_immutable');
    if (
      kind === 'opportunities' &&
      ((input.data.currency && input.data.currency !== current.currency) ||
        (input.data.customerId && input.data.customerId !== current.customerId))
    )
      throw new WorkforceError(409, 'opportunity_identity_immutable');
    if (
      kind === 'stages' &&
      input.data.outcome !== undefined &&
      input.data.outcome !== current.outcome &&
      (await tx.opportunity.count({
        where: { organizationId: repo.organizationId, stageId: id },
      }))
    )
      throw new WorkforceError(409, 'stage_outcome_in_use');
    const merged = { ...current, ...input.data };
    await this.validateRelations(tx, repo, kind, merged);
    if (kind === 'opportunities') {
      input.data.status = merged.status;
      input.data.lastActivityAt =
        input.data.lastActivityAt ?? new Date(context.occurredAt ?? Date.now());
      input.data.sourceOccurredAt = new Date(context.occurredAt ?? Date.now());
    }
    if (kind === 'contacts')
      input.data.sourceOccurredAt = new Date(context.occurredAt ?? Date.now());
    if (kind === 'tasks')
      input.data.completedAt =
        merged.status === 'completed' ? (current.completedAt ?? new Date()) : null;
    if (kind === 'estimates') {
      input.data.acceptedAt = merged.acceptedAt;
      input.data.issuedAt = merged.issuedAt;
    }
    await repo.update(kind, id, input.data);
    await this.metadata(tx, repo, kind, id, input, false);
    await recordChange(
      tx,
      repo.organizationId,
      this.principal.actor,
      `${resources[kind]}.updated`,
      id,
      value,
      this.relatedIds(merged),
      { ...context, before: current },
    );
    return repo.get(kind, id);
  }
  /** Trusted adapter entry point: authorization and tenant lock are mandatory; uses native rules. */
  async applyAgentMutation(
    tx: Transaction,
    kind: 'tasks' | 'notes' | 'opportunities',
    id: string | undefined,
    value: unknown,
    context: ChangeContext,
  ) {
    if (
      this.principal.credentialId !== 'agent-runtime' ||
      !this.principal.actor.startsWith('agent:') ||
      context.source?.organizationId !== this.principal.organizationId
    )
      throw new WorkforceError(403, 'agent_scope_mismatch');
    const repo = new CrmRepository(tx, this.principal.organizationId);
    if (id)
      return this.updateRecord(tx, repo, kind, id, parseEntity(kind, value, true), value, context);
    return this.createRecord(tx, repo, kind, parseEntity(kind, value), value, context);
  }
  /** Trusted adapter entry point: authorization and tenant lock are mandatory; uses native rules. */
  async projectExternal(
    tx: Transaction,
    kind: Resource,
    id: string | undefined,
    value: unknown,
    context: ChangeContext,
  ) {
    authorize(this.principal, 'events:write');
    if (
      !this.principal.integrationId ||
      this.principal.integrationId !== context.source?.connectionId ||
      this.principal.organizationId !== context.source.organizationId ||
      ![
        'contacts',
        'opportunities',
        'estimates',
        'appointments',
        'tasks',
        'messages',
        'pipelines',
        'stages',
        'conversations',
      ].includes(kind)
    )
      throw new WorkforceError(403, 'integration_scope_mismatch');
    const repo = new CrmRepository(tx, this.principal.organizationId);
    if (!id) return this.createRecord(tx, repo, kind, parseEntity(kind, value), value, context);
    const current = await repo.get(kind, id);
    const body = { ...object(value), expectedVersion: current.record.version };
    return this.updateRecord(tx, repo, kind, id, parseEntity(kind, body, true), body, context);
  }
  async archive(kind: Resource, id: string, expectedVersion: number) {
    this.permission(true, adminResources.includes(kind));
    uuid(id);
    integer(expectedVersion, 1, 2_147_483_646);
    return this.transaction(async (tx, repo) => {
      const current = await repo.get(kind, id);
      const active = { organizationId: repo.organizationId, record: { archivedAt: null } };
      let children = 0;
      if (kind === 'pipelines')
        children = await tx.pipelineStage.count({ where: { ...active, pipelineId: id } });
      if (kind === 'stages')
        children = await tx.opportunity.count({ where: { ...active, stageId: id } });
      if (kind === 'contacts')
        children =
          (await tx.opportunity.count({ where: { ...active, customerId: id } })) +
          (await tx.appointment.count({ where: { ...active, contactId: id } })) +
          (await tx.conversation.count({ where: { ...active, contactId: id } }));
      if (kind === 'companies')
        children =
          (await tx.contact.count({ where: { ...active, companyId: id } })) +
          (await tx.opportunity.count({ where: { ...active, companyId: id } }));
      if (kind === 'opportunities')
        children =
          (await tx.estimate.count({ where: { ...active, opportunityId: id } })) +
          (await tx.appointment.count({ where: { ...active, opportunityId: id } }));
      if (children) throw new WorkforceError(409, 'record_has_active_dependents');
      if (kind === 'messages' && current.status !== 'draft')
        throw new WorkforceError(409, 'message_is_immutable');
      await repo.archive(kind, id, expectedVersion);
      await recordChange(
        tx,
        repo.organizationId,
        this.principal.actor,
        `${resources[kind]}.archived`,
        id,
        {},
        this.relatedIds(current),
      );
    });
  }
  private relatedIds(data: Record<string, unknown>): string[] {
    return Object.keys(references).flatMap((key) =>
      typeof data[key] === 'string' ? [data[key]] : [],
    );
  }
  private async validateRelations(
    tx: Transaction,
    repo: CrmRepository,
    kind: Resource,
    data: Record<string, unknown>,
  ) {
    for (const [key, resource] of Object.entries(references)) {
      if (data[key])
        await repo.reference(data[key] as string, resource ? resources[resource] : undefined);
    }
    if (kind === 'opportunities') {
      const stage = await repo.get('stages', data.stageId as string);
      if (stage.pipelineId !== data.pipelineId)
        throw new WorkforceError(409, 'stage_pipeline_mismatch');
      data.status = stage.outcome;
    }
    if (kind === 'estimates') {
      const opportunity = await repo.get('opportunities', data.opportunityId as string);
      if (opportunity.currency !== data.currency)
        throw new WorkforceError(409, 'estimate_currency_mismatch');
      if (data.status === 'accepted') data.acceptedAt ??= new Date();
      else if (data.acceptedAt)
        throw new WorkforceError(400, 'accepted_date_requires_accepted_status');
      if (['sent', 'accepted'].includes(data.status as string)) data.issuedAt ??= new Date();
      if (data.issuedAt && data.expiresAt && (data.expiresAt as Date) <= (data.issuedAt as Date))
        throw new WorkforceError(400, 'estimate_date_order');
    }
    if (kind === 'tasks') data.completedAt = data.status === 'completed' ? new Date() : null;
    if (kind === 'appointments') {
      if ((data.endsAt as Date) <= (data.startsAt as Date))
        throw new WorkforceError(400, 'appointment_date_order');
      if (data.opportunityId) {
        const opportunity = await repo.get('opportunities', data.opportunityId as string);
        if (opportunity.customerId !== data.contactId)
          throw new WorkforceError(409, 'appointment_contact_mismatch');
      }
    }
    if (kind === 'messages' && data.status !== 'draft' && (data.occurredAt as Date) > new Date())
      throw new WorkforceError(400, 'message_in_future');
    if (kind === 'stages') {
      const stageExists = await tx.pipelineStage.findFirst({
        where: {
          organizationId: repo.organizationId,
          pipelineId: data.pipelineId as string,
          position: data.position as number,
          ...(data.id ? { id: { not: data.id as string } } : {}),
        },
      });
      if (stageExists) throw new WorkforceError(409, 'stage_position_in_use');
    }
  }
  private async metadata(
    tx: Transaction,
    repo: CrmRepository,
    kind: Resource,
    id: string,
    input: EntityInput,
    creating: boolean,
  ) {
    if (input.assignedMemberId) {
      const member = await tx.organizationMember.findFirst({
        where: { organizationId: repo.organizationId, id: input.assignedMemberId, active: true },
      });
      if (!member) throw new WorkforceError(404, 'assignee_not_found');
    }
    if (input.assignedMemberId !== undefined)
      await tx.crmRecord.update({
        where: { organizationId_id: { organizationId: repo.organizationId, id } },
        data: { assignedMemberId: input.assignedMemberId },
      });
    if (input.tagIds) {
      for (const tagId of input.tagIds) await repo.reference(tagId, 'tag');
      await tx.recordTag.deleteMany({
        where: { organizationId: repo.organizationId, recordId: id },
      });
      if (input.tagIds.length)
        await tx.recordTag.createMany({
          data: input.tagIds.map((tagId) => ({
            organizationId: repo.organizationId,
            recordId: id,
            tagId,
          })),
        });
    }
    await applyCustomFields(
      tx,
      repo.organizationId,
      id,
      resources[kind],
      input.customFields,
      creating,
    );
  }
  async reorderStages(pipelineId: string, value: unknown) {
    this.permission(true, true);
    uuid(pipelineId);
    const body = object(value);
    keys(body, ['stageIds', 'expectedVersion']);
    const version = integer(body.expectedVersion, 1, 2_147_483_646);
    if (!Array.isArray(body.stageIds) || body.stageIds.length > 100)
      throw new WorkforceError(400, 'invalid_stage_order');
    const ids = body.stageIds.map(uuid);
    if (new Set(ids).size !== ids.length) throw new WorkforceError(400, 'duplicate_stage');
    return this.transaction(async (tx, repo) => {
      const pipeline = await repo.get('pipelines', pipelineId);
      if (pipeline.record.version !== version)
        throw new WorkforceError(409, 'record_version_conflict');
      const stages = await tx.pipelineStage.findMany({
        where: { organizationId: repo.organizationId, pipelineId },
        include: { record: true },
        orderBy: { position: 'asc' },
      });
      const active = stages.filter((stage) => !stage.record.archivedAt);
      if (ids.length !== active.length || active.some((stage) => !ids.includes(stage.id)))
        throw new WorkforceError(409, 'stage_order_must_include_all_active_stages');
      for (let i = 0; i < stages.length; i++)
        await tx.pipelineStage.update({
          where: { organizationId_id: { organizationId: repo.organizationId, id: stages[i]!.id } },
          data: { position: 2_000_000 + i },
        });
      const order = [
        ...ids,
        ...stages.filter((stage) => stage.record.archivedAt).map((stage) => stage.id),
      ];
      for (let i = 0; i < order.length; i++)
        await tx.pipelineStage.update({
          where: { organizationId_id: { organizationId: repo.organizationId, id: order[i]! } },
          data: { position: i },
        });
      await tx.crmRecord.update({
        where: { organizationId_id: { organizationId: repo.organizationId, id: pipelineId } },
        data: { version: { increment: 1 } },
      });
      await recordChange(
        tx,
        repo.organizationId,
        this.principal.actor,
        'pipeline.reordered',
        pipelineId,
        { stageIds: ids },
      );
      return repo.list('stages', { pipelineId });
    });
  }
  async fields() {
    this.permission();
    return this.transaction((tx, repo) =>
      tx.customFieldDefinition.findMany({
        where: { organizationId: repo.organizationId, archivedAt: null },
        orderBy: { key: 'asc' },
        take: 1000,
      }),
    );
  }
  async createField(value: unknown) {
    this.permission(true, true);
    const input = parseField(value);
    return this.transaction(async (tx, repo) => {
      if (
        (await tx.customFieldDefinition.count({
          where: {
            organizationId: repo.organizationId,
            entityType: input.entityType,
            archivedAt: null,
          },
        })) >= 100
      )
        throw new WorkforceError(409, 'custom_field_limit');
      const field = await tx.customFieldDefinition.create({
        data: { organizationId: repo.organizationId, ...input },
      });
      await recordChange(
        tx,
        repo.organizationId,
        this.principal.actor,
        'custom_field.defined',
        field.id,
        input,
      );
      return field;
    });
  }
  async updateField(id: string, value: unknown) {
    this.permission(true, true);
    uuid(id);
    const body = object(value);
    keys(body, ['label', 'archived']);
    const label = body.label === undefined ? undefined : string(body.label);
    const archived = body.archived === undefined ? undefined : boolean(body.archived);
    return this.transaction(async (tx, repo) => {
      const field = await tx.customFieldDefinition.findFirst({
        where: { organizationId: repo.organizationId, id },
      });
      if (!field) throw new WorkforceError(404, 'custom_field_not_found');
      const result = await tx.customFieldDefinition.update({
        where: { id, organizationId: repo.organizationId },
        data: {
          label,
          archivedAt: archived === undefined ? undefined : archived ? new Date() : null,
        },
      });
      await recordChange(
        tx,
        repo.organizationId,
        this.principal.actor,
        'custom_field.updated',
        id,
        body,
      );
      return result;
    });
  }
  async connections() {
    this.permission(false, true);
    return this.transaction((tx, repo) =>
      tx.externalConnection.findMany({
        where: { organizationId: repo.organizationId },
        orderBy: { id: 'asc' },
        take: 100,
      }),
    );
  }
  async createConnection(value: unknown) {
    this.permission(true, true);
    const body = object(value);
    keys(body, ['name', 'provider']);
    const provider = string(body.provider, 80).toLowerCase();
    if (!/^[a-z][a-z0-9_-]*$/.test(provider)) throw new WorkforceError(400, 'invalid_provider');
    const name = string(body.name);
    return this.transaction(async (tx, repo) => {
      const connection = await tx.externalConnection.create({
        data: { organizationId: repo.organizationId, provider, name },
      });
      await recordChange(
        tx,
        repo.organizationId,
        this.principal.actor,
        'connection.created',
        connection.id,
        { provider, name },
      );
      return connection;
    });
  }
  async updateConnection(id: string, value: unknown) {
    this.permission(true, true);
    uuid(id);
    const body = object(value);
    keys(body, ['name', 'enabled']);
    const data = {
      name: body.name === undefined ? undefined : string(body.name),
      enabled: body.enabled === undefined ? undefined : boolean(body.enabled),
    };
    return this.transaction(async (tx, repo) => {
      if (
        !(await tx.externalConnection.findFirst({
          where: { organizationId: repo.organizationId, id },
        }))
      )
        throw new WorkforceError(404, 'connection_not_found');
      const result = await tx.externalConnection.update({
        where: { organizationId_id: { organizationId: repo.organizationId, id } },
        data,
      });
      await recordChange(
        tx,
        repo.organizationId,
        this.principal.actor,
        'connection.updated',
        id,
        body,
      );
      return result;
    });
  }
  async mappings(after?: string) {
    this.permission(false, true);
    if (after) uuid(after);
    return this.transaction((tx, repo) =>
      tx.externalRecordMapping.findMany({
        where: { organizationId: repo.organizationId, ...(after ? { id: { gt: after } } : {}) },
        orderBy: { id: 'asc' },
        take: 100,
      }),
    );
  }
  async mapExternal(value: unknown) {
    this.permission(true, true);
    const body = object(value);
    keys(body, [
      'connectionId',
      'externalRecordType',
      'externalId',
      'internalEntityType',
      'internalEntityId',
    ]);
    const input = {
      connectionId: uuid(body.connectionId),
      externalRecordType: string(body.externalRecordType, 100),
      externalId: string(body.externalId, 250),
      internalEntityType: entityType(body.internalEntityType),
      internalEntityId: uuid(body.internalEntityId),
    };
    return this.transaction(async (tx, repo) => {
      const connection = await tx.externalConnection.findUnique({
        where: {
          organizationId_id: { organizationId: repo.organizationId, id: input.connectionId },
        },
      });
      if (!connection?.enabled) throw new WorkforceError(404, 'connection_not_found');
      await repo.reference(input.internalEntityId, input.internalEntityType);
      const identity = {
        organizationId: repo.organizationId,
        connectionId: input.connectionId,
        externalRecordType: input.externalRecordType,
        externalId: input.externalId,
      };
      const existing = await tx.externalRecordMapping.findUnique({
        where: { organizationId_connectionId_externalRecordType_externalId: identity },
      });
      if (existing) {
        if (
          existing.internalEntityId !== input.internalEntityId ||
          existing.internalEntityType !== input.internalEntityType
        )
          throw new WorkforceError(409, 'external_mapping_conflict');
        return existing;
      }
      const mapping = await tx.externalRecordMapping.create({
        data: { organizationId: repo.organizationId, provider: connection.provider, ...input },
      });
      await recordChange(
        tx,
        repo.organizationId,
        this.principal.actor,
        'external_record.mapped',
        input.internalEntityId,
        { mappingId: mapping.id, provider: connection.provider },
      );
      return mapping;
    });
  }
  async unmapExternal(id: string) {
    this.permission(true, true);
    uuid(id);
    return this.transaction(async (tx, repo) => {
      const mapping = await tx.externalRecordMapping.findFirst({
        where: { organizationId: repo.organizationId, id },
      });
      if (!mapping) throw new WorkforceError(404, 'mapping_not_found');
      await tx.externalRecordMapping.deleteMany({
        where: { organizationId: repo.organizationId, id },
      });
      await recordChange(
        tx,
        repo.organizationId,
        this.principal.actor,
        'external_record.unmapped',
        mapping.internalEntityId,
        { mappingId: id },
      );
    });
  }
  async members() {
    this.permission();
    return this.transaction((tx, repo) =>
      tx.organizationMember.findMany({
        where: { organizationId: repo.organizationId },
        include: { user: true },
        take: 100,
        orderBy: { id: 'asc' },
      }),
    );
  }
  async addMember(value: unknown) {
    this.permission(true, true);
    const body = object(value);
    keys(body, ['name', 'email', 'role']);
    const name = string(body.name);
    const email = body.email === undefined ? undefined : string(body.email, 254).toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new WorkforceError(400, 'invalid_email');
    const role = body.role ?? 'member';
    if (role !== 'member' && role !== 'viewer')
      throw new WorkforceError(400, 'invalid_member_role');
    return this.transaction(async (tx, repo) => {
      const subject = `crm-employee:${randomUUID()}`;
      const user = await tx.user.create({ data: { externalSubject: subject, name, email } });
      const member = await tx.organizationMember.create({
        data: {
          organizationId: repo.organizationId,
          subject,
          userId: user.id,
          displayName: name,
          role,
        },
      });
      await recordChange(
        tx,
        repo.organizationId,
        this.principal.actor,
        'member.created',
        member.id,
        { role },
      );
      return { ...member, user };
    });
  }
  async updateMember(id: string, value: unknown) {
    this.permission(true, true);
    uuid(id);
    const body = object(value);
    keys(body, ['displayName', 'active', 'role']);
    const displayName = body.displayName === undefined ? undefined : string(body.displayName);
    const active = body.active === undefined ? undefined : boolean(body.active);
    const role = body.role;
    if (
      role !== undefined &&
      role !== 'owner' &&
      role !== 'admin' &&
      role !== 'member' &&
      role !== 'viewer'
    )
      throw new WorkforceError(400, 'invalid_member_role');
    return this.transaction(async (tx, repo) => {
      const member = await tx.organizationMember.findFirst({
        where: { organizationId: repo.organizationId, id },
      });
      if (!member) throw new WorkforceError(404, 'member_not_found');
      if (
        this.principal.role !== 'owner' &&
        (member.role === 'owner' || role === 'owner' || role === 'admin')
      )
        throw new WorkforceError(403, 'owner_required');
      if (
        member.active &&
        member.role === 'owner' &&
        (active === false || (role && role !== 'owner')) &&
        (await tx.organizationMember.count({
          where: { organizationId: repo.organizationId, active: true, role: 'owner' },
        })) <= 1
      )
        throw new WorkforceError(409, 'last_owner_required');
      const updated = await tx.organizationMember.update({
        where: { organizationId_id: { organizationId: repo.organizationId, id } },
        data: { displayName, active, role },
      });
      await recordChange(tx, repo.organizationId, this.principal.actor, 'member.updated', id, body);
      return updated;
    });
  }
  async organization(value?: unknown) {
    this.permission(value !== undefined, value !== undefined);
    const data: { name?: string; timezone?: string; defaultCurrency?: string } = {};
    if (value !== undefined) {
      const body = object(value);
      keys(body, ['name', 'timezone', 'defaultCurrency']);
      if (body.name !== undefined) data.name = string(body.name);
      if (body.timezone !== undefined) data.timezone = timezone(body.timezone);
      if (body.defaultCurrency !== undefined) data.defaultCurrency = currency(body.defaultCurrency);
    }
    return this.transaction(async (tx, repo) => {
      if (value === undefined)
        return tx.organization.findUniqueOrThrow({ where: { id: repo.organizationId } });
      const updated = await tx.organization.update({ where: { id: repo.organizationId }, data });
      await recordChange(
        tx,
        repo.organizationId,
        this.principal.actor,
        'organization.updated',
        repo.organizationId,
        data,
      );
      return updated;
    });
  }
}

export type CrmEntity = Entity;
