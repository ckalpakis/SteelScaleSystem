import { string, WorkforceError, type Transaction } from '../workforce/shared.js';
import { KnowledgeRepository } from './repository.js';
const stopWords = new Set(
  'a an the is are do does you your we our to of in for about can what which how me tell please business have offer available'.split(
    ' ',
  ),
);
export function tokens(text: string, limit = 20) {
  return [
    ...new Set(
      text
        .toLowerCase()
        .normalize('NFKC')
        .match(/[\p{L}\p{N}]+/gu) ?? [],
    ),
  ]
    .filter((t) => t.length > 1 && !stopWords.has(t))
    .slice(0, limit);
}
export function claimSupported(content: string, candidate: string) {
  return content.trim() === candidate.trim();
}
export async function currentPublicClaim(
  tx: Transaction,
  organizationId: string,
  versionId: string,
  content: string,
) {
  const row = await new KnowledgeRepository(tx, organizationId).current(versionId);
  if (row.entry.audience !== 'public' || !claimSupported(row.content, content))
    throw new WorkforceError(403, 'unsupported_knowledge_claim');
  // Approval of a fact is not permission for a customer-specific promise.
  if (row.risk !== 'general')
    throw new WorkforceError(403, 'knowledge_requires_action_policy_review');
  return {
    versionId: row.id,
    entryId: row.entryId,
    number: row.number,
    sourceId: row.entry.sourceId,
    source: row.entry.source.name,
    documentId: row.entry.documentId,
    title: row.title,
    content: row.content,
  };
}
export async function retrieve(tx: Transaction, organizationId: string, raw: unknown) {
  const query = string(raw, 500),
    terms = tokens(query);
  const org = await tx.organization.findFirst({
    where: { id: organizationId, active: true },
    select: { knowledgeRevision: true },
  });
  if (!org) throw new WorkforceError(403, 'organization_inactive');
  if (!terms.length)
    return {
      answer: null,
      status: 'unsupported',
      sources: [],
      permissionsGranted: false,
      revision: org.knowledgeRevision,
    };
  // Bounded lexical retrieval; no vector service, URL fetch or vendor-specific schema.
  const rows = await tx.knowledgeEntry.findMany({
    where: {
      organizationId,
      active: true,
      audience: 'public',
      source: { active: true },
      OR: [{ documentId: null }, { document: { active: true } }],
      approvedVersion: {
        OR: terms.flatMap((t) => [
          { title: { contains: t, mode: 'insensitive' as const } },
          { question: { contains: t, mode: 'insensitive' as const } },
          { content: { contains: t, mode: 'insensitive' as const } },
        ]),
      },
    },
    include: {
      approvedVersion: true,
      source: true,
      document: { select: { id: true, filename: true } },
    },
    orderBy: { id: 'asc' },
    take: 101,
  });
  if (rows.length > 100)
    return {
      answer: null,
      status: 'refine_question',
      sources: [],
      permissionsGranted: false,
      revision: org.knowledgeRevision,
    };
  const ranked = rows
    .filter((r) => r.approvedVersion?.number === r.latestVersion)
    .map((r) => {
      const v = r.approvedVersion!,
        hay = new Set(tokens(`${v.title} ${v.question ?? ''} ${v.content}`, 2000));
      return { row: r, score: terms.filter((t) => hay.has(t)).length };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id));
  const exact = ranked.filter(({ row: r }) =>
    [r.approvedVersion!.question, r.approvedVersion!.title].some(
      (q) => q?.trim().toLowerCase() === query.trim().toLowerCase(),
    ),
  );
  const safe = exact.length === 1 && exact[0]!.row.approvedVersion!.risk === 'general';
  const selected = safe
    ? [exact[0]!, ...ranked.filter((r) => r.row.id !== exact[0]!.row.id).slice(0, 4)]
    : ranked.slice(0, 5);
  const sources = selected.map(({ row: r }) => ({
    entryId: r.id,
    versionId: r.approvedVersion!.id,
    version: r.approvedVersion!.number,
    title: r.approvedVersion!.title,
    excerpt: r.approvedVersion!.content,
    facts: r.approvedVersion!.facts,
    category: r.category,
    risk: r.approvedVersion!.risk,
    sourceId: r.sourceId,
    source: r.source.name,
    reference: r.source.reference,
    document: r.document,
    guidance: 'Approved reference only. Does not grant permissions or authorize inferred promises.',
  }));
  // Answer only an explicitly reviewed exact FAQ/title question, never synthesize a claim.
  return {
    answer: safe ? exact[0]!.row.approvedVersion!.content : null,
    status: safe ? 'approved_exact_answer' : sources.length ? 'reference_only' : 'unsupported',
    sources,
    permissionsGranted: false,
    revision: org.knowledgeRevision,
  };
}
