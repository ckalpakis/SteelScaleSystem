import { authorizeCurrent } from '../agents/service.js';
import { audit } from '../workforce/audit/service.js';
import type { Principal } from '../workforce/tenancy/service.js';
import {
  hash,
  integer,
  json,
  keys,
  object,
  string,
  tenantTransaction,
  uuid,
  WorkforceError,
  type Database,
  type Transaction,
} from '../workforce/shared.js';
import { parseDocument, parseEntry, parseToggle } from './contracts.js';
import { KnowledgeRepository } from './repository.js';
import { retrieve } from './retrieval.js';
export async function knowledgeChanged(
  tx: Transaction,
  organizationId: string,
  actor: string,
  type: string,
  id: string,
  metadata: Record<string, unknown> = {},
) {
  await tx.organization.update({
    where: { id: organizationId },
    data: { knowledgeRevision: { increment: 1 } },
  });
  await audit(tx, organizationId, actor, `knowledge.${type}`, id, metadata);
}
export class KnowledgeService {
  constructor(
    readonly database: Database,
    readonly principal: Principal,
  ) {}
  tx<T>(fn: (tx: Transaction, repo: KnowledgeRepository) => Promise<T>, write = false) {
    return tenantTransaction(this.database, this.principal.organizationId, async (tx) => {
      await authorizeCurrent(tx, this.principal, write ? 'agents:write' : 'crm:read');
      return fn(tx, new KnowledgeRepository(tx, this.principal.organizationId));
    });
  }
  overview(after?: string) {
    if (after) uuid(after);
    return this.tx(async (tx, r) => ({
      sources: await tx.knowledgeSource.findMany({
        where: { organizationId: r.organizationId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      documents: await tx.knowledgeDocument.findMany({
        where: { organizationId: r.organizationId },
        select: {
          id: true,
          sourceId: true,
          filename: true,
          contentHash: true,
          active: true,
          revision: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      entries: await tx.knowledgeEntry.findMany({
        where: { organizationId: r.organizationId, ...(after ? { id: { gt: after } } : {}) },
        include: { source: true, versions: { orderBy: { number: 'desc' }, take: 1 } },
        orderBy: { id: 'asc' },
        take: 50,
      }),
    }));
  }
  source(raw: unknown) {
    const v = object(raw);
    keys(v, ['name', 'reference']);
    const name = string(v.name, 160),
      reference = v.reference == null || v.reference === '' ? null : string(v.reference, 500);
    if (reference && !/^https:\/\//i.test(reference))
      throw new WorkforceError(400, 'knowledge_reference_must_be_https');
    if (reference) {
      let u: URL;
      try {
        u = new URL(reference);
      } catch {
        throw new WorkforceError(400, 'invalid_knowledge_reference');
      }
      if (u.username || u.password) throw new WorkforceError(400, 'credential_in_reference');
    }
    return this.tx(async (tx, r) => {
      if ((await tx.knowledgeSource.count({ where: { organizationId: r.organizationId } })) >= 100)
        throw new WorkforceError(409, 'knowledge_source_limit');
      const row = await tx.knowledgeSource.create({
        data: { organizationId: r.organizationId, name, reference },
      });
      await knowledgeChanged(tx, r.organizationId, this.principal.actor, 'source_created', row.id);
      return row;
    }, true);
  }
  document(raw: unknown) {
    const input = parseDocument(raw);
    return this.tx(async (tx, r) => {
      await r.source(input.sourceId);
      const contentHash = hash(input.content);
      const prior = await tx.knowledgeDocument.findUnique({
        where: {
          organizationId_sourceId_contentHash: {
            organizationId: r.organizationId,
            sourceId: input.sourceId,
            contentHash,
          },
        },
      });
      if (prior) return prior;
      if (
        (await tx.knowledgeDocument.count({ where: { organizationId: r.organizationId } })) >= 500
      )
        throw new WorkforceError(409, 'knowledge_document_limit');
      const row = await tx.knowledgeDocument.create({
        data: {
          ...input,
          organizationId: r.organizationId,
          contentHash,
          createdBy: this.principal.actor,
        },
      });
      await knowledgeChanged(tx, r.organizationId, this.principal.actor, 'document_added', row.id, {
        contentHash,
        bytes: Buffer.byteLength(input.content),
      });
      return row;
    }, true);
  }
  detail(id: string) {
    uuid(id);
    return this.tx((_tx, r) => r.entry(id));
  }
  documentDetail(id: string) {
    uuid(id);
    return this.tx((_tx, r) => r.document(id));
  }
  save(raw: unknown, id?: string) {
    if (id) uuid(id);
    const v = parseEntry(raw, !!id);
    return this.tx(async (tx, r) => {
      await r.source(v.sourceId);
      if (v.documentId) {
        const d = await r.document(v.documentId);
        if (d.sourceId !== v.sourceId || !d.content.includes(v.content))
          throw new WorkforceError(400, 'document_excerpt_must_match');
        // A raw document cannot silently become a second source of inferred structured facts.
        if (Object.keys(v.facts).length)
          throw new WorkforceError(400, 'document_entry_requires_exact_excerpt');
      }
      const previous = id ? await r.entry(id) : null;
      if (previous && previous.revision !== v.expectedRevision)
        throw new WorkforceError(409, 'knowledge_revision_conflict');
      if (
        previous &&
        (previous.sourceId !== v.sourceId ||
          previous.documentId !== v.documentId ||
          previous.category !== v.category ||
          previous.audience !== v.audience)
      )
        throw new WorkforceError(400, 'knowledge_provenance_immutable');
      if (
        !previous &&
        (await tx.knowledgeEntry.count({ where: { organizationId: r.organizationId } })) >= 5000
      )
        throw new WorkforceError(409, 'knowledge_entry_limit');
      const entry = previous
        ? await tx.knowledgeEntry.update({
            where: { organizationId_id: { organizationId: r.organizationId, id: previous.id } },
            data: {
              revision: { increment: 1 },
              latestVersion: { increment: 1 },
              active: false,
              approvedVersionId: null,
              approvedBy: null,
              approvedAt: null,
            },
          })
        : await tx.knowledgeEntry.create({
            data: {
              organizationId: r.organizationId,
              sourceId: v.sourceId,
              documentId: v.documentId,
              category: v.category,
              audience: v.audience,
            },
          });
      const version = await tx.knowledgeVersion.create({
        data: {
          organizationId: r.organizationId,
          entryId: entry.id,
          number: entry.latestVersion,
          title: v.title,
          question: v.question,
          content: v.content,
          facts: json(v.facts),
          risk: v.risk,
          createdBy: this.principal.actor,
        },
      });
      await knowledgeChanged(tx, r.organizationId, this.principal.actor, 'draft_saved', entry.id, {
        versionId: version.id,
        contentHash: hash(v.content),
      });
      return { entry, version };
    }, true);
  }
  approve(id: string, raw: unknown) {
    uuid(id);
    const v = object(raw);
    keys(v, ['expectedRevision', 'versionId', 'reviewed']);
    const revision = integer(v.expectedRevision, 1, 2147483646),
      versionId = uuid(v.versionId);
    if (v.reviewed !== true) throw new WorkforceError(400, 'knowledge_review_required');
    return this.tx(async (tx, r) => {
      const row = await r.entry(id),
        version = row.versions.find((x) => x.id === versionId);
      if (row.revision !== revision || !version || version.number !== row.latestVersion)
        throw new WorkforceError(409, 'knowledge_revision_conflict');
      if (!row.source.active || (row.document && !row.document.active))
        throw new WorkforceError(409, 'knowledge_source_inactive');
      const updated = await tx.knowledgeEntry.update({
        where: { organizationId_id: { organizationId: r.organizationId, id } },
        data: {
          active: true,
          approvedVersionId: versionId,
          approvedBy: this.principal.actor,
          approvedAt: new Date(),
          revision: { increment: 1 },
        },
      });
      await knowledgeChanged(tx, r.organizationId, this.principal.actor, 'version_approved', id, {
        versionId,
        risk: version.risk,
        permissionsGranted: false,
      });
      return updated;
    }, true);
  }
  toggle(kind: 'sources' | 'documents' | 'entries', id: string, raw: unknown) {
    uuid(id);
    const v = parseToggle(raw);
    return this.tx(async (tx, r) => {
      const row =
        kind === 'sources'
          ? await r.source(id)
          : kind === 'documents'
            ? await r.document(id)
            : await r.entry(id);
      if (row.revision !== v.expectedRevision)
        throw new WorkforceError(409, 'knowledge_revision_conflict');
      if (
        kind === 'entries' &&
        v.active &&
        (!('approvedVersionId' in row) || !row.approvedVersionId)
      )
        throw new WorkforceError(409, 'knowledge_review_required');
      const where = { organizationId_id: { organizationId: r.organizationId, id } },
        data = { active: v.active, revision: { increment: 1 } };
      const updated =
        kind === 'sources'
          ? await tx.knowledgeSource.update({ where, data })
          : kind === 'documents'
            ? await tx.knowledgeDocument.update({ where, data })
            : await tx.knowledgeEntry.update({ where, data });
      await knowledgeChanged(
        tx,
        r.organizationId,
        this.principal.actor,
        `${kind}_${v.active ? 'activated' : 'deactivated'}`,
        id,
      );
      return updated;
    }, true);
  }
  question(raw: unknown) {
    const v = object(raw);
    keys(v, ['question']);
    return this.tx((tx, r) => retrieve(tx, r.organizationId, v.question));
  }
}
