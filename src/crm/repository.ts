import type { CrmRecord } from '@prisma/client';
import { uuid, WorkforceError, type Transaction } from '../workforce/shared.js';
import { resources, type Resource, type EntityType } from './validation.js';

export type Entity = Record<string, unknown> & {
  id: string;
  organizationId: string;
  record: CrmRecord;
};
interface Delegate {
  findFirst(args: unknown): Promise<Entity | null>;
  findMany(args: unknown): Promise<Entity[]>;
  create(args: unknown): Promise<Entity>;
  update(args: unknown): Promise<Entity>;
}

// The only dynamic Prisma boundary. Delegates are a fixed allowlist; controllers never
// receive them or supply Prisma where/include/data objects. Service inputs are validated.
export class CrmRepository {
  readonly organizationId: string;
  constructor(
    private readonly tx: Transaction,
    organizationId: string,
  ) {
    this.organizationId = uuid(organizationId);
  }
  private delegate(kind: Resource): Delegate {
    const models = {
      contacts: this.tx.contact,
      companies: this.tx.company,
      opportunities: this.tx.opportunity,
      pipelines: this.tx.pipeline,
      stages: this.tx.pipelineStage,
      estimates: this.tx.estimate,
      appointments: this.tx.appointment,
      tasks: this.tx.task,
      notes: this.tx.note,
      conversations: this.tx.conversation,
      messages: this.tx.message,
      tags: this.tx.tag,
    };
    return models[kind] as unknown as Delegate;
  }
  async get(kind: Resource, id: string): Promise<Entity> {
    const row = await this.delegate(kind).findFirst({
      where: { organizationId: this.organizationId, id: uuid(id), record: { archivedAt: null } },
      include: { record: true },
    });
    if (!row) throw new WorkforceError(404, 'record_not_found');
    return row;
  }
  async list(
    kind: Resource,
    query: { after?: string; search?: string; pipelineId?: string; stageId?: string } = {},
  ) {
    const searchField = ['notes', 'messages'].includes(kind)
      ? 'body'
      : kind === 'conversations'
        ? 'subject'
        : ['opportunities', 'estimates', 'appointments', 'tasks'].includes(kind)
          ? 'title'
          : 'name';
    const filter = {
      ...(query.after ? { id: { gt: uuid(query.after) } } : {}),
      ...(query.search ? { [searchField]: { contains: query.search, mode: 'insensitive' } } : {}),
      ...(query.pipelineId && ['stages', 'opportunities'].includes(kind)
        ? { pipelineId: uuid(query.pipelineId) }
        : {}),
      ...(query.stageId && kind === 'opportunities' ? { stageId: uuid(query.stageId) } : {}),
    };
    return this.delegate(kind).findMany({
      where: {
        AND: [filter, { organizationId: this.organizationId, record: { archivedAt: null } }],
      },
      include: { record: true },
      orderBy: { id: 'asc' },
      take: 100,
    });
  }
  async create(kind: Resource, data: Record<string, unknown>): Promise<Entity> {
    return this.delegate(kind).create({
      data: { ...data, organizationId: this.organizationId },
      include: { record: true },
    });
  }
  async update(kind: Resource, id: string, data: Record<string, unknown>): Promise<Entity> {
    await this.get(kind, id);
    return this.delegate(kind).update({
      where: { organizationId_id: { organizationId: this.organizationId, id } },
      data: { ...data, updatedAt: new Date() },
      include: { record: true },
    });
  }
  async reference(id: string, expectedType?: EntityType): Promise<CrmRecord> {
    const record = await this.tx.crmRecord.findFirst({
      where: {
        organizationId: this.organizationId,
        id: uuid(id),
        archivedAt: null,
        ...(expectedType ? { entityType: expectedType } : {}),
      },
    });
    if (!record) throw new WorkforceError(404, 'related_record_not_found');
    return record;
  }
  async archive(kind: Resource, id: string, expectedVersion: number): Promise<void> {
    const row = await this.get(kind, id);
    if (row.record.version !== expectedVersion)
      throw new WorkforceError(409, 'record_version_conflict');
    const result = await this.tx.crmRecord.updateMany({
      where: {
        organizationId: this.organizationId,
        id,
        entityType: resources[kind],
        version: expectedVersion,
        archivedAt: null,
      },
      data: { archivedAt: new Date(), version: { increment: 1 } },
    });
    if (!result.count) throw new WorkforceError(409, 'record_version_conflict');
  }
}
