import express, { Router, type ErrorRequestHandler, type Request } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { db } from '../db/client.js';
import { env } from '../config/env.js';
import { requireAdminAuth } from '../middleware/admin-auth.js';
import { logger } from '../utils/logger.js';
import {
  canView,
  EVENTS,
  InputError,
  MODULES,
  TOKEN,
  UUID,
  emptyEvidence,
  escapeHtml as e,
  generatePresentation,
  parseInput,
  type DemoInput,
  type Presentation,
} from './core.js';
import { researchHomepage } from './website.js';
import { signForm, verifyForm } from './security.js';
import { formView, layout, publicView } from './views.js';
import path from 'node:path';
import { liveRouter, runtimeToken } from './live-routes.js';
import { liveReadiness } from './live-runtime.js';

export const demoAdminRouter = Router();
export const demoPublicRouter = Router();
for (const router of [demoAdminRouter, demoPublicRouter]) {
  router.use((_req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()',
    });
    if (process.env.DEMO_ENGINE_ENABLED !== 'true') {
      res.status(404).send('Not found.');
      return;
    }
    next();
  });
}
// This router authenticates itself. Do not rely on parent /admin routing order.
demoAdminRouter.use(requireAdminAuth);
demoAdminRouter.use(express.urlencoded({ extended: false, limit: '32kb', parameterLimit: 60 }));
demoAdminRouter.use('/:id/live', liveRouter(true));
demoPublicRouter.use('/:token/live', liveRouter(false));
demoPublicRouter.get('/assets/:file', (req, res) => {
  if (!['experience.css', 'experience.js'].includes(String(req.params.file))) {
    res.sendStatus(404);
    return;
  }
  res.sendFile(path.resolve('public/demo', String(req.params.file)));
});
demoPublicRouter.use(express.json({ limit: '2kb' }));
function formToken(req: Request, scope: string): string {
  return signForm(env.ADMIN_PASSWORD ?? '', req.header('authorization') ?? '', scope);
}
function body(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};
}
function requireForm(req: Request, scope: string): void {
  const csrf = body(req).csrf;
  if (
    typeof csrf !== 'string' ||
    !verifyForm(csrf, env.ADMIN_PASSWORD ?? '', req.header('authorization') ?? '', scope)
  )
    throw new InputError('Invalid or expired form token. Reload the form before retrying.');
}
const jsonValue = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
function idParam(req: Request): string {
  const id = req.params.id;
  if (typeof id !== 'string' || !UUID.test(id)) throw new InputError('Invalid demo ID.');
  return id;
}
function version(req: Request): number {
  const value = body(req).version;
  if (typeof value !== 'string' || !/^\d{1,8}$/.test(value) || Number(value) < 1)
    throw new InputError('Invalid version.');
  return Number(value);
}
async function presentation(input: DemoInput): Promise<Presentation> {
  const evidence =
    input.researchWebsite && input.websiteUrl
      ? await researchHomepage(input.websiteUrl)
      : emptyEvidence(input.websiteUrl);
  return generatePresentation(input, evidence);
}
async function checkProspect(id: string): Promise<void> {
  if (!id) return;
  if (!(await db.prospectBusiness.findUnique({ where: { id }, select: { id: true } })))
    throw new InputError('The selected prospect no longer exists.');
}

demoAdminRouter.get('/', async (req, res) => {
  const offset =
    typeof req.query.offset === 'string' && /^\d{1,6}$/.test(req.query.offset)
      ? Number(req.query.offset)
      : 0;
  const [rows, total] = await Promise.all([
    db.salesDemo.findMany({
      orderBy: { updatedAt: 'desc' },
      skip: offset,
      take: 50,
      select: {
        id: true,
        businessName: true,
        status: true,
        eventCount: true,
        expiresAt: true,
        updatedAt: true,
      },
    }),
    db.salesDemo.count(),
  ]);
  res
    .type('html')
    .send(
      layout(
        'Demos',
        `<h1>Your on-demand demos</h1><p>Scraped leads do not generate demos. Only an explicit creation action starts generation.</p><div class="actions"><a class="button" href="/admin/demos/new">Create demo</a><a href="/admin/demos/prospects">Create from a prospect</a></div><section class="table-wrap"><table><thead><tr><th>Business</th><th>Status</th><th>Interactions*</th><th>Updated</th></tr></thead><tbody>${rows.map((row) => `<tr><td><a href="/admin/demos/${row.id}">${e(row.businessName)}</a></td><td>${row.status === 'published' && !canView(row.status, row.expiresAt) ? 'expired' : e(row.status)}</td><td>${row.eventCount}</td><td>${e(row.updatedAt.toISOString())}</td></tr>`).join('') || '<tr><td colspan="4">No demos yet.</td></tr>'}</tbody></table></section><p>*Pseudonymous interactions, not verified people or purchases. Preview traffic is excluded. Each demo is capped at 5,000 recorded events.</p><p>${offset > 0 ? `<a href="?offset=${Math.max(0, offset - 50)}">Previous</a> · ` : ''}${offset + 50 < total ? `<a href="?offset=${offset + 50}">Next</a>` : ''} ${total} demos</p>`,
        true,
      ),
    );
});
demoAdminRouter.get('/prospects', async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 160) : '';
  const prospects = query
    ? await db.prospectBusiness.findMany({
        where: { name: { contains: query, mode: 'insensitive' } },
        orderBy: { lastSeenAt: 'desc' },
        take: 50,
        select: { id: true, name: true, city: true, state: true },
      })
    : [];
  res
    .type('html')
    .send(
      layout(
        'Choose prospect',
        `<h1>Create from an existing prospect</h1><form method="get"><label>Business name<input name="q" maxlength="160" value="${e(query)}" required></label><button>Search</button></form><section>${prospects.map((p) => `<p><a href="/admin/demos/new?prospectBusinessId=${p.id}">${e(p.name)}</a> — ${e([p.city, p.state].filter(Boolean).join(', '))}</p>`).join('') || '<p>Enter a name to find up to 50 matching prospects. You can also create a standalone demo.</p>'}</section><a href="/admin/demos/new">Create standalone demo</a>`,
        true,
      ),
    );
});
demoAdminRouter.get('/new', async (req, res) => {
  let input: Partial<DemoInput> = {};
  const id = req.query.prospectBusinessId;
  if (id !== undefined) {
    if (typeof id !== 'string' || !UUID.test(id)) throw new InputError('Invalid prospect ID.');
    const p = await db.prospectBusiness.findUnique({ where: { id } });
    if (!p) {
      res.status(404).send('Prospect not found.');
      return;
    }
    input = {
      prospectBusinessId: p.id,
      businessName: p.name,
      niche: p.niche ?? p.category ?? '',
      websiteUrl: p.website ?? '',
      businessPhone: p.phone ?? '',
      location: [p.city, p.state].filter(Boolean).join(', '),
    };
  }
  res.type('html').send(formView(input, formToken(req, 'create'), randomUUID(), '/admin/demos'));
});
demoAdminRouter.post('/', async (req, res) => {
  requireForm(req, 'create');
  const requestId = body(req).requestId;
  if (typeof requestId !== 'string' || !UUID.test(requestId))
    throw new InputError('Invalid creation request.');
  const input = parseInput(req.body);
  const demoId = await db.$transaction(
    async (tx) => {
      // Serialize a request ID before doing optional website research so concurrent retries
      // create one row and perform generation only once.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${requestId}, 0))`;
      const duplicate = await tx.salesDemo.findUnique({
        where: { creationRequestId: requestId },
        select: { id: true },
      });
      if (duplicate) return duplicate.id;
      await checkProspect(input.prospectBusinessId);
      const generated = await presentation(input);
      const demo = await tx.salesDemo.create({
        data: {
          creationRequestId: requestId,
          shareToken: randomBytes(32).toString('hex'),
          businessName: input.businessName,
          prospectBusinessId: input.prospectBusinessId || null,
          inputs: jsonValue(input),
          presentation: jsonValue(generated),
        },
        select: { id: true },
      });
      return demo.id;
    },
    { timeout: 15_000 },
  );
  res.redirect(303, `/admin/demos/${demoId}`);
});
demoAdminRouter.get('/:id/edit', async (req, res) => {
  const id = idParam(req);
  const demo = await db.salesDemo.findUnique({ where: { id } });
  if (!demo) {
    res.status(404).send('Demo not found.');
    return;
  }
  const input = demo.inputs as unknown as DemoInput;
  // Deleting a linked prospect must not prevent editing the now-standalone demo.
  input.prospectBusinessId = demo.prospectBusinessId ?? '';
  res
    .type('html')
    .send(
      formView(
        input,
        formToken(req, `edit:${id}`),
        demo.creationRequestId,
        `/admin/demos/${id}/edit`,
        demo.version,
      ),
    );
});
demoAdminRouter.post('/:id/edit', async (req, res) => {
  const id = idParam(req);
  requireForm(req, `edit:${id}`);
  const expectedVersion = version(req);
  const input = parseInput(req.body);
  await checkProspect(input.prospectBusinessId);
  const generated = await presentation(input);
  const result = await db.salesDemo.updateMany({
    where: { id, version: expectedVersion },
    data: {
      businessName: input.businessName,
      prospectBusinessId: input.prospectBusinessId || null,
      inputs: jsonValue(input),
      presentation: jsonValue(generated),
      status: 'draft',
      reviewedAt: null,
      expiresAt: null,
      publishedAt: null,
      version: { increment: 1 },
    },
  });
  if (!result.count) {
    res.status(409).send('Demo changed or was deleted. Reload before editing.');
    return;
  }
  res.redirect(303, `/admin/demos/${id}`);
});
demoAdminRouter.get('/:id/preview', async (req, res) => {
  const demo = await db.salesDemo.findUnique({
    where: { id: idParam(req) },
    select: { id: true, version: true, presentation: true },
  });
  if (!demo) {
    res.status(404).send('Demo not found.');
    return;
  }
  res.type('html').send(
    publicView(demo.presentation as unknown as Presentation, '', true, {
      base: `/admin/demos/${demo.id}/live`,
      csrf: runtimeToken(req, demo.id, demo.version, true),
      ...liveReadiness(),
    }),
  );
});
demoAdminRouter.get('/:id', async (req, res) => {
  const id = idParam(req);
  const demo = await db.salesDemo.findUnique({ where: { id } });
  if (!demo) {
    res.status(404).send('Demo not found.');
    return;
  }
  const counts = await db.salesDemoEvent.groupBy({
    by: ['kind'],
    where: { demoId: id },
    _count: { _all: true },
  });
  const p = demo.presentation as unknown as Presentation;
  const path = `/demo/${demo.shareToken}`;
  const actionFields = (action: string) =>
    `<input type="hidden" name="csrf" value="${e(formToken(req, `${action}:${id}`))}"><input type="hidden" name="version" value="${demo.version}">`;
  res
    .type('html')
    .send(
      layout(
        demo.businessName,
        `<h1>${e(demo.businessName)}</h1><p>Status: <strong>${demo.status === 'published' && !canView(demo.status, demo.expiresAt) ? 'expired' : e(demo.status)}</strong> · Version ${demo.version} · ${demo.prospectBusinessId ? 'Linked prospect' : 'Standalone demo'}</p><div class="actions"><a class="button" href="/admin/demos/${id}/preview">Preview privately</a><a href="/admin/demos/${id}/edit">Edit / regenerate</a></div><section><h2>Review before sharing</h2><p>Modules: ${p.modules.map((m) => e(MODULES[m])).join(', ')}</p><p>Homepage research: ${e(p.websiteEvidence.status)}. ${e(p.websiteEvidence.warning)}</p><p>Only explicit public fields are rendered. Private sales notes and the business phone remain in the admin record. Niche examples must not be presented as verified services.</p><p>Voice and website chat support real OpenAI conversations when enabled. Appointments, missed-call messages, and follow-ups stay simulated. No real business phone numbers or production booking tools are used.</p><p>Live chat: ${liveReadiness().chat ? 'configured' : 'awaiting setup'}. Browser voice: ${liveReadiness().voice ? 'configured' : 'awaiting setup'}. These indicators check flags and key presence, not provider connectivity. Set DEMO_AI_ENABLED and DEMO_VOICE_ENABLED with a working OpenAI key in your local/staging environment; see docs/LIVE_DEMO_EXPERIENCE.md.</p></section><section><h2>Publish / renew</h2><form method="post" action="/admin/demos/${id}/publish">${actionFields('publish')}<label>Link lifetime (days, 1–90)<input name="days" type="number" min="1" max="90" value="45" required></label><label class="check"><input type="checkbox" name="reviewed" required>I reviewed this preview, its business information, and all example assumptions.</label><button>Publish reviewed demo</button></form>${canView(demo.status, demo.expiresAt) ? `<p>Shareable link: <a href="${path}" rel="noreferrer">${path}</a></p><p>Anyone with this link can view the demo until ${e(demo.expiresAt?.toISOString())}. Opening the public link may count as engagement; use the private preview when testing.</p>` : '<p>No active public link. Draft, archived, and expired demos return 404.</p>'}</section><section><h2>Engagement — all versions combined</h2>${counts.map((row) => `<p>${e(row.kind)}: ${row._count._all}</p>`).join('') || '<p>No recorded interactions.</p>'}<p>These are deduplicated browser-session signals, not identified owners, confirmed human visits, or proof of purchase intent. Preview visits are excluded; returning tabs or link scanners can still affect counts.</p></section><section><h2>Archive demo</h2><p>Stops public access immediately. Keeps the record and any linked prospect. No live client is affected.</p><form method="post" action="/admin/demos/${id}/archive">${actionFields('archive')}<button class="secondary">Archive</button></form></section>`,
        true,
      ),
    );
});
demoAdminRouter.post('/:id/publish', async (req, res) => {
  const id = idParam(req);
  requireForm(req, `publish:${id}`);
  const expectedVersion = version(req);
  const form = body(req);
  const days = Number(form.days);
  if (form.reviewed !== 'on' || !Number.isInteger(days) || days < 1 || days > 90)
    throw new InputError('Review confirmation and a lifetime of 1–90 days are required.');
  const now = new Date();
  const result = await db.salesDemo.updateMany({
    where: { id, version: expectedVersion },
    data: {
      status: 'published',
      reviewedAt: now,
      publishedAt: now,
      expiresAt: new Date(now.getTime() + days * 86400000),
      version: { increment: 1 },
    },
  });
  if (!result.count) {
    res.status(409).send('Demo changed or was deleted. Reload before publishing.');
    return;
  }
  res.redirect(303, `/admin/demos/${id}`);
});
demoAdminRouter.post('/:id/archive', async (req, res) => {
  const id = idParam(req);
  requireForm(req, `archive:${id}`);
  const result = await db.salesDemo.updateMany({
    where: { id, version: version(req) },
    data: { status: 'archived', version: { increment: 1 } },
  });
  if (!result.count) {
    res.status(409).send('Demo changed or was deleted. Reload first.');
    return;
  }
  res.redirect(303, `/admin/demos/${id}`);
});
demoPublicRouter.get('/:token', async (req, res) => {
  const token = req.params.token;
  if (typeof token !== 'string' || !TOKEN.test(token)) {
    res.status(404).send('Demo not available.');
    return;
  }
  // Select only the public allowlisted snapshot. Never return inputs, private notes or prospect relations.
  const demo = await db.salesDemo.findUnique({
    where: { shareToken: token },
    select: { id: true, version: true, status: true, expiresAt: true, presentation: true },
  });
  if (!demo || !canView(demo.status, demo.expiresAt)) {
    res.status(404).send('Demo not available.');
    return;
  }
  res.type('html').send(
    publicView(demo.presentation as unknown as Presentation, `/demo/${token}/events`, false, {
      base: `/demo/${token}/live`,
      csrf: runtimeToken(req, demo.id, demo.version, false),
      ...liveReadiness(),
    }),
  );
});
demoPublicRouter.post('/:token/events', async (req, res) => {
  const token = req.params.token;
  if (typeof token !== 'string' || !TOKEN.test(token)) {
    res.sendStatus(404);
    return;
  }
  const origin = req.header('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.header('host')) {
        res.sendStatus(403);
        return;
      }
    } catch {
      res.sendStatus(403);
      return;
    }
  }
  const { sessionKey, kind } = (req.body ?? {}) as Record<string, unknown>;
  if (
    typeof sessionKey !== 'string' ||
    !UUID.test(sessionKey) ||
    typeof kind !== 'string' ||
    !(EVENTS as readonly string[]).includes(kind)
  ) {
    res.sendStatus(400);
    return;
  }
  const demo = await db.salesDemo.findUnique({
    where: { shareToken: token },
    select: { id: true, status: true, expiresAt: true, presentation: true },
  });
  if (!demo || !canView(demo.status, demo.expiresAt)) {
    res.sendStatus(404);
    return;
  }
  const allowed = new Set(['opened']);
  const mapping = {
    voice: 'voice_previewed',
    chatbot: 'chatbot_tested',
    missed_call: 'missed_call_tested',
    nurture: 'nurture_tested',
    audit: 'audit_viewed',
    roi: 'roi_used',
  };
  for (const key of (demo.presentation as unknown as Presentation).modules)
    allowed.add(mapping[key]);
  if (!allowed.has(kind)) {
    res.sendStatus(400);
    return;
  }
  await db.$transaction(async (tx) => {
    const inserted = await tx.salesDemoEvent.createMany({
      data: [{ demoId: demo.id, sessionKey, kind }],
      skipDuplicates: true,
    });
    if (!inserted.count) return;
    // The row update serializes competing counters across application instances.
    const claimed = await tx.salesDemo.updateMany({
      where: {
        id: demo.id,
        status: 'published',
        expiresAt: { gt: new Date() },
        eventCount: { lt: 5000 },
      },
      data: { eventCount: { increment: 1 } },
    });
    if (!claimed.count) {
      await tx.salesDemoEvent.delete({
        where: { demoId_sessionKey_kind: { demoId: demo.id, sessionKey, kind } },
      });
    }
  });
  res.sendStatus(204);
});
const handleError: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
  void _next;
  if (err instanceof InputError) {
    res
      .status(400)
      .type('html')
      .send(
        layout(
          'Please check the form',
          `<h1>Please check the form</h1><p>${e(err.message)}</p><p>Use your browser’s Back button to retain your entries, or <a href="/admin/demos">return to demos</a>.</p>`,
          true,
        ),
      );
    return;
  }
  if (
    err &&
    typeof err === 'object' &&
    'status' in err &&
    (err.status === 400 || err.status === 413)
  ) {
    res.status(err.status).send('Invalid or oversized request body.');
    return;
  }
  // Explicitly avoid logging form inputs, headers, bearer URLs, or entire database error objects.
  logger.error(
    { component: 'demo-engine', errorType: err instanceof Error ? err.name : 'unknown' },
    'Demo request failed',
  );
  res
    .status(500)
    .send('Demo request failed. Check the feature configuration and database migration.');
};
for (const router of [demoAdminRouter, demoPublicRouter]) {
  // Unknown demo paths must not fall through to the generic bearer-URL/header logger.
  router.use((_req, res) => {
    res.status(404).send('Demo route not found.');
  });
  router.use(handleError);
}
