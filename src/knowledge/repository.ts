import { WorkforceError, type Transaction } from '../workforce/shared.js';
/** Fixed tenant scope; callers never supply Prisma where/include objects. */
export class KnowledgeRepository {
  constructor(
    readonly tx: Transaction,
    readonly organizationId: string,
  ) {}
  async source(id: string) {
    const row = await this.tx.knowledgeSource.findFirst({
      where: { organizationId: this.organizationId, id },
    });
    if (!row) throw new WorkforceError(404, 'knowledge_source_not_found');
    return row;
  }
  async document(id: string) {
    const row = await this.tx.knowledgeDocument.findFirst({
      where: { organizationId: this.organizationId, id },
    });
    if (!row) throw new WorkforceError(404, 'knowledge_document_not_found');
    return row;
  }
  async entry(id: string) {
    const row = await this.tx.knowledgeEntry.findFirst({
      where: { organizationId: this.organizationId, id },
      include: {
        source: true,
        document: true,
        versions: { orderBy: { number: 'desc' }, take: 50 },
      },
    });
    if (!row) throw new WorkforceError(404, 'knowledge_entry_not_found');
    return row;
  }
  async current(id: string) {
    const row = await this.tx.knowledgeVersion.findFirst({
      where: { organizationId: this.organizationId, id, organization: { active: true } },
      include: { entry: { include: { source: true, document: true } } },
    });
    if (
      !row ||
      !row.entry.active ||
      row.entry.approvedVersionId !== id ||
      row.number !== row.entry.latestVersion ||
      !row.entry.source.active ||
      (row.entry.document && !row.entry.document.active)
    )
      throw new WorkforceError(409, 'knowledge_not_current_or_approved');
    return row;
  }
}
