import { IntelligenceOffer } from '@prisma/client';

import { env } from '../../config/env.js';
import type { DashboardProspect } from '../admin-dashboard.js';

export const DEFAULT_ORGANIZER_OFFERS: IntelligenceOffer[] = [
  IntelligenceOffer.VOICE_AI,
  IntelligenceOffer.WEBSITE,
  IntelligenceOffer.SEO_RANKING,
];

export interface OrganizedLead {
  leadId: string;
  recommendedOffer: IntelligenceOffer;
  confidence: number;
  reason: string;
  salesNotes: string[];
}

export interface OfferOrganization {
  generatedAt: Date;
  model: string;
  analyzedCount: number;
  offers: IntelligenceOffer[];
  leads: OrganizedLead[];
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function responseText(value: unknown): string | undefined {
  const response = objectValue(value);
  if (typeof response?.output_text === 'string') return response.output_text;
  if (!Array.isArray(response?.output)) return undefined;
  for (const rawMessage of response.output) {
    const message = objectValue(rawMessage);
    if (!Array.isArray(message?.content)) continue;
    for (const rawContent of message.content) {
      const content = objectValue(rawContent);
      if (content?.type === 'output_text' && typeof content.text === 'string') return content.text;
    }
  }
  return undefined;
}

function analystEvidence(row: DashboardProspect) {
  return {
    leadId: row.leadId,
    name: row.name,
    location: row.location,
    niche: row.niche,
    existingPrimaryOffer: row.primaryOffer,
    deterministicScore: row.score,
    scoreBand: row.scoreBand,
    evidenceConfidence: row.confidence,
    reasons: row.reasons,
    reviewCount: row.reviewCount,
    rating: row.rating,
    activeListings: row.activeListings,
    hasPhone: Boolean(row.phone),
    hasWebsite: Boolean(row.website),
    outreachStatus: row.outreachStatus,
    lastEnrichedAt: row.lastEnrichedAt?.toISOString() ?? null,
    signals: Object.fromEntries(
      [...row.signals.entries()].map(([key, value]) => [
        key,
        value.boolean ?? value.number ?? value.text,
      ]),
    ),
    scoreComponents: row.scoreComponents,
  };
}

async function classifyBatch(
  rows: DashboardProspect[],
  offers: IntelligenceOffer[],
  model: string,
  fetcher: typeof fetch,
): Promise<OrganizedLead[]> {
  const schema = {
    type: 'object',
    properties: {
      leads: {
        type: 'array',
        minItems: rows.length,
        maxItems: rows.length,
        items: {
          type: 'object',
          properties: {
            leadId: { type: 'string' },
            recommendedOffer: { type: 'string', enum: offers },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            reason: { type: 'string' },
            salesNotes: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 },
          },
          required: ['leadId', 'recommendedOffer', 'confidence', 'reason', 'salesNotes'],
          additionalProperties: false,
        },
      },
    },
    required: ['leads'],
    additionalProperties: false,
  };
  const response = await fetcher('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      model,
      instructions: `You organize sales leads using only supplied evidence. Assign every lead to exactly one allowed offer: ${offers.join(', ')}. Choose the service that addresses the clearest evidenced need. A missing website favors WEBSITE. A reachable site with weak capture infrastructure, emergency/24-hour demand, and a phone favors VOICE_AI. Strong business maturity with a functioning website but discoverability opportunity may favor SEO_RANKING. REVIEWS requires evidence of a review gap. REAL_ESTATE_VIDEO requires real-estate listing evidence. Never invent observations. Return every lead exactly once. Do not provide outreach or compliance advice.`,
      input: JSON.stringify(rows.map(analystEvidence)),
      text: { format: { type: 'json_schema', name: 'offer_organization', strict: true, schema } },
    }),
  });
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(`OpenAI offer organization failed (${response.status})`);
  const text = responseText(body);
  if (!text) throw new Error('OpenAI returned no offer organization');
  const parsed = objectValue(JSON.parse(text) as unknown);
  if (!Array.isArray(parsed?.leads)) throw new Error('OpenAI returned invalid offer organization');
  const expected = new Set(rows.map(({ leadId }) => leadId));
  const seen = new Set<string>();
  const result: OrganizedLead[] = [];
  for (const raw of parsed.leads) {
    const item = objectValue(raw);
    const leadId = typeof item?.leadId === 'string' ? item.leadId : '';
    const offer = item?.recommendedOffer;
    if (!expected.has(leadId) || seen.has(leadId) || !offers.includes(offer as IntelligenceOffer))
      continue;
    if (typeof item?.reason !== 'string' || typeof item.confidence !== 'number') continue;
    const salesNotes = Array.isArray(item.salesNotes)
      ? item.salesNotes.filter((note): note is string => typeof note === 'string').slice(0, 4)
      : [];
    if (salesNotes.length < 2) continue;
    seen.add(leadId);
    result.push({
      leadId,
      recommendedOffer: offer as IntelligenceOffer,
      confidence: Math.max(0, Math.min(1, item.confidence)),
      reason: item.reason,
      salesNotes,
    });
  }
  if (seen.size !== expected.size) throw new Error('OpenAI did not classify every submitted lead');
  return result;
}

export async function organizeLeadsByOffer(
  rows: DashboardProspect[],
  offers: IntelligenceOffer[],
  options: { fetcher?: typeof fetch; now?: Date; maximumLeads?: number } = {},
): Promise<OfferOrganization> {
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for offer organization');
  const uniqueOffers = [...new Set(offers)];
  if (uniqueOffers.length !== 3) throw new Error('Select exactly three different offers');
  const maximumLeads = Math.min(100, Math.max(1, options.maximumLeads ?? 100));
  const selectedRows = rows.slice(0, maximumLeads);
  if (!selectedRows.length) throw new Error('No leads match the selected filters');
  const model = env.LEAD_ANALYST_MODEL ?? env.LLM_MODEL ?? 'gpt-5.4-nano';
  const leads: OrganizedLead[] = [];
  for (let index = 0; index < selectedRows.length; index += 20) {
    leads.push(
      ...(await classifyBatch(
        selectedRows.slice(index, index + 20),
        uniqueOffers,
        model,
        options.fetcher ?? fetch,
      )),
    );
  }
  return {
    generatedAt: options.now ?? new Date(),
    model,
    analyzedCount: selectedRows.length,
    offers: uniqueOffers,
    leads,
  };
}
