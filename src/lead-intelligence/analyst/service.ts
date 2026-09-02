import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import type { DashboardProspect } from '../admin-dashboard.js';
import type { LeadAnalystEntry, LeadAnalystInput, LeadAnalystReport } from './types.js';

const MAX_CANDIDATES = 25;
const MAX_RESULTS = 10;

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    rankings: {
      type: 'array',
      maxItems: MAX_RESULTS,
      items: {
        type: 'object',
        properties: {
          leadId: { type: 'string' },
          fitSummary: { type: 'string' },
          salesAngle: { type: 'string' },
          notes: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 5 },
          risks: { type: 'array', items: { type: 'string' }, maxItems: 3 },
        },
        required: ['leadId', 'fitSummary', 'salesAngle', 'notes', 'risks'],
        additionalProperties: false,
      },
    },
  },
  required: ['rankings'],
  additionalProperties: false,
} as const;

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function outputText(response: Record<string, unknown>): string | undefined {
  if (typeof response.output_text === 'string') return response.output_text;
  if (!Array.isArray(response.output)) return undefined;
  for (const item of response.output) {
    const message = objectValue(item);
    if (!message || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const content = objectValue(part);
      if (content?.type === 'output_text' && typeof content.text === 'string') return content.text;
    }
  }
  return undefined;
}

export function prepareLeadAnalystInputs(rows: DashboardProspect[]): LeadAnalystInput[] {
  return [...rows]
    .filter((row) => row.score !== null && row.primaryOffer !== null)
    .sort(
      (left, right) =>
        (right.score ?? -1) - (left.score ?? -1) ||
        right.confidence - left.confidence ||
        right.lastSeenAt.getTime() - left.lastSeenAt.getTime(),
    )
    .slice(0, MAX_CANDIDATES)
    .map((row) => ({
      leadId: row.leadId,
      name: row.name,
      location: row.location,
      niche: row.niche,
      primaryOffer: row.primaryOffer,
      score: row.score,
      scoreBand: row.scoreBand,
      confidence: row.confidence,
      reasons: row.reasons.slice(0, 8),
      reviewCount: row.reviewCount,
      rating: row.rating,
      activeListings: row.activeListings,
      phoneAvailable: Boolean(row.phone),
      websiteAvailable: Boolean(row.website),
      lastSeenAt: row.lastSeenAt.toISOString(),
      lastEnrichedAt: row.lastEnrichedAt?.toISOString() ?? null,
      outreachStatus: row.outreachStatus,
      scoreComponents: row.scoreComponents.map(({ rule, label, points }) => ({
        rule,
        label,
        points,
      })),
    }));
}

function parseReport(value: unknown, candidates: LeadAnalystInput[]): LeadAnalystEntry[] {
  const report = objectValue(value);
  if (!report || !Array.isArray(report.rankings))
    throw new Error('Lead analyst returned invalid JSON');
  const candidateIds = new Set(candidates.map(({ leadId }) => leadId));
  const parsed = new Map<string, Omit<LeadAnalystEntry, 'rank'>>();
  for (const raw of report.rankings) {
    const item = objectValue(raw);
    if (!item || typeof item.leadId !== 'string' || !candidateIds.has(item.leadId)) continue;
    if (parsed.has(item.leadId)) continue;
    if (typeof item.fitSummary !== 'string' || typeof item.salesAngle !== 'string') continue;
    const notes = Array.isArray(item.notes)
      ? item.notes.filter((note): note is string => typeof note === 'string').slice(0, 5)
      : [];
    const risks = Array.isArray(item.risks)
      ? item.risks.filter((risk): risk is string => typeof risk === 'string').slice(0, 3)
      : [];
    if (!notes.length) continue;
    parsed.set(item.leadId, {
      leadId: item.leadId,
      fitSummary: item.fitSummary,
      salesAngle: item.salesAngle,
      notes,
      risks,
    });
  }
  const rankings = candidates
    .slice(0, MAX_RESULTS)
    .flatMap((candidate) => {
      const entry = parsed.get(candidate.leadId);
      return entry ? [{ ...entry, rank: 0 }] : [];
    })
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
  if (!rankings.length) throw new Error('Lead analyst did not return any recognized leads');
  return rankings;
}

export async function analyzeLeadList(
  rows: DashboardProspect[],
  options: { fetcher?: typeof fetch; now?: Date } = {},
): Promise<LeadAnalystReport> {
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for lead analysis');
  const candidates = prepareLeadAnalystInputs(rows);
  if (!candidates.length) throw new Error('Score the imported leads before running AI analysis');
  const model = env.LEAD_ANALYST_MODEL ?? env.LLM_MODEL ?? 'gpt-5.4-nano';
  const response = await (options.fetcher ?? fetch)('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    signal: AbortSignal.timeout(45_000),
    body: JSON.stringify({
      model,
      instructions:
        'You are Steel Scale Lead Analyst. Review only the supplied evidence. The numeric scores and primary offers are deterministic and authoritative: do not change them. Return up to 10 leads in the supplied order. Explain why each lead fits its primary offer, give a practical human-sales angle, and identify missing or stale evidence as risks. Never invent facts, contacts, consent, or website findings. Do not recommend automated unsolicited SMS.',
      input: `Analyze these deterministically ranked prospects:\n${JSON.stringify(candidates)}`,
      text: {
        format: {
          type: 'json_schema',
          name: 'lead_analyst_report',
          strict: true,
          schema: REPORT_SCHEMA,
        },
      },
    }),
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    logger.error({ status: response.status }, 'OpenAI lead analysis request rejected');
    throw new Error(`OpenAI lead analysis failed (${response.status})`);
  }
  const responseObject = objectValue(body);
  const text = responseObject ? outputText(responseObject) : undefined;
  if (!text) throw new Error('OpenAI lead analysis returned no structured output');
  const rankings = parseReport(JSON.parse(text) as unknown, candidates);
  return {
    generatedAt: options.now ?? new Date(),
    model,
    analyzedCount: candidates.length,
    rankings,
  };
}
