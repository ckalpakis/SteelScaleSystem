import { randomUUID } from 'node:crypto';

import { Prisma } from '@prisma/client';

import { db } from '../../db/client.js';
import { logger } from '../../utils/logger.js';
import { normalizeDomain } from '../ingestion/normalization.js';
import { detectWebsiteSignals, discoverAuditPages, WEBSITE_SIGNAL_KEYS } from './detector.js';
import { normalizeAuditUrl, SafeWebsiteFetcher } from './http-fetcher.js';
import type {
  WebsiteAuditBatchResult,
  WebsiteAuditOptions,
  WebsiteAuditResult,
  WebsiteDetection,
  WebsiteFetcher,
  WebsitePage,
  WebsitePageFailure,
} from './types.js';

export const DEFAULT_WEBSITE_AUDIT_OPTIONS: WebsiteAuditOptions = {
  timeoutMs: 8_000,
  retries: 1,
  maxPages: 3,
  maxRedirects: 5,
  maxResponseBytes: 2_000_000,
  staleAfterMs: 30 * 24 * 60 * 60 * 1_000,
};

interface AuditBusinessInput {
  businessId: string;
  idempotencyKey?: string;
  fetcher?: WebsiteFetcher;
  options?: Partial<WebsiteAuditOptions>;
  observedAt?: Date;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Website audit result is not JSON serializable');
  return JSON.parse(serialized) as Prisma.InputJsonValue;
}

function auditResultFromExisting(audit: {
  id: string;
  enrichmentRunId: string | null;
  status: string;
  businessId: string | null;
  pagesCrawled: number;
  rawResult: Prisma.JsonValue;
  errorMessage: string | null;
}): WebsiteAuditResult {
  const raw =
    audit.rawResult && typeof audit.rawResult === 'object' && !Array.isArray(audit.rawResult)
      ? (audit.rawResult as { signalsCreated?: unknown })
      : undefined;
  return {
    auditId: audit.id,
    enrichmentRunId: audit.enrichmentRunId ?? '',
    status: audit.status === 'completed' ? 'completed' : 'failed',
    businessId: audit.businessId ?? '',
    pagesCrawled: audit.pagesCrawled,
    signalsCreated: typeof raw?.signalsCreated === 'number' ? raw.signalsCreated : 0,
    error: audit.errorMessage ?? undefined,
  };
}

function baseDetection(
  key: string,
  result: boolean,
  confidence: number,
  evidenceUrl: string,
  metadata: Prisma.InputJsonObject,
): WebsiteDetection {
  return { key, result, confidence, evidenceUrl, metadata };
}

async function persistSignals(
  transaction: Prisma.TransactionClient,
  input: {
    clientId: string;
    leadId: string;
    auditId: string;
    observedAt: Date;
    detections: WebsiteDetection[];
  },
): Promise<void> {
  for (const detection of input.detections) {
    await transaction.leadSignal.create({
      data: {
        clientId: input.clientId,
        leadId: input.leadId,
        key: detection.key,
        value: detection.result,
        booleanValue: detection.result,
        provider: 'website_intelligence',
        confidence: detection.confidence,
        observedAt: input.observedAt,
        evidence: {
          origin: 'DERIVED',
          provider: 'website_intelligence',
          auditId: input.auditId,
          evidenceUrl: detection.evidenceUrl,
          ...detection.metadata,
        },
      },
    });
  }
}

export async function auditBusinessWebsite(input: AuditBusinessInput): Promise<WebsiteAuditResult> {
  const options = { ...DEFAULT_WEBSITE_AUDIT_OPTIONS, ...input.options };
  if (options.maxPages < 1 || options.maxPages > 10) throw new Error('maxPages must be 1-10');
  if (options.retries < 0 || options.retries > 3) throw new Error('retries must be 0-3');
  const observedAt = input.observedAt ?? new Date();
  const business = await db.prospectBusiness.findUniqueOrThrow({
    where: { id: input.businessId },
    include: { leads: { take: 1 }, sourceRecords: { orderBy: { lastSeenAt: 'desc' }, take: 1 } },
  });
  const lead = business.leads[0];
  if (!lead) throw new Error(`Business ${business.id} has no canonical lead`);
  if (!business.website) throw new Error(`Business ${business.id} has no website URL`);
  const startUrl = normalizeAuditUrl(business.website);
  const normalizedDomain = normalizeDomain(startUrl.toString());
  if (!normalizedDomain) throw new Error(`Business ${business.id} has an invalid website domain`);
  const idempotencyKey = input.idempotencyKey ?? `${business.id}:${observedAt.toISOString()}`;
  const existingRun = await db.enrichmentRun.findUnique({
    where: {
      clientId_provider_idempotencyKey: {
        clientId: business.clientId,
        provider: 'website_intelligence',
        idempotencyKey,
      },
    },
    include: { websiteAudit: true },
  });
  if (existingRun?.websiteAudit) return auditResultFromExisting(existingRun.websiteAudit);
  if (existingRun) throw new Error(`Website enrichment run ${existingRun.id} is incomplete`);

  const run = await db.enrichmentRun.create({
    data: {
      clientId: business.clientId,
      leadId: lead.id,
      sourceRecordId: business.sourceRecords[0]?.id,
      provider: 'website_intelligence',
      idempotencyKey,
      status: 'running',
      startedAt: observedAt,
    },
  });
  const fetcher = input.fetcher ?? new SafeWebsiteFetcher(options);
  const pages: WebsitePage[] = [];
  const failures: WebsitePageFailure[] = [];
  const started = Date.now();

  try {
    const homepage = await fetcher.fetchPage(startUrl.toString(), normalizedDomain);
    pages.push(homepage);
    for (const pageUrl of discoverAuditPages(homepage, normalizedDomain, options.maxPages)) {
      try {
        pages.push(await fetcher.fetchPage(pageUrl, normalizedDomain));
      } catch (error) {
        failures.push({ requestedUrl: pageUrl, error: message(error) });
      }
    }
    const detections = [
      baseDetection(WEBSITE_SIGNAL_KEYS.HAS_WEBSITE, true, 1, homepage.finalUrl, {
        method: 'canonical_business_website',
      }),
      baseDetection(WEBSITE_SIGNAL_KEYS.WEBSITE_REACHABLE, true, 1, homepage.finalUrl, {
        method: 'successful_http_response',
        statusCode: homepage.statusCode,
      }),
      ...detectWebsiteSignals(pages),
    ];
    const rawResult = jsonValue({
      pages: pages.map(({ finalUrl, requestedUrl, statusCode, attempts }) => ({
        finalUrl,
        requestedUrl,
        statusCode,
        attempts,
      })),
      pageFailures: failures,
      detections,
      signalsCreated: detections.length,
    });
    const completedAt = new Date();
    const audit = await db.$transaction(async (transaction) => {
      const created = await transaction.websiteAudit.create({
        data: {
          clientId: business.clientId,
          leadId: lead.id,
          businessId: business.id,
          sourceRecordId: business.sourceRecords[0]?.id,
          enrichmentRunId: run.id,
          provider: 'website_intelligence',
          auditedUrl: startUrl.toString(),
          normalizedDomain,
          statusCode: homepage.statusCode,
          status: 'completed',
          finalUrl: homepage.finalUrl,
          pagesCrawled: pages.length,
          durationMs: Date.now() - started,
          rawResult,
          observedAt,
          expiresAt: new Date(observedAt.getTime() + options.staleAfterMs),
        },
      });
      await persistSignals(transaction, {
        clientId: business.clientId,
        leadId: lead.id,
        auditId: created.id,
        observedAt,
        detections,
      });
      await transaction.prospectBusiness.update({
        where: { id: business.id },
        data: { websiteLastAuditedAt: observedAt },
      });
      await transaction.enrichmentRun.update({
        where: { id: run.id },
        data: { status: 'completed', rawResponse: rawResult, completedAt },
      });
      return created;
    });
    return {
      auditId: audit.id,
      enrichmentRunId: run.id,
      status: 'completed',
      businessId: business.id,
      pagesCrawled: pages.length,
      signalsCreated: detections.length,
    };
  } catch (error) {
    const errorText = message(error).slice(0, 4000);
    const completedAt = new Date();
    logger.warn(
      { clientId: business.clientId, businessId: business.id, url: startUrl.toString(), error },
      'Website Intelligence audit failed',
    );
    const audit = await db.$transaction(async (transaction) => {
      const created = await transaction.websiteAudit.create({
        data: {
          clientId: business.clientId,
          leadId: lead.id,
          businessId: business.id,
          sourceRecordId: business.sourceRecords[0]?.id,
          enrichmentRunId: run.id,
          provider: 'website_intelligence',
          auditedUrl: startUrl.toString(),
          normalizedDomain,
          status: 'failed',
          errorMessage: errorText,
          pagesCrawled: pages.length,
          durationMs: Date.now() - started,
          rawResult: jsonValue({
            pages: pages.map(({ finalUrl, requestedUrl, statusCode, attempts }) => ({
              finalUrl,
              requestedUrl,
              statusCode,
              attempts,
            })),
            pageFailures: [...failures, { requestedUrl: startUrl.toString(), error: errorText }],
            signalsCreated: 2,
          }),
          observedAt,
          expiresAt: new Date(
            observedAt.getTime() + Math.min(options.staleAfterMs, 24 * 60 * 60 * 1_000),
          ),
        },
      });
      await persistSignals(transaction, {
        clientId: business.clientId,
        leadId: lead.id,
        auditId: created.id,
        observedAt,
        detections: [
          baseDetection(WEBSITE_SIGNAL_KEYS.HAS_WEBSITE, true, 1, startUrl.toString(), {
            method: 'canonical_business_website',
          }),
          baseDetection(WEBSITE_SIGNAL_KEYS.WEBSITE_REACHABLE, false, 0.95, startUrl.toString(), {
            method: 'bounded_fetch_failure',
            error: errorText,
          }),
        ],
      });
      await transaction.prospectBusiness.update({
        where: { id: business.id },
        data: { websiteLastAuditedAt: observedAt },
      });
      await transaction.enrichmentRun.update({
        where: { id: run.id },
        data: { status: 'failed', errorMessage: errorText, completedAt },
      });
      return created;
    });
    return {
      auditId: audit.id,
      enrichmentRunId: run.id,
      status: 'failed',
      businessId: business.id,
      pagesCrawled: pages.length,
      signalsCreated: 2,
      error: errorText,
    };
  }
}

interface BatchOptions {
  clientId: string;
  concurrency?: number;
  limit?: number;
  staleBefore?: Date;
  fetcher?: WebsiteFetcher;
  auditOptions?: Partial<WebsiteAuditOptions>;
}

export async function auditStaleBusinessWebsites(
  input: BatchOptions,
): Promise<WebsiteAuditBatchResult> {
  const concurrency = input.concurrency ?? 3;
  if (concurrency < 1 || concurrency > 10) throw new Error('concurrency must be 1-10');
  const staleBefore =
    input.staleBefore ?? new Date(Date.now() - DEFAULT_WEBSITE_AUDIT_OPTIONS.staleAfterMs);
  const websiteFilter = { clientId: input.clientId, website: { not: null } } as const;
  const staleFilter = {
    ...websiteFilter,
    OR: [{ websiteLastAuditedAt: null }, { websiteLastAuditedAt: { lt: staleBefore } }],
  };
  const [allWithWebsite, staleWithWebsite] = await Promise.all([
    db.prospectBusiness.count({ where: websiteFilter }),
    db.prospectBusiness.count({ where: staleFilter }),
  ]);
  const businesses = await db.prospectBusiness.findMany({
    where: staleFilter,
    select: { id: true },
    orderBy: [{ websiteLastAuditedAt: 'asc' }, { createdAt: 'asc' }],
    take: input.limit ?? 100,
  });
  const results = Array.from<WebsiteAuditResult | undefined>({ length: businesses.length });
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < businesses.length) {
      const index = nextIndex;
      nextIndex += 1;
      const business = businesses[index];
      if (!business) continue;
      try {
        results[index] = await auditBusinessWebsite({
          businessId: business.id,
          idempotencyKey: `${business.id}:${randomUUID()}`,
          fetcher: input.fetcher,
          options: input.auditOptions,
        });
      } catch (error) {
        results[index] = {
          auditId: '',
          enrichmentRunId: '',
          status: 'failed',
          businessId: business.id,
          pagesCrawled: 0,
          signalsCreated: 0,
          error: message(error),
        };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, businesses.length) }, () => worker()),
  );
  const completedResults = results.filter(
    (result): result is WebsiteAuditResult => result !== undefined,
  );
  return {
    considered: businesses.length,
    completed: completedResults.filter(({ status }) => status === 'completed').length,
    failed: completedResults.filter(({ status }) => status === 'failed').length,
    skippedFresh: Math.max(0, allWithWebsite - staleWithWebsite),
    pagesCrawled: completedResults.reduce((sum, result) => sum + result.pagesCrawled, 0),
    signalsCreated: completedResults.reduce((sum, result) => sum + result.signalsCreated, 0),
    results: completedResults,
  };
}
