import { Router, type Request, type Response } from 'express';
import { IntelligenceOffer } from '@prisma/client';

import { db } from '../db/client.js';
import { auditBusinessWebsite } from '../lead-intelligence/enrichment/website-audit.js';
import {
  loadLeadIntelligenceDashboard,
  loadLeadIntelligenceDetail,
  type DashboardFilters,
  type DashboardProspect,
  type DashboardSort,
} from '../lead-intelligence/admin-dashboard.js';
import { scoreLead } from '../lead-intelligence/scoring/service.js';
import { adminLayout, escapeHtml } from '../utils/html.js';
import { adminOutscraperImportRouter } from './admin-outscraper-import.js';

export const adminLeadIntelligenceRouter = Router();
adminLeadIntelligenceRouter.use('/import', adminOutscraperImportRouter);

function value(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input.trim() : undefined;
}

function number(input: unknown): number | undefined {
  const text = value(input);
  if (!text) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function boolean(input: unknown): boolean | undefined {
  const text = value(input);
  return text === 'true' ? true : text === 'false' ? false : undefined;
}

function date(input: unknown): Date | undefined {
  const text = value(input);
  if (!text) return undefined;
  const parsed = new Date(text);
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed;
}

function filtersFrom(request: Request): DashboardFilters {
  const offer = value(request.query.offer);
  const sort = value(request.query.sort);
  const enrichmentStatus = value(request.query.enrichmentStatus);
  return {
    clientId: value(request.query.clientId),
    offer: Object.values(IntelligenceOffer).includes(offer as IntelligenceOffer)
      ? (offer as IntelligenceOffer)
      : undefined,
    minimumScore: number(request.query.minimumScore),
    maximumScore: number(request.query.maximumScore),
    scoreBand: value(request.query.scoreBand),
    niche: value(request.query.niche),
    city: value(request.query.city),
    state: value(request.query.state),
    source: value(request.query.source),
    minimumReviews: number(request.query.minimumReviews),
    operates24Hours: boolean(request.query.operates24Hours),
    emergency: boolean(request.query.emergency),
    hasChatbot: boolean(request.query.hasChatbot),
    hasOnlineBooking: boolean(request.query.hasOnlineBooking),
    maximumListingAgeHours: number(request.query.maximumListingAgeHours),
    minimumActiveListings: number(request.query.minimumActiveListings),
    notContacted: request.query.notContacted === 'true',
    lastContactedAfter: date(request.query.lastContactedAfter),
    enrichmentStatus: ['needs', 'failed', 'complete'].includes(enrichmentStatus ?? '')
      ? (enrichmentStatus as DashboardFilters['enrichmentStatus'])
      : undefined,
    sort: ['score', 'newest', 'reviews', 'listing_date', 'enrichment'].includes(sort ?? '')
      ? (sort as DashboardSort)
      : undefined,
  };
}

function formatDate(input: Date | null): string {
  return input ? input.toISOString().slice(0, 10) : '—';
}

function money(input: number | null): string {
  return input === null
    ? '—'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0,
      }).format(input);
}

function selected(actual: string | undefined, expected: string): string {
  return actual === expected ? ' selected' : '';
}

function queryValue(request: Request, key: string): string {
  return escapeHtml(value(request.query[key]) ?? '');
}

function booleanOptions(actual: string | undefined): string {
  return `<option value="">Any</option><option value="true"${selected(actual, 'true')}>Yes</option><option value="false"${selected(actual, 'false')}>No</option>`;
}

function scoreClass(band: string | null): string {
  return band ? `score-${band.toLowerCase()}` : 'score-none';
}

function renderMetrics(
  metrics: Awaited<ReturnType<typeof loadLeadIntelligenceDashboard>>['metrics'],
): string {
  const items = [
    ['Total prospects', metrics.totalProspects],
    ['Hot prospects', metrics.hotProspects],
    ['Voice AI', metrics.voiceAiOpportunities],
    ['Realtor video', metrics.realEstateVideoOpportunities],
    ['New today', metrics.newProspectsToday],
    ['Needs enrichment', metrics.needsEnrichment],
    ['Failed enrichment', metrics.failedEnrichment],
  ];
  return `<section class="metric-strip">${items.map(([label, count]) => `<div><strong>${count}</strong><span>${label}</span></div>`).join('')}</section>`;
}

function renderFilters(
  request: Request,
  clients: Array<{ id: string; businessName: string }>,
): string {
  const booleanSelect = (name: string, label: string) =>
    `<label>${label}<select name="${name}">${booleanOptions(value(request.query[name]))}</select></label>`;
  return `<details class="filter-panel" open><summary>Filters and sorting</summary><form method="get" action="/admin/leads" class="filter-grid">
    <label>Client<select name="clientId"><option value="">All clients</option>${clients.map((client) => `<option value="${client.id}"${selected(value(request.query.clientId), client.id)}>${escapeHtml(client.businessName)}</option>`).join('')}</select></label>
    <label>Primary offer<select name="offer"><option value="">Any offer</option>${Object.values(
      IntelligenceOffer,
    )
      .map((offer) => `<option${selected(value(request.query.offer), offer)}>${offer}</option>`)
      .join('')}</select></label>
    <label>Score from<input type="number" min="0" max="100" name="minimumScore" value="${queryValue(request, 'minimumScore')}"></label>
    <label>Score to<input type="number" min="0" max="100" name="maximumScore" value="${queryValue(request, 'maximumScore')}"></label>
    <label>Band<select name="scoreBand"><option value="">Any band</option>${['HOT', 'HIGH', 'MEDIUM', 'LOW', 'POOR'].map((band) => `<option${selected(value(request.query.scoreBand), band)}>${band}</option>`).join('')}</select></label>
    <label>Niche<input name="niche" value="${queryValue(request, 'niche')}"></label>
    <label>City<input name="city" value="${queryValue(request, 'city')}"></label>
    <label>State<input name="state" value="${queryValue(request, 'state')}" maxlength="30"></label>
    <label>Source<input name="source" value="${queryValue(request, 'source')}"></label>
    <label>Minimum reviews<input type="number" min="0" name="minimumReviews" value="${queryValue(request, 'minimumReviews')}"></label>
    ${booleanSelect('operates24Hours', '24/7')}${booleanSelect('emergency', 'Emergency')}${booleanSelect('hasChatbot', 'Has chatbot')}${booleanSelect('hasOnlineBooking', 'Online booking')}
    <label>Listing age ≤ hours<input type="number" min="1" name="maximumListingAgeHours" value="${queryValue(request, 'maximumListingAgeHours')}"></label>
    <label>Active listings ≥<input type="number" min="0" name="minimumActiveListings" value="${queryValue(request, 'minimumActiveListings')}"></label>
    <label>Last contacted after<input type="date" name="lastContactedAfter" value="${queryValue(request, 'lastContactedAfter')}"></label>
    <label>Enrichment<select name="enrichmentStatus"><option value="">Any status</option><option value="complete"${selected(value(request.query.enrichmentStatus), 'complete')}>Complete</option><option value="needs"${selected(value(request.query.enrichmentStatus), 'needs')}>Needs enrichment</option><option value="failed"${selected(value(request.query.enrichmentStatus), 'failed')}>Failed</option></select></label>
    <label>Sort by<select name="sort"><option value="score"${selected(value(request.query.sort) ?? 'score', 'score')}>Score</option><option value="newest"${selected(value(request.query.sort), 'newest')}>Newest opportunity</option><option value="reviews"${selected(value(request.query.sort), 'reviews')}>Reviews</option><option value="listing_date"${selected(value(request.query.sort), 'listing_date')}>Listing date</option><option value="enrichment"${selected(value(request.query.sort), 'enrichment')}>Last enrichment</option></select></label>
    <label class="check"><input type="checkbox" name="notContacted" value="true"${request.query.notContacted === 'true' ? ' checked' : ''}> Not contacted only</label>
    <div class="filter-actions"><button type="submit">Apply filters</button><a href="/admin/leads">Clear</a></div>
  </form></details>`;
}

function renderRows(rows: DashboardProspect[]): string {
  if (!rows.length)
    return '<div class="empty">No prospects match these filters. Clear filters or enrich and score more leads.</div>';
  return `<div class="table-wrap"><table class="prospect-table"><thead><tr><th>Business / agent</th><th>Location</th><th>Niche</th><th>Primary offer</th><th>Score</th><th>Reviews / listings</th><th>Key trigger</th><th>Phone</th><th>Website</th><th>Last seen</th><th>Last enriched</th><th>Outreach</th></tr></thead><tbody>${rows
    .map(
      (row) => `<tr>
    <td><a class="primary-link" href="/admin/leads/${row.leadId}">${escapeHtml(row.name)}</a><small class="block">${escapeHtml(row.clientName)} · ${row.entityType}</small></td>
    <td>${escapeHtml(row.location)}</td><td>${escapeHtml(row.niche ?? '—')}</td>
    <td><span class="offer-tag">${escapeHtml(row.primaryOffer?.replaceAll('_', ' ') ?? 'Awaiting score')}</span></td>
    <td><a class="score-cell ${scoreClass(row.scoreBand)}" href="/admin/leads/${row.leadId}"><strong>${row.score ?? '—'}</strong><span>${row.scoreBand ?? 'UNSCORED'}</span></a></td>
    <td>${row.reviewsOrListings ?? '—'}<small class="block">${row.entityType === 'agent' ? 'active listings' : 'reviews'}</small></td>
    <td class="trigger">${escapeHtml(row.keyTrigger)}</td><td class="mono">${escapeHtml(row.phone ?? '—')}</td>
    <td>${row.website ? `<a href="${escapeHtml(row.website)}" target="_blank" rel="noopener">Open</a>` : '—'}</td>
    <td>${formatDate(row.lastSeenAt)}</td><td>${formatDate(row.lastEnrichedAt)}</td><td><span class="badge neutral">${escapeHtml(row.outreachStatus)}</span></td>
  </tr>`,
    )
    .join('')}</tbody></table></div>`;
}

adminLeadIntelligenceRouter.get('/', async (request, response, next) => {
  try {
    const filters = filtersFrom(request);
    const [{ rows, metrics }, clients] = await Promise.all([
      loadLeadIntelligenceDashboard(filters),
      db.client.findMany({
        select: { id: true, businessName: true },
        orderBy: { businessName: 'asc' },
      }),
    ]);
    const exportQuery = new URLSearchParams();
    for (const [key, rawValue] of Object.entries(request.query)) {
      if (typeof rawValue === 'string') exportQuery.set(key, rawValue);
    }
    response.send(
      adminLayout(
        'Lead Intelligence',
        `<nav class="admin-tabs"><a href="/admin">Clients</a><a class="active" href="/admin/leads">Lead Intelligence</a><a href="/admin/call-queue">Call queue</a></nav>
      <header class="page-header intelligence-header"><div><h1>Prospecting command board</h1><p>Rank opportunities, inspect evidence, and control outreach readiness.</p></div><div class="header-actions"><a class="button" href="/admin/leads/import">Import Outscraper file</a><a class="button secondary" href="/admin/leads/export.csv?${exportQuery.toString()}">Export current view</a></div></header>
      ${renderMetrics(metrics)}${renderFilters(request, clients)}
      <section class="panel table-panel intelligence-table"><div class="table-caption"><strong>${rows.length} prospects</strong><span>Current scores and latest evidence</span></div>${renderRows(rows)}</section>`,
      ),
    );
  } catch (error) {
    next(error);
  }
});

adminLeadIntelligenceRouter.get('/export.csv', async (request, response, next) => {
  try {
    const { rows } = await loadLeadIntelligenceDashboard(filtersFrom(request));
    const quote = (input: string | number | null | undefined) =>
      `"${String(input ?? '').replaceAll('"', '""')}"`;
    const csv = [
      [
        'Name',
        'Type',
        'Location',
        'Niche',
        'Primary Offer',
        'Score',
        'Band',
        'Reviews',
        'Active Listings',
        'Phone',
        'Website',
        'Listing URL',
        'Last Seen',
        'Last Enriched',
        'Outreach Status',
        'Sources',
      ],
      ...rows.map((row) => [
        row.name,
        row.entityType,
        row.location,
        row.niche,
        row.primaryOffer,
        row.score,
        row.scoreBand,
        row.reviewCount,
        row.activeListings,
        row.phone,
        row.website,
        row.listingUrl,
        row.lastSeenAt.toISOString(),
        row.lastEnrichedAt?.toISOString(),
        row.outreachStatus,
        row.sources.join('|'),
      ]),
    ]
      .map((line) => line.map(quote).join(','))
      .join('\n');
    response.setHeader('content-type', 'text/csv; charset=utf-8');
    response.setHeader('content-disposition', 'attachment; filename="lead-intelligence.csv"');
    response.send(csv);
  } catch (error) {
    next(error);
  }
});

adminLeadIntelligenceRouter.get('/:leadId', async (request, response, next) => {
  try {
    const [row, lead] = await Promise.all([
      loadLeadIntelligenceDetail(request.params.leadId),
      db.lead.findUnique({
        where: { id: request.params.leadId },
        include: {
          business: {
            include: { contacts: true, sourceRecords: { orderBy: { lastSeenAt: 'desc' } } },
          },
          realEstateAgent: {
            include: {
              listings: { orderBy: { listedAt: 'desc' }, include: { providerSources: true } },
            },
          },
          outreachActivities: { orderBy: { occurredAt: 'desc' }, take: 25 },
          offerSuppressions: { where: { liftedAt: null } },
        },
      }),
    ]);
    if (!row || !lead) {
      response
        .status(404)
        .send(
          adminLayout(
            'Prospect not found',
            '<div class="notice error">Prospect not found. <a href="/admin/leads">Return to Lead Intelligence</a>.</div>',
          ),
        );
      return;
    }
    const statusNotice = value(request.query.status);
    const why = row.scoreComponents.length
      ? row.scoreComponents
          .map(
            (factor) =>
              `<li class="factor ${factor.points < 0 ? 'negative' : ''}"><strong>${factor.points >= 0 ? '+' : ''}${factor.points}</strong><span>${escapeHtml(factor.label)}${factor.observedValue !== null ? `<small>${escapeHtml(typeof factor.observedValue === 'object' ? JSON.stringify(factor.observedValue) : String(factor.observedValue))}</small>` : ''}</span></li>`,
          )
          .join('')
      : '<li class="empty">No score explanation is available yet.</li>';
    const website = row.signals;
    const bool = (key: string, absent = 'No evidence') =>
      website.get(key)?.boolean === true
        ? 'Yes'
        : website.get(key)?.boolean === false
          ? 'No'
          : absent;
    const sourceItems =
      row.sources.map((source) => `<li>${escapeHtml(source.replaceAll('_', ' '))}</li>`).join('') ||
      '<li>No source records</li>';
    const contacts =
      lead.business?.contacts
        .map(
          (contact) =>
            `<li><strong>${escapeHtml(contact.fullName ?? ([contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'Contact'))}</strong><span>${escapeHtml(contact.phone ?? contact.email ?? 'No direct details')}</span></li>`,
        )
        .join('') ?? '';
    const activities = lead.outreachActivities
      .map(
        (activity) =>
          `<tr><td>${formatDate(activity.occurredAt)}</td><td>${escapeHtml(activity.channel)}</td><td>${escapeHtml(activity.outcome ?? '—')}</td></tr>`,
      )
      .join('');
    const property =
      row.entityType === 'agent' && row.listingAddress
        ? `<section class="property-trigger"><div>${row.listingImages[0] ? `<img src="${escapeHtml(row.listingImages[0])}" alt="Property at ${escapeHtml(row.listingAddress)}">` : '<div class="property-placeholder">No image</div>'}</div><div><span>Primary opportunity</span><h2>${escapeHtml(row.listingAddress)}</h2><strong>${money(row.listingPrice)}</strong><p>Listed ${row.listingDate ? formatDate(row.listingDate) : 'date unavailable'}</p>${row.listingUrl ? `<a href="${escapeHtml(row.listingUrl)}" target="_blank" rel="noopener">Open source listing</a>` : ''}</div></section>`
        : '';
    response.send(
      adminLayout(
        row.name,
        `<nav class="admin-tabs"><a href="/admin">Clients</a><a class="active" href="/admin/leads">Lead Intelligence</a><a href="/admin/call-queue">Call queue</a></nav>
      ${statusNotice ? `<div class="notice success-notice">${escapeHtml(statusNotice.replaceAll('_', ' '))}</div>` : ''}
      <header class="detail-header"><div><a href="/admin/leads">← Prospecting dashboard</a><h1>${escapeHtml(row.name)}</h1><p>${escapeHtml(row.location)} · ${escapeHtml(row.niche ?? 'Uncategorized')}</p></div><div class="hero-score ${scoreClass(row.scoreBand)}"><strong>${row.score ?? '—'}</strong><span>/ 100 · ${row.scoreBand ?? 'UNSCORED'}</span><small>${escapeHtml(row.primaryOffer?.replaceAll('_', ' ') ?? 'No recommendation')}</small></div></header>
      ${property}
      <div class="detail-grid"><div class="detail-main"><section class="panel detail-panel"><h2>Why this prospect qualifies</h2><ol class="factor-list">${why}</ol></section>
      <section class="panel detail-panel"><h2>Website intelligence</h2><dl class="signal-grid"><div><dt>Chatbot</dt><dd>${bool('has_chatbot')}</dd></div><div><dt>Online booking</dt><dd>${bool('has_online_booking')}</dd></div><div><dt>Phone visible</dt><dd>${bool('has_visible_phone')}</dd></div><div><dt>Emergency language</dt><dd>${bool('mentions_emergency')}</dd></div><div><dt>24/7</dt><dd>${bool('mentions_24_7')}</dd></div><div><dt>Website reachable</dt><dd>${bool('website_reachable')}</dd></div></dl></section>
      <section class="panel detail-panel"><h2>Previous outreach</h2>${activities ? `<table><thead><tr><th>Date</th><th>Channel</th><th>Outcome</th></tr></thead><tbody>${activities}</tbody></table>` : '<div class="empty">No outreach has been recorded.</div>'}</section></div>
      <aside><section class="panel detail-panel"><h2>Actions</h2><div class="action-stack"><form method="post" action="/admin/leads/${row.leadId}/contacted"><button>Mark contacted</button></form><form method="post" action="/admin/leads/${row.leadId}/bad"><button class="danger">Mark bad lead</button></form><form method="post" action="/admin/leads/${row.leadId}/suppress"><button class="secondary">Suppress lead</button></form><form method="post" action="/admin/leads/${row.leadId}/refresh"><button class="secondary">Refresh enrichment</button></form><form method="post" action="/admin/leads/${row.leadId}/rescore"><button class="secondary">Recalculate score</button></form>${row.website ? `<a class="button secondary" href="${escapeHtml(row.website)}" target="_blank" rel="noopener">Open website</a>` : ''}${row.phone ? `<button class="secondary" type="button" data-copy="${escapeHtml(row.phone)}">Copy phone</button>` : ''}<a class="button secondary" href="/admin/leads/export.csv?clientId=${row.clientId}">Export</a></div></section>
      <section class="panel detail-panel"><h2>Contact</h2><p class="mono">${escapeHtml(row.phone ?? 'No phone')}</p>${lead.realEstateAgent?.email ? `<p><a href="mailto:${escapeHtml(lead.realEstateAgent.email)}">${escapeHtml(lead.realEstateAgent.email)}</a></p>` : ''}<ul class="contact-list">${contacts || '<li>No additional contacts</li>'}</ul></section>
      <section class="panel detail-panel"><h2>Sources</h2><ul>${sourceItems}</ul><p>Last seen ${formatDate(row.lastSeenAt)}</p><p>Last enriched ${formatDate(row.lastEnrichedAt)}</p></section></aside></div>
      <script>document.querySelectorAll('[data-copy]').forEach(function(button){button.addEventListener('click',function(){navigator.clipboard.writeText(button.getAttribute('data-copy')||'').then(function(){button.textContent='Copied';});});});</script>`,
      ),
    );
  } catch (error) {
    next(error);
  }
});

async function redirectAction(
  request: Request,
  response: Response,
  action: () => Promise<string>,
): Promise<void> {
  const status = await action();
  const leadId = value(request.params.leadId);
  if (!leadId) throw new Error('Lead ID is required');
  response.redirect(303, `/admin/leads/${leadId}?status=${encodeURIComponent(status)}`);
}

adminLeadIntelligenceRouter.post('/:leadId/contacted', async (request, response, next) => {
  try {
    await redirectAction(request, response, async () => {
      const existing = await db.leadOutreachState.findUnique({
        where: { leadId: request.params.leadId },
      });
      await db.leadOutreachState.upsert({
        where: { leadId: request.params.leadId },
        create: {
          leadId: request.params.leadId,
          disposition: 'contacted',
          lastContactedAt: new Date(),
          contactAttemptCount: 1,
        },
        update: {
          disposition: 'contacted',
          contactable: true,
          lastContactedAt: new Date(),
          contactAttemptCount: { increment: 1 },
        },
      });
      await db.outreachActivity.create({
        data: {
          clientId: (await db.lead.findUniqueOrThrow({ where: { id: request.params.leadId } }))
            .clientId,
          leadId: request.params.leadId,
          channel: existing?.lastChannel ?? 'other',
          direction: 'outbound',
          outcome: 'manually_marked_contacted',
          occurredAt: new Date(),
        },
      });
      return 'marked_contacted';
    });
  } catch (error) {
    next(error);
  }
});
adminLeadIntelligenceRouter.post('/:leadId/bad', async (request, response, next) => {
  try {
    await redirectAction(request, response, async () => {
      await db.leadOutreachState.upsert({
        where: { leadId: request.params.leadId },
        create: {
          leadId: request.params.leadId,
          disposition: 'invalid',
          contactable: false,
          doNotContactReason: 'Marked bad lead in admin',
        },
        update: {
          disposition: 'invalid',
          contactable: false,
          doNotContactReason: 'Marked bad lead in admin',
        },
      });
      return 'marked_bad_lead';
    });
  } catch (error) {
    next(error);
  }
});
adminLeadIntelligenceRouter.post('/:leadId/suppress', async (request, response, next) => {
  try {
    await redirectAction(request, response, async () => {
      await db.leadOutreachState.upsert({
        where: { leadId: request.params.leadId },
        create: {
          leadId: request.params.leadId,
          disposition: 'paused',
          contactable: false,
          doNotContactReason: 'Suppressed in admin',
        },
        update: {
          disposition: 'paused',
          contactable: false,
          doNotContactReason: 'Suppressed in admin',
        },
      });
      return 'lead_suppressed';
    });
  } catch (error) {
    next(error);
  }
});
adminLeadIntelligenceRouter.post('/:leadId/refresh', async (request, response, next) => {
  try {
    await redirectAction(request, response, async () => {
      const lead = await db.lead.findUniqueOrThrow({
        where: { id: request.params.leadId },
        select: { businessId: true },
      });
      if (!lead.businessId) return 'listing_refresh_requires_new_import';
      await auditBusinessWebsite({ businessId: lead.businessId });
      return 'enrichment_refreshed';
    });
  } catch (error) {
    next(error);
  }
});
adminLeadIntelligenceRouter.post('/:leadId/rescore', async (request, response, next) => {
  try {
    await redirectAction(request, response, async () => {
      const lead = await db.lead.findUniqueOrThrow({
        where: { id: request.params.leadId },
        select: { businessId: true, realEstateAgent: { select: { id: true } } },
      });
      await scoreLead(
        request.params.leadId,
        lead.businessId ? IntelligenceOffer.VOICE_AI : IntelligenceOffer.REAL_ESTATE_VIDEO,
      );
      return 'score_recalculated';
    });
  } catch (error) {
    next(error);
  }
});
