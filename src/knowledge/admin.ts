import express from 'express';
import { randomBytes } from 'node:crypto';
import { db } from '../db/client.js';
import { workspaceLayout as adminLayout, escapeHtml as e } from '../utils/html.js';
import { authenticate, tokenHash, type Principal } from '../workforce/tenancy/service.js';
import { signForm, verifyForm } from '../demo-engine/security.js';
import { enabled } from '../integrations/http.js';
import { peerLimit, organizationLimit } from '../integrations/rate-limit.js';
import { object, WorkforceError } from '../workforce/shared.js';
import { KnowledgeService } from './service.js';
import { knowledgeEnabled } from './http.js';
import { categories, categoryFields } from './contracts.js';

export const knowledgeAdminRouter = express.Router();
knowledgeAdminRouter.use(enabled, knowledgeEnabled, peerLimit);
knowledgeAdminRouter.use(async (req, res, next) => {
  let authorization = req.header('authorization');
  if (authorization?.startsWith('Basic ')) {
    const s = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    authorization = `Bearer ${s.slice(s.indexOf(':') + 1)}`;
  }
  try {
    const p = await authenticate(db, authorization);
    await organizationLimit(db, p.organizationId);
    await new KnowledgeService(db, p).tx(() => Promise.resolve(true));
    res.locals.principal = p;
  } catch (error) {
    if (error instanceof WorkforceError && error.status === 401)
      res.setHeader(
        'WWW-Authenticate',
        'Basic realm="Steel Scale Business Knowledge (member API key)"',
      );
    throw error;
  }
  res.locals.nonce = randomBytes(16).toString('base64');
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${String(res.locals.nonce)}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  );
  next();
});
knowledgeAdminRouter.use(
  express.urlencoded({ extended: false, limit: '64kb', parameterLimit: 50 }),
);
knowledgeAdminRouter.use((req, _res, next) => {
  const auth = req.header('authorization') ?? '';
  if (
    req.method !== 'GET' &&
    !verifyForm(object(req.body).csrf, tokenHash(auth), auth, req.originalUrl.split('?')[0]!)
  )
    throw new WorkforceError(403, 'form_expired_or_invalid');
  next();
});
const root = '/business-knowledge';
const principal = (res: express.Response) => res.locals.principal as Principal;
const service = (res: express.Response) => new KnowledgeService(db, principal(res));
const display = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const field = (name: string, label: string, value: unknown = '') =>
  `<label>${e(label)}<input name="${e(name)}" value="${e(display(value))}"></label>`;
const area = (name: string, label: string, value: unknown = '') =>
  `<label>${e(label)}<textarea name="${e(name)}" rows="5">${e(display(value))}</textarea></label>`;
const hidden = (name: string, value: unknown) =>
  `<input type="hidden" name="${e(name)}" value="${e(String(value))}">`;
const csrf = (req: express.Request, path: string) =>
  hidden(
    'csrf',
    signForm(tokenHash(req.header('authorization')!), req.header('authorization')!, path),
  );
const label = (s: string) => s.replaceAll('_', ' ');
const styles = `<style>.knowledge{max-width:1180px}.knowledge .intro{max-width:74ch}.knowledge-grid{display:grid;grid-template-columns:minmax(0,2fr) minmax(260px,1fr);gap:24px}.knowledge-grid>*{min-width:0}.knowledge pre,.knowledge .excerpt{white-space:pre-wrap;overflow-wrap:anywhere}.knowledge .panel{padding:20px}.knowledge label{display:block;margin:12px 0}.knowledge input[type=checkbox]{width:auto}.knowledge table{min-width:650px}.knowledge .scroll{overflow-x:auto}.knowledge .muted{color:var(--steel);font-size:14px}.knowledge .actions{display:flex;gap:12px;flex-wrap:wrap}.knowledge details{margin:16px 0}.knowledge summary{cursor:pointer;font-weight:600}.knowledge :is(input,textarea,select,button):focus-visible{outline:3px solid #f59e0b;outline-offset:2px}.knowledge code{overflow-wrap:anywhere}@media(max-width:800px){.knowledge-grid{grid-template-columns:1fr}.topbar>div{flex-wrap:wrap;gap:8px}}</style>`;
function parsed(value: unknown) {
  try {
    return JSON.parse(String(value)) as unknown;
  } catch {
    throw new WorkforceError(400, 'invalid_knowledge_json');
  }
}
const stateForm = (
  req: express.Request,
  kind: string,
  row: { id: string; active: boolean; revision: number },
) =>
  `<form method="post" action="${root}/${kind}/${row.id}/active">${csrf(req, `${root}/${kind}/${row.id}/active`)}${hidden('expectedRevision', row.revision)}${hidden('active', !row.active)}<button class="secondary">${row.active ? 'Deactivate' : 'Activate'}</button></form>`;
knowledgeAdminRouter.get('/', async (req, res) => {
  const data = await service(res).overview(
      typeof req.query.after === 'string' ? req.query.after : undefined,
    ),
    admin = ['owner', 'admin'].includes(principal(res).role ?? '');
  const sources = data.sources
    .map((s) => `<option value="${s.id}">${e(s.name)}${s.active ? '' : ' (inactive)'}</option>`)
    .join('');
  res.send(
    adminLayout(
      'Business Knowledge',
      `${styles}<div class="knowledge"><h1>Business Knowledge</h1><p class="intro">Approved facts your agents can reference. Saving creates a draft; review makes it available. Facts never grant permission to promise prices, financing or outcomes.</p><div class="knowledge-grid"><div><section class="panel"><h2>Knowledge library</h2><div class="scroll"><table><thead><tr><th>Entry</th><th>Category / audience</th><th>Review state</th><th>Source</th></tr></thead><tbody>${data.entries.map((r) => `<tr><td><a href="${root}/entries/${r.id}">${e(r.versions[0]?.title ?? 'Draft')}</a></td><td>${e(label(r.category))}<br>${e(r.audience)}</td><td>${r.active && r.approvedVersionId ? 'Approved · active' : r.approvedVersionId ? 'Approved · inactive' : 'Draft · not available'}</td><td>${e(r.source.name)}${r.source.active ? '' : ' (inactive)'}</td></tr>`).join('') || '<tr><td colspan="4">No knowledge yet. Add a source, then save and review your first fact or FAQ.</td></tr>'}</tbody></table></div>${data.entries.length === 50 ? `<a href="${root}?after=${data.entries[49]!.id}">Next entries</a>` : ''}</section>${admin ? `<section class="panel"><h2>Add knowledge</h2><form method="post" action="${root}/entries">${csrf(req, root + '/entries')}<label>Source<select name="sourceId" required>${sources}</select></label><label>Category<select name="category">${categories.map((c) => `<option value="${c}">${e(label(c))}</option>`).join('')}</select></label><label>Audience<select name="audience"><option value="internal">Internal reference only</option><option value="public">Approved for customer reference</option></select></label>${field('title', 'Title')}${field('question', 'FAQ question (required for FAQs)')}${area('content', 'Exact factual answer or statement')}${area('facts', 'Structured facts (JSON, optional)', '{}')}${field('documentId', 'Optional source document ID')}<details><summary>Structured fields by category</summary><pre>${e(JSON.stringify(categoryFields, null, 2))}</pre></details><button${sources ? '' : ' disabled'}>Save draft</button></form></section>` : ''}</div><aside><section class="panel"><h2>Test a question</h2><p class="muted">Only an exact reviewed question can return a general answer. Other matches show reference excerpts; sensitive facts require policy review. No model call or message is sent.</p><form method="post" action="${root}/questions">${csrf(req, root + '/questions')}${field('question', 'Question')}<button>Test question</button></form></section><section class="panel"><h2>Sources</h2>${data.sources.map((s) => `<details><summary>${e(s.name)} · ${s.active ? 'active' : 'inactive'}</summary><p>${e(s.reference ?? 'Organization-authored source')}</p><code>${s.id}</code>${admin ? stateForm(req, 'sources', s) : ''}</details>`).join('') || '<p>No sources yet.</p>'}${admin ? `<form method="post" action="${root}/sources">${csrf(req, root + '/sources')}${field('name', 'Source name')}${field('reference', 'Optional HTTPS reference (not fetched)')}<button>Add source</button></form>` : ''}</section><section class="panel"><h2>Reference documents</h2><p class="muted">Plain text and Markdown, up to 40 KB. Documents are not agent knowledge until you approve exact excerpts as entries. No PDF, OCR or remote website ingestion.</p>${data.documents.map((d) => `<details><summary>${e(d.filename)} · ${d.active ? 'active' : 'inactive'}</summary><p><a href="${root}/documents/${d.id}">View source text</a></p><code>${d.id}</code>${admin ? stateForm(req, 'documents', d) : ''}</details>`).join('')}${admin ? `<form method="post" action="${root}/documents">${csrf(req, root + '/documents')}<label>Document source<select name="sourceId" required>${sources}</select></label><label>Choose text file<input id="knowledge-file" type="file" accept=".txt,.md,text/plain,text/markdown"></label>${field('filename', 'Filename', 'reference.txt')}${area('content', 'Reference text')}<p id="file-status" role="status"></p><button${sources ? '' : ' disabled'}>Save reference document</button></form>` : ''}</section></aside></div></div><script nonce="${e(String(res.locals.nonce))}">document.getElementById('knowledge-file')?.addEventListener('change',async event=>{const file=event.target.files[0],form=event.target.form,status=document.getElementById('file-status');if(!file)return;if(file.size>40000||!/[.](txt|md)$/i.test(file.name)){status.textContent='Choose a .txt or .md file up to 40 KB.';return;}form.elements.filename.value=file.name;form.elements.content.value=await file.text();status.textContent='File loaded locally. Review it before saving.';});</script>`,
    ),
  );
});
knowledgeAdminRouter.get('/entries/:id', async (req, res) => {
  const r = await service(res).detail(String(req.params.id)),
    v = r.versions[0]!,
    admin = ['owner', 'admin'].includes(principal(res).role ?? ''),
    path = `${root}/entries/${r.id}`;
  res.send(
    adminLayout(
      'Review business knowledge',
      `${styles}<div class="knowledge"><p><a href="${root}">Business Knowledge</a></p><h1>${e(v.title)}</h1><p>${e(label(r.category))} · ${e(r.audience)} · ${e(v.risk)} reference</p><div class="knowledge-grid"><section class="panel"><h2>Review version ${v.number}</h2><p>${e(v.question ?? 'Factual statement')}</p><p class="excerpt">${e(v.content)}</p><pre>${e(JSON.stringify(v.facts, null, 2))}</pre><p>Source: ${e(r.source.name)}${r.document ? ` / ${e(r.document.filename)}` : ''}. Entry ${r.id}.</p><p>Version ID: <code>${v.id}</code></p><p>${r.approvedVersionId === v.id ? `Approved by ${e(r.approvedBy ?? '')} on ${e(r.approvedAt?.toISOString() ?? '')}` : 'Not approved for agent use.'}</p>${v.risk === 'restricted' ? '<p>Approval confirms reference accuracy only. Pricing, financing, warranties and other sensitive promises still require action-specific policy review.</p>' : ''}${admin ? `<form method="post" action="${path}/approve">${csrf(req, path + '/approve')}${hidden('expectedRevision', r.revision)}${hidden('versionId', v.id)}<label><input type="checkbox" name="reviewed" value="true" required> I verified this exact version and its intended audience.</label><button>Approve and activate version</button></form>${r.approvedVersionId ? stateForm(req, 'entries', r) : ''}<details><summary>Edit as a new draft</summary><form method="post" action="${path}">${csrf(req, path)}${hidden('expectedRevision', r.revision)}${hidden('sourceId', r.sourceId)}${hidden('documentId', r.documentId ?? '')}${hidden('category', r.category)}${hidden('audience', r.audience)}${field('title', 'Title', v.title)}${field('question', 'FAQ question', v.question)}${area('content', 'Exact factual answer or statement', v.content)}${area('facts', 'Structured facts (JSON)', JSON.stringify(v.facts, null, 2))}<p>Saving removes this entry from retrieval until the new version is reviewed. Source, category and audience stay fixed; create a separate entry to change them.</p><button>Save new draft</button></form></details>` : ''}</section><aside class="panel"><h2>Version history</h2><p class="muted">Latest 50 immutable versions. Editing never overwrites the previous facts.</p>${r.versions.map((version) => `<details><summary>Version ${version.number} · ${e(version.createdAt.toISOString())}</summary><p>${e(version.createdBy)}</p><p class="excerpt">${e(version.content)}</p><pre>${e(JSON.stringify(version.facts, null, 2))}</pre><code>${version.id}</code></details>`).join('')}</aside></div></div>`,
    ),
  );
});
knowledgeAdminRouter.get('/documents/:id', async (req, res) => {
  const d = await service(res).documentDetail(String(req.params.id));
  res.send(
    adminLayout(
      'Knowledge source text',
      `${styles}<div class="knowledge"><a href="${root}">Business Knowledge</a><h1>${e(d.filename)}</h1><p>Document ID: ${d.id}. Select an exact excerpt and save it as an entry before approval.</p><pre>${e(d.content)}</pre></div>`,
    ),
  );
});
const withoutCsrf = (raw: unknown) =>
  Object.fromEntries(Object.entries(object(raw)).filter(([key]) => key !== 'csrf'));
knowledgeAdminRouter.post('/sources', async (req, res) => {
  await service(res).source(withoutCsrf(req.body));
  res.redirect(303, root);
});
knowledgeAdminRouter.post('/documents', async (req, res) => {
  await service(res).document(withoutCsrf(req.body));
  res.redirect(303, root);
});
for (const path of ['/entries', '/entries/:id'])
  knowledgeAdminRouter.post(path, async (req, res) => {
    const v = withoutCsrf(req.body);
    const saved = await service(res).save(
      {
        ...v,
        facts: parsed(v.facts || '{}'),
        ...(req.params.id ? { expectedRevision: Number(v.expectedRevision) } : {}),
      },
      req.params.id ? String(req.params.id) : undefined,
    );
    res.redirect(303, `${root}/entries/${saved.entry.id}`);
  });
knowledgeAdminRouter.post('/entries/:id/approve', async (req, res) => {
  const v = withoutCsrf(req.body);
  await service(res).approve(String(req.params.id), {
    ...v,
    expectedRevision: Number(v.expectedRevision),
    reviewed: v.reviewed === 'true',
  });
  res.redirect(303, `${root}/entries/${String(req.params.id)}`);
});
for (const kind of ['sources', 'documents', 'entries'] as const)
  knowledgeAdminRouter.post(`/${kind}/:id/active`, async (req, res) => {
    const v = object(req.body);
    await service(res).toggle(kind, String(req.params.id), {
      expectedRevision: Number(v.expectedRevision),
      active: v.active === 'true',
    });
    res.redirect(303, root);
  });
knowledgeAdminRouter.post('/questions', async (req, res) => {
  const result = await service(res).question({ question: object(req.body).question });
  res.send(
    adminLayout(
      'Knowledge answer test',
      `${styles}<div class="knowledge"><a href="${root}">Business Knowledge</a><h1>Question test</h1><p>${e(String(object(req.body).question))}</p><section class="panel"><h2>${result.answer ? 'Approved answer' : 'No supported automatic answer'}</h2><p class="excerpt">${e(result.answer ?? 'Review the references below. Steel Scale did not infer facts or grant permissions.')}</p><p>Status: ${e(result.status)}. Permissions granted: no.</p></section><h2>Sources used for retrieval</h2>${result.sources.map((s) => `<section class="panel"><h3>${e(s.title)}</h3><p class="excerpt">${e(s.excerpt)}</p><p>${e(s.source)}${s.document ? ` / ${e(s.document.filename)}` : ''} · version ${s.version} · ${e(s.risk)}</p><a href="${root}/entries/${s.entryId}">Review source entry</a></section>`).join('') || '<p>No active, approved public source matched.</p>'}</div>`,
    ),
  );
});
knowledgeAdminRouter.use(((error: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  res
    .status(error instanceof WorkforceError ? error.status : 500)
    .send(
      adminLayout(
        'Knowledge request unavailable',
        `<h1>Request not completed</h1><p>${e(error instanceof WorkforceError ? error.code : 'knowledge_request_failed')}</p><a href="${root}">Return to Business Knowledge</a>`,
      ),
    );
}) as express.ErrorRequestHandler);
