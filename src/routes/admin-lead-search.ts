import { randomUUID } from 'node:crypto';

import { Router, type Request } from 'express';

import { db } from '../db/client.js';
import { enqueueLeadIntelligencePipeline } from '../lead-intelligence/pipeline/background.js';
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
    recentRuns?: Array<{
      id: string;
      status: string;
      currentStage: string | null;
      createdAt: Date;
      client: { businessName: string };
    }>;
  } = {},
): string {
  const configured = configuredLeadDiscoveryProviders();
  const recentRuns = options.recentRuns ?? [];
  return adminLayout(
    'Run Lead Search',
    `<nav class="admin-tabs"><a href="/admin">Clients</a><a class="active" href="/admin/leads">Lead Intelligence</a><a href="/admin/call-queue">Call queue</a></nav><header class="page-header"><div><a class="eyebrow" href="/admin/leads">← Lead Intelligence</a><h1>Run a provider search</h1><p>Discover, import, enrich, score, recommend, and queue qualified prospects without downloading files.</p></div></header>${options.error ? `<div class="notice error">${escapeHtml(options.error)}</div>` : ''}${recentRuns.length ? `<section class="panel"><div class="section-heading"><span>RECENT</span><div><h2>Pipeline runs</h2><p>Open a run to check its progress or results.</p></div></div><ul>${recentRuns.map((run) => `<li><a href="/admin/leads/search/runs/${run.id}">${escapeHtml(run.client.businessName)} — ${escapeHtml(run.currentStage ?? run.status)}</a> <small>${escapeHtml(run.createdAt.toLocaleString())}</small></li>`).join('')}</ul></section>` : ''}<form method="post" action="/admin/leads/search" class="stack"><section class="panel"><div class="section-heading"><span>01</span><div><h2>Campaign</h2><p>API keys remain server-side in Railway.</p></div></div><div class="form-grid"><label>Client<select name="clientId" required><option value="">Select client</option>${clients.map((client) => `<option value="${client.id}">${escapeHtml(client.businessName)}</option>`).join('')}</select></label><label>Provider<select name="provider" required><option value="outscraper">Outscraper Google Maps${configured.outscraper_google_maps ? '' : ' — key not configured'}</option><option value="apify">Apify Zillow Search + Detail${configured.real_estate ? '' : ' — token not configured'}</option></select></label><label>Maximum results<input name="maximumResults" type="number" min="1" max="100" value="25" required><small>Start with 10–25 to control provider and website-audit cost.</small></label><label>Qualified review threshold<input name="threshold" type="number" min="0" max="100" value="75" required></label></div></section><section class="panel"><div class="section-heading"><span>02</span><div><h2>Search criteria</h2><p>For Outscraper use keywords and places. For Apify paste complete Zillow newest-first search URLs.</p></div></div><div class="form-grid"><label class="wide">Outscraper keywords<textarea name="keywords" placeholder="water damage restoration&#10;fire damage restoration&#10;mold remediation"></textarea></label><label class="wide">Locations or Zillow search URLs<textarea name="locations" required placeholder="Pittsburgh PA&#10;Philadelphia PA"></textarea></label><label>Minimum Google reviews<input name="minimumReviews" type="number" min="0" value="10"></label><label>Listing age window (hours)<input name="listedWithinHours" type="number" min="1" value="168"></label></div></section><div class="notice">The search runs in the background. You can leave its status page and return later.</div><div class="form-actions"><button type="submit">Start lead pipeline</button></div></form>`,
  );
}

adminLeadSearchRouter.get('/runs/:runId', async (request, response, next) => {
  try {
    const run = await db.pipelineRun.findUnique({
      where: { id: request.params.runId },
      include: { client: { select: { businessName: true } } },
    });
    if (!run)
      return response
        .status(404)
        .send(
          adminLayout(
            'Pipeline not found',
            '<div class="notice error">Pipeline run not found.</div>',
          ),
        );
    const active = run.status === 'pending' || run.status === 'running';
    const state = run.stageState as { queuedForReview?: number } | null;
    const errors = Array.isArray(run.errorSummaries) ? run.errorSummaries : [];
    response.set('Cache-Control', 'no-store');
    if (active) response.set('Refresh', '5');
    return response.send(
      adminLayout(
        'Lead Pipeline Status',
        `<nav class="admin-tabs"><a href="/admin">Clients</a><a class="active" href="/admin/leads">Lead Intelligence</a><a href="/admin/call-queue">Call queue</a></nav><header class="page-header"><div><a class="eyebrow" href="/admin/leads/search">← New search</a><h1>${active ? 'Pipeline is running' : `Pipeline ${escapeHtml(run.status)}`}</h1><p>${escapeHtml(run.client.businessName)} · <span class="mono">${escapeHtml(run.id)}</span></p></div></header><section class="panel"><div class="section-heading"><span>${active ? 'LIVE' : 'DONE'}</span><div><h2>${escapeHtml(run.currentStage ?? run.status)}</h2><p>${active ? 'This page refreshes every five seconds. You may safely leave and return later.' : 'Processing has finished.'}</p></div></div><dl class="import-report"><div><dt>Discovered</dt><dd>${run.recordsDiscovered}</dd></div><div><dt>Imported</dt><dd>${run.recordsImported}</dd></div><div><dt>Updated</dt><dd>${run.recordsUpdated}</dd></div><div><dt>Duplicates</dt><dd>${run.duplicates}</dd></div><div><dt>Enriched</dt><dd>${run.enriched}</dd></div><div><dt>Scored</dt><dd>${run.scored}</dd></div><div><dt>Hot leads</dt><dd>${run.hotLeads}</dd></div><div><dt>Queued</dt><dd>${state?.queuedForReview ?? 0}</dd></div></dl>${errors.length ? `<div class="notice error"><strong>Errors</strong><ul>${errors.map((item) => `<li>${escapeHtml(typeof item === 'object' && item && 'message' in item ? String(item.message) : String(item))}</li>`).join('')}</ul></div>` : ''}<div class="form-actions"><a class="button" href="/admin/leads?sort=score">View ranked leads</a>${active ? '<a class="button secondary" href="">Refresh now</a>' : ''}</div></section>`,
      ),
    );
  } catch (error) {
    return next(error);
  }
});

adminLeadSearchRouter.get('/', async (_request, response, next) => {
  try {
    const [clients, recentRuns] = await Promise.all([
      db.client.findMany({ select: { id: true, businessName: true } }),
      db.pipelineRun.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { client: { select: { businessName: true } } },
      }),
    ]);
    response.send(render(clients, { recentRuns }));
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
    const runId = await enqueueLeadIntelligencePipeline(campaign, `admin:${randomUUID()}`);
    response.redirect(303, `/admin/leads/search/runs/${runId}`);
  } catch (error) {
    const clients = await db.client.findMany({ select: { id: true, businessName: true } });
    response
      .status(400)
      .send(render(clients, { error: error instanceof Error ? error.message : String(error) }));
  }
});
