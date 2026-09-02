import type { Prisma } from '@prisma/client';

export interface WebsitePage {
  requestedUrl: string;
  finalUrl: string;
  statusCode: number;
  html: string;
  attempts: number;
}

export interface WebsitePageFailure {
  requestedUrl: string;
  error: string;
}

export interface WebsiteFetcher {
  fetchPage(url: string, allowedDomain: string): Promise<WebsitePage>;
}

export interface WebsiteDetection {
  key: string;
  result: boolean;
  confidence: number;
  evidenceUrl: string;
  metadata: Prisma.InputJsonObject;
}

export interface WebsiteAuditOptions {
  timeoutMs: number;
  retries: number;
  maxPages: number;
  maxRedirects: number;
  maxResponseBytes: number;
  staleAfterMs: number;
}

export interface WebsiteAuditResult {
  auditId: string;
  enrichmentRunId: string;
  status: 'completed' | 'failed';
  businessId: string;
  pagesCrawled: number;
  signalsCreated: number;
  error?: string;
}

export interface WebsiteAuditBatchResult {
  considered: number;
  completed: number;
  failed: number;
  skippedFresh: number;
  pagesCrawled: number;
  signalsCreated: number;
  results: WebsiteAuditResult[];
}
