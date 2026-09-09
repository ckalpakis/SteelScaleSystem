import { CrmRepository } from '../crm/repository.js';
import type { Resource } from '../crm/validation.js';
import { hash, type Transaction, WorkforceError } from '../workforce/shared.js';
import type { Definition } from './contracts.js';

const resources: Record<string, Resource> = {
  contact: 'contacts',
  opportunity: 'opportunities',
  estimate: 'estimates',
  conversation: 'conversations',
  appointment: 'appointments',
  task: 'tasks',
  message: 'messages',
};
export interface ContextRecord {
  id: string;
  type: string;
  version: number;
  data: Record<string, unknown>;
}
export interface RunContext {
  subjectId: string;
  records: ContextRecord[];
  suppressed: boolean;
  fingerprint: string;
  knowledgeRevision?: number;
}
/** Bounded relationship graph, never an organization-wide search. No credentials, arbitrary
 * custom fields or external payloads. Stored context is exactly the projection sent to the model. */
export async function loadContext(
  tx: Transaction,
  organizationId: string,
  subjectId: string,
  config: Definition,
): Promise<RunContext> {
  const repo = new CrmRepository(tx, organizationId);
  const queue = [subjectId];
  const records: ContextRecord[] = [];
  let suppressed = false;
  while (queue.length && records.length < 12) {
    const id = queue.shift()!;
    if (records.some((r) => r.id === id)) continue;
    const ref = await repo.reference(id);
    const resource = resources[ref.entityType];
    if (!resource) throw new WorkforceError(400, 'unsupported_agent_subject');
    const row = await repo.get(resource, id);
    if (row.doNotContact === true) suppressed = true;
    const allowed = [
      'name',
      'title',
      'status',
      'currency',
      'amountMinor',
      'lastActivityAt',
      'customerId',
      'contactId',
      'opportunityId',
      'conversationId',
      'pipelineId',
      'stageId',
      'channel',
      'startsAt',
      'endsAt',
      'dueAt',
    ];
    if (config.context.includeContactDetails) allowed.push('email', 'phone');
    if (config.context.includeMessageContent && ref.entityType === 'message') allowed.push('body');
    const data = Object.fromEntries(
      allowed
        .filter((k) => row[k] !== undefined)
        .map((k) => [
          k,
          typeof row[k] === 'string' ? row[k].slice(0, k === 'body' ? 1000 : 250) : row[k],
        ]),
    );
    records.push({ id, type: ref.entityType, version: ref.version, data });
    if (id === subjectId && ref.entityType === 'contact') {
      const [opportunities, conversations] = await Promise.all([
        tx.opportunity.findMany({
          where: { organizationId, customerId: id, record: { archivedAt: null } },
          orderBy: { lastActivityAt: 'desc' },
          take: 3,
          select: { id: true },
        }),
        tx.conversation.findMany({
          where: { organizationId, contactId: id, record: { archivedAt: null } },
          orderBy: { updatedAt: 'desc' },
          take: 2,
          select: { id: true },
        }),
      ]);
      queue.push(...opportunities.map((r) => r.id), ...conversations.map((r) => r.id));
    }
    if (ref.entityType === 'opportunity') {
      data.stages = await tx.pipelineStage.findMany({
        where: { organizationId, pipelineId: String(row.pipelineId), record: { archivedAt: null } },
        orderBy: { position: 'asc' },
        take: 100,
        select: { id: true, name: true, outcome: true, record: { select: { version: true } } },
      });
      const estimates = await tx.estimate.findMany({
        where: { organizationId, opportunityId: id, record: { archivedAt: null } },
        orderBy: { createdAt: 'desc' },
        take: 2,
        select: { id: true },
      });
      queue.push(...estimates.map((r) => r.id));
    }
    for (const k of ['customerId', 'contactId', 'opportunityId', 'conversationId'])
      if (typeof row[k] === 'string') queue.push(row[k]);
    if (ref.entityType === 'conversation' && config.context.includeMessageContent) {
      const messages = await tx.message.findMany({
        where: {
          organizationId,
          conversationId: id,
          direction: 'inbound',
          record: { archivedAt: null },
        },
        orderBy: { occurredAt: 'desc' },
        take: 3,
        select: { id: true },
      });
      queue.push(...messages.map((m) => m.id));
    }
  }
  const safe = JSON.parse(JSON.stringify(records)) as ContextRecord[];
  if (process.env.BUSINESS_KNOWLEDGE_ENABLED === 'true') {
    const organization = await tx.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { knowledgeRevision: true },
    });
    return {
      subjectId,
      records: safe,
      suppressed,
      knowledgeRevision: organization.knowledgeRevision,
      fingerprint: hash({
        records: safe,
        suppressed,
        knowledgeRevision: organization.knowledgeRevision,
      }),
    };
  }
  return { subjectId, records: safe, suppressed, fingerprint: hash({ records: safe, suppressed }) };
}
export function eligible(config: Definition, context: RunContext, now: Date): boolean {
  const root = context.records.find((r) => r.id === context.subjectId);
  if (!root || !config.eligibility.entityTypes.some((t) => t === root.type)) return false;
  if (
    config.eligibility.statuses.length &&
    !config.eligibility.statuses.includes(String(root.data.status))
  )
    return false;
  if (config.eligibility.staleAfterDays) {
    const activity = Date.parse(String(root.data.lastActivityAt));
    if (
      !Number.isFinite(activity) ||
      activity > now.getTime() - config.eligibility.staleAfterDays * 86400000
    )
      return false;
  }
  return true;
}
