import { randomUUID } from 'node:crypto';

import { Router, type Request } from 'express';

import { db } from '../db/client.js';
import { runLeadIntelligencePipeline } from '../lead-intelligence/pipeline/orchestrator.js';
import { configuredLeadDiscoveryProviders } from '../lead-intelligence/pipeline/scheduler.js';
import type { PipelineCampaign } from '../lead-intelligence/pipeline/types.js';
import { adminLayout, escapeHtml } from '../utils/html.js';

export const adminLeadSearchRouter = Router();

function body(request: Request, key: string): string {
  const value = (request.body as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function lines(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function locationLines(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function render(
  clients: Array<{ id: string; businessName: string }>,
  options: {
    error?: string;
    result?: Awaited<ReturnType<typeof runLeadIntelligencePipeline>>;
  } = {},
): string {
  const configured = configuredLeadDiscoveryProviders();
  const result = options.result;
  return adminLayout(
    'Run Lead Search',
    `<nav class="admin-tabs"><a href="/admin">Clients</a><a class="active" href="/admin/leads">Lead Intelligence</a><a href="/admin/call-queue">Call queue</a></nav><header class="page-header"><div><a class="eyebrow" href="/admin/leads">← Lead Intelligence</a><h1>Run a provider search</h1><p>Discover, import, enrich, score, recommend, and queue qualified prospects without downloading files.</p></div></header>${options.error ? `<div class="notice error">${escapeHtml(options.error)}</div>` : ''}${result ? `<section class="panel"><div class="section-heading"><span>DONE</span><div><h2>Pipeline ${escapeHtml(result.status)}</h2><p class="mono">${escapeHtml(result.runId)}</p></div></div><dl class="import-report"><div><dt>Discovered</dt><dd>${result.recordsDiscovered}</dd></div><div><dt>Imported</dt><dd>${result.recordsImported}</dd></div><div><dt>Updated</dt><dd>${result.recordsUpdated}</dd></div><div><dt>Duplicates</dt><dd>${result.duplicates}</dd></div><div><dt>Enriched</dt><dd>${result.enriched}</dd></div><div><dt>Scored</dt><dd>${result.scored}</dd></div><div><dt>Hot leads</dt><dd>${result.hotLeads}</dd></div><div><dt>Queued</dt><dd>${result.queuedForReview}</dd></div></dl><div class="import-submit"><a class="button" href="/admin/leads?sort=score">View ranked leads</a></div></section>` : ''}<form method="post" action="/admin/leads/search" class="stack"><section class="panel"><div class="section-heading"><span>01</span><div><h2>Campaign</h2><p>API keys remain server-side in Railway.</p></div></div><div class="form-grid"><label>Client<select name="clientId" required><option value="">Select client</option>${clients.map((client) => `<option value="${client.id}">${escapeHtml(client.businessName)}</option>`).join('')}</select></label><label>Provider<select name="provider" required><option value="outscraper">Outscraper Google Maps${configured.outscraper_google_maps ? '' : ' — key not configured'}</option><option value="apify">Apify Zillow Search + Detail${configured.real_estate ? '' : ' — token not configured'}</option></select></label><label>Maximum results<input name="maximumResults" type="number" min="1" max="100" value="25" required><small>Start with 10–25 to control provider and website-audit cost.</small></label><label>Qualified review threshold<input name="threshold" type="number" min="0" max="100" value="75" required></label></div></section><section class="panel"><div class="section-heading"><span>02</span><div><h2>Search criteria</h2><p>For Outscraper use keywords and places. For Apify paste complete Zillow newest-first search URLs.</p></div></div><div class="form-grid"><label class="wide">Outscraper keywords<textarea name="keywords" placeholder="water damage restoration&#10;fire damage restoration&#10;mold remediation"></textarea></label><label class="wide">Locations or Zillow search URLs<textarea name="locations" required placeholder="Pittsburgh PA&#10;Philadelphia PA"></textarea></label><label>Minimum Google reviews<input name="minimumReviews" type="number" min="0" value="10"></label><label>Listing age window (hours)<input name="listedWithinHours" type="number" min="1" value="168"></label></div></section><div class="notice">New scraped phone numbers are queued for human review and calling. SMS eligibility remains off unless explicit consent is recorded separately.</div><div class="form-actions"><button type="submit">Run complete lead pipeline</button></div></form>`,
  );
}

adminLeadSearchRouter.get('/', async (_request, response, next) => {
  try {
    const clients = await db.client.findMany({ select: { id: true, businessName: true } });
    response.send(render(clients));
  } catch (error) {
    next(error);
  }
});

adminLeadSearchRouter.post('/', async (request, response) => {
  try {
    const clients = await db.client.findMany({ select: { id: true, businessName: true } });
    const clientId = body(request, 'clientId');
    const provider = body(request, 'provider');
    const maximumResults = Number(body(request, 'maximumResults'));
    const threshold = Number(body(request, 'threshold'));
    const locations = locationLines(body(request, 'locations'));
    const keywords = lines(body(request, 'keywords'));
    if (!clients.some(({ id }) => id === clientId)) throw new Error('Select a valid client');
    if (!Number.isInteger(maximumResults) || maximumResults < 1 || maximumResults > 100)
      throw new Error('Maximum results must be from 1 to 100');
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100)
      throw new Error('Review threshold must be from 0 to 100');
    if (!locations.length) throw new Error('At least one location or search URL is required');
    const discovery =
      provider === 'apify'
        ? {
            kind: 'real_estate' as const,
            provider: 'zillow',
            locations,
            maximumResults,
            listedWithinHours: Number(body(request, 'listedWithinHours')) || 168,
            expectedResultsIntervalHours: 24,
          }
        : {
            kind: 'outscraper_google_maps' as const,
            keywords,
            locations,
            maximumResults,
            minimumReviews: Number(body(request, 'minimumReviews')) || 0,
          };
    if (discovery.kind === 'outscraper_google_maps' && !keywords.length)
      throw new Error('At least one Outscraper keyword is required');
    if (
      discovery.kind === 'real_estate' &&
      locations.some((location) => {
        try {
          const url = new URL(location);
          return (
            url.protocol !== 'https:' ||
            !url.hostname.toLocaleLowerCase('en-US').endsWith('zillow.com')
          );
        } catch {
          return true;
        }
      })
    )
      throw new Error('Apify requires complete HTTPS Zillow search URLs');
    const campaign: PipelineCampaign = {
      key: `admin-${provider}-${Date.now()}`,
      clientId,
      source: discovery.kind === 'real_estate' ? 'real_estate' : 'outscraper_google_maps',
      discovery,
      enrichmentConcurrency: 3,
      scoringConcurrency: 5,
      reviewScoreThreshold: threshold,
    };
    const result = await runLeadIntelligencePipeline(
      campaign,
      { providers: configuredLeadDiscoveryProviders() },
      `admin:${randomUUID()}`,
    );
    response.status(result.status === 'failed' ? 502 : 200).send(render(clients, { result }));
  } catch (error) {
    const clients = await db.client.findMany({ select: { id: true, businessName: true } });
    response
      .status(400)
      .send(render(clients, { error: error instanceof Error ? error.message : String(error) }));
  }
});
