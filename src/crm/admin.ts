import express, { type ErrorRequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { db } from '../db/client.js';
import { env } from '../config/env.js';
import { requireAdminAuth } from '../middleware/admin-auth.js';
import { signForm, verifyForm } from '../demo-engine/security.js';
import { adminLayout, escapeHtml as e } from '../utils/html.js';
import { object, string, uuid, WorkforceError } from '../workforce/shared.js';
import { CrmService } from './service.js';
import {
  crmLayout,
  entityForm,
  pipelineBoard,
  recordTable,
  timeline,
  type FormContext,
} from './views.js';
import { resource } from './validation.js';
import { memberAuth, workspacePrincipal } from '../workspace/auth.js';
import { tokenHash } from '../workforce/tenancy/service.js';
import { peerLimit } from '../integrations/rate-limit.js';

function createCrmRouter(member: boolean) {
  const crmAdminRouter = express.Router();
  const prefix = member ? '' : '/:organizationId';
  const rootFor = (req: express.Request) =>
    member ? '/workspace/crm' : `/admin/crm/${uuid(req.params.organizationId)}`;
  const canWrite = (res: express.Response, kind: string) => {
    if (!member) return true;
    const p = workspacePrincipal(res);
    return (
      p.scopes.includes('crm:write') &&
      p.role !== 'viewer' &&
      (!['pipelines', 'stages'].includes(kind) || ['owner', 'admin'].includes(p.role ?? ''))
    );
  };
  const secret = (req: express.Request) =>
    member ? tokenHash(req.header('authorization') ?? '') : env.ADMIN_PASSWORD!;
  const layout: typeof crmLayout = (org, active, title, body) =>
    crmLayout(org, active, title, body, member);
  crmAdminRouter.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    if (process.env.CRM_ENABLED !== 'true' || process.env.WORKFORCE_ENABLED !== 'true') {
      res.sendStatus(404);
      return;
    }
    next();
  });
  if (member) crmAdminRouter.use(peerLimit, memberAuth);
  else crmAdminRouter.use(requireAdminAuth);
  crmAdminRouter.use(express.urlencoded({ extended: false, limit: '32kb', parameterLimit: 150 }));
  crmAdminRouter.use((req, _res, next) => {
    if (
      req.method !== 'GET' &&
      !verifyForm(
        object(req.body).csrf,
        secret(req),
        req.header('authorization') ?? '',
        req.originalUrl.split('?')[0] ?? '',
      )
    )
      throw new WorkforceError(403, 'form_expired_or_invalid');
    next();
  });
  function service(req: express.Request, res: express.Response) {
    if (member) return new CrmService(db, workspacePrincipal(res));
    return new CrmService(db, {
      organizationId: uuid(req.params.organizationId),
      credentialId: 'platform-operator',
      actor: `platform_operator:${env.ADMIN_USERNAME}`,
      role: 'owner',
      scopes: ['crm:read', 'crm:write'],
    });
  }
  crmAdminRouter.get('/', async (_req, res) => {
    if (member) {
      res.redirect(302, '/workspace/crm/contacts');
      return;
    }
    const organizations = await db.organization.findMany({ orderBy: { name: 'asc' }, take: 100 });
    res.send(
      adminLayout(
        'CRM organizations',
        `<h1>Steel Scale CRM</h1><p>Choose the organization whose records you want to manage.</p><section class="panel">${organizations.length ? `<div class="table-wrap"><table><thead><tr><th>Organization</th><th>Workspace</th></tr></thead><tbody>${organizations.map((org) => `<tr><td>${e(org.name)}</td><td><a href="/admin/crm/${org.id}/contacts">Open CRM</a></td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No organizations have been provisioned yet.</p>'}</section>`,
      ),
    );
  });

  crmAdminRouter.get(`${prefix}/:view`, async (req, res) => {
    const crm = service(req, res);
    const view = req.params.view;
    if (!['contacts', 'opportunities', 'pipeline', 'pipelines'].includes(view))
      throw new WorkforceError(404, 'page_not_found');
    const org = await crm.organization();
    const root = rootFor(req);
    const [contacts, stages, pipelines, members, fields] = await Promise.all([
      crm.list('contacts'),
      crm.list('stages'),
      crm.list('pipelines'),
      crm.members(),
      crm.fields(),
    ]);
    const action = `${root}/${view}`;
    const formContext: FormContext = {
      organization: org,
      csrf: signForm(secret(req), req.header('authorization')!, action),
      action,
      contacts,
      stages,
      pipelines,
      members,
      fields,
    };
    if (view === 'pipeline') {
      const pipelineId =
        req.query.pipelineId === undefined ? pipelines[0]?.id : uuid(req.query.pipelineId);
      if (pipelineId) await crm.detail('pipelines', pipelineId);
      const opportunities = await crm.list('opportunities', pipelineId ? { pipelineId } : {});
      const pipelineStages = pipelineId ? await crm.list('stages', { pipelineId }) : stages;
      const heading = `<form method="get" class="crm-inline"><label>Pipeline<select name="pipelineId">${pipelines.map((p) => `<option value="${p.id}" ${p.id === pipelineId ? 'selected' : ''}>${e(String(p.name))}</option>`).join('')}</select></label><button>View pipeline</button></form><p>Open an opportunity to change its stage. Showing up to 100 opportunities.</p>`;
      res.send(
        layout(
          org,
          view,
          'Pipeline',
          pipelines.length
            ? heading +
                `<p>Imported records without a pipeline remain in <a href="${root}/opportunities">Opportunities</a>.</p>` +
                pipelineBoard(opportunities, pipelineStages, root)
            : '<section class="panel"><p class="empty">Create a pipeline and its stages in <a href="' +
                root +
                '/pipelines">Pipeline settings</a> to get started.</p></section>',
        ),
      );
      return;
    }
    const kind = view as 'contacts' | 'opportunities' | 'pipelines';
    const query = {
      search: req.query.search ? string(req.query.search, 100) : undefined,
      after: req.query.after ? uuid(req.query.after) : undefined,
    };
    const rows = await crm.list(kind, query);
    const title =
      kind === 'contacts'
        ? 'Contacts'
        : kind === 'opportunities'
          ? 'Opportunities'
          : 'Pipeline settings';
    const create =
      kind === 'opportunities' && (!contacts.length || !stages.length)
        ? '<p class="empty">Add a contact, pipeline and stage before creating an opportunity.</p>'
        : entityForm(kind, formContext);
    const more =
      rows.length === 100
        ? `<a href="${action}?after=${rows[99]!.id}${query.search ? `&amp;search=${encodeURIComponent(query.search)}` : ''}">Next 100 records</a>`
        : '';
    const createPanel = canWrite(res, kind)
      ? `<section class="panel"><details><summary class="crm-detail">Add ${kind === 'opportunities' ? 'opportunity' : kind === 'contacts' ? 'contact' : 'pipeline'}</summary>${create}</details></section>`
      : '<p class="notice">Read-only view. Ask an organization admin if you need editing access.</p>';
    res.send(
      layout(
        org,
        view,
        title,
        `${createPanel}<form method="get" class="crm-inline">${'<label>Search<input name="search" value="' + e(query.search ?? '') + '"></label>'}<button>Search</button></form><section class="panel">${recordTable(kind, rows, root, new Map(stages.map((s) => [s.id, String(s.name)])))}</section>${more}`,
      ),
    );
  });

  crmAdminRouter.get(`${prefix}/:resource/:id`, async (req, res) => {
    const kind = resource(req.params.resource);
    if (!['contacts', 'opportunities', 'pipelines', 'stages'].includes(kind))
      throw new WorkforceError(404, 'page_not_found');
    const crm = service(req, res);
    const id = uuid(req.params.id);
    const [org, detail, contacts, stages, pipelines, members, fields] = await Promise.all([
      crm.organization(),
      crm.detail(kind, id),
      crm.list('contacts'),
      crm.list('stages'),
      crm.list('pipelines'),
      crm.members(),
      crm.fields(),
    ]);
    const root = rootFor(req);
    const action = `${root}/${kind}/${id}`;
    const csrf = (path: string) => signForm(secret(req), req.header('authorization')!, path);
    const formContext: FormContext = {
      organization: org,
      action,
      csrf: csrf(action),
      contacts,
      stages,
      pipelines,
      members,
      fields,
      customValues: Object.fromEntries(detail.customFields.map((v) => [v.definitionId, v.value])),
    };
    let extra = '';
    if (kind === 'pipelines') {
      const stageAction = `${root}/stages`;
      const pipelineStages = await crm.list('stages', { pipelineId: id });
      extra = `<section class="panel"><h2 class="crm-detail">Stages</h2><div class="crm-detail">${
        pipelineStages
          .sort((a, b) => Number(a.position) - Number(b.position))
          .map(
            (s) =>
              `<p><a href="${root}/stages/${s.id}">${e(String(s.name))}</a> — ${e(String(s.outcome))}, position ${e(String(s.position))}</p>`,
          )
          .join('') || 'No stages yet.'
      }</div>${canWrite(res, 'stages') ? `<details><summary class="crm-detail">Add stage</summary>${entityForm('stages', { ...formContext, stages: pipelineStages, action: stageAction, csrf: csrf(stageAction), pipelines: [detail.entity] })}</details>` : ''}</section>`;
    }
    if (kind === 'contacts')
      extra += `<section class="panel"><h2 class="crm-detail">Opportunities</h2>${recordTable('opportunities', detail.opportunities, root, new Map(stages.map((s) => [s.id, String(s.name)])))}</section>`;
    if (kind === 'opportunities') {
      const contact = await crm.detail('contacts', String(detail.entity.customerId));
      extra += `<p>Contact: <a href="${root}/contacts/${contact.entity.id}">${e(String(contact.entity.name))}</a></p>`;
    }
    const noteAction = `${root}/${kind}/${id}/notes`;
    const archiveAction = `${root}/${kind}/${id}/archive`;
    const recordForm = canWrite(res, kind)
      ? entityForm(kind, formContext, detail.entity)
      : `<style>.crm-readonly{border:0;margin:0;min-width:0}.crm-readonly button{display:none}</style><fieldset class="crm-readonly" disabled><legend>Read-only record</legend>${entityForm(kind, formContext, detail.entity)}</fieldset>`;
    const notesForm = canWrite(res, 'notes')
      ? `<section class="panel"><h2 class="crm-detail">Add note</h2><form class="form-grid" method="post" action="${noteAction}"><input type="hidden" name="csrf" value="${e(csrf(noteAction))}"><label class="wide">Note<textarea name="body" required maxlength="10000"></textarea></label><button class="wide">Save note</button></form></section>`
      : '';
    const archiveForm = canWrite(res, kind)
      ? `<form method="post" action="${archiveAction}"><input type="hidden" name="csrf" value="${e(csrf(archiveAction))}"><input type="hidden" name="expectedVersion" value="${detail.entity.record.version}"><button class="danger">Archive record</button></form>`
      : '';
    res.send(
      layout(
        org,
        kind === 'stages' ? 'pipelines' : kind,
        String(detail.entity.name ?? detail.entity.title),
        `<div class="detail-grid"><div><section class="panel"><h2 class="crm-detail">Record details</h2>${recordForm}</section>${extra}${notesForm}${archiveForm}</div><section class="panel"><h2 class="crm-detail">Activity timeline</h2>${timeline(detail)}</section></div>`,
      ),
    );
  });

  async function formPayload(crm: CrmService, body: Record<string, unknown>) {
    const result = { ...body };
    delete result.csrf;
    if (result.stageSelection !== undefined) {
      const parts = string(result.stageSelection, 73).split(':');
      if (parts.length !== 2) throw new WorkforceError(400, 'choose_pipeline_stage');
      result.pipelineId = uuid(parts[0]);
      result.stageId = uuid(parts[1]);
      delete result.stageSelection;
    }
    for (const key of ['amountMinor', 'position', 'expectedVersion'])
      if (result[key] !== undefined) result[key] = Number(result[key]);
    for (const key of ['email', 'phone', 'description', 'assignedMemberId'])
      if (result[key] === '') result[key] = null;
    const definitions = await crm.fields();
    const values: Record<string, unknown> = {};
    for (const key of Object.keys(result).filter((key) => key.startsWith('custom_'))) {
      const id = key.slice(7);
      const field = definitions.find((f) => f.id === id);
      if (!field) throw new WorkforceError(400, 'custom_field_not_found');
      const raw = result[key];
      delete result[key];
      values[id] =
        raw === ''
          ? null
          : field.fieldType === 'boolean'
            ? raw === 'true'
            : field.fieldType === 'number'
              ? Number(raw)
              : field.fieldType === 'multi_select'
                ? String(raw)
                    .split(',')
                    .map((v) => v.trim())
                : raw;
    }
    if (Object.keys(values).length) result.customFields = values;
    return result;
  }
  crmAdminRouter.post(`${prefix}/:resource`, async (req, res) => {
    const kind = resource(req.params.resource);
    const crm = service(req, res);
    const row = await crm.create(kind, await formPayload(crm, object(req.body)));
    res.redirect(303, `${rootFor(req)}/${kind}/${row.id}`);
  });
  crmAdminRouter.post(`${prefix}/:resource/:id`, async (req, res) => {
    const kind = resource(req.params.resource);
    const crm = service(req, res);
    await crm.update(kind, uuid(req.params.id), await formPayload(crm, object(req.body)));
    res.redirect(303, `${rootFor(req)}/${kind}/${req.params.id}`);
  });
  crmAdminRouter.post(`${prefix}/:resource/:id/notes`, async (req, res) => {
    const crm = service(req, res);
    const kind = resource(req.params.resource);
    const id = uuid(req.params.id);
    await crm.detail(kind, id);
    await crm.create('notes', { relatedRecordId: id, body: object(req.body).body });
    res.redirect(303, `${rootFor(req)}/${kind}/${id}`);
  });
  crmAdminRouter.post(`${prefix}/:resource/:id/archive`, async (req, res) => {
    const crm = service(req, res);
    const kind = resource(req.params.resource);
    await crm.archive(kind, uuid(req.params.id), Number(object(req.body).expectedVersion));
    res.redirect(303, `${rootFor(req)}/${kind === 'stages' ? 'pipelines' : kind}`);
  });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const status =
      error instanceof WorkforceError
        ? error.status
        : error instanceof Prisma.PrismaClientKnownRequestError &&
            ['P2002', 'P2003'].includes(error.code)
          ? 409
          : 500;
    const code =
      error instanceof WorkforceError
        ? error.code.replaceAll('_', ' ')
        : status === 409
          ? 'A record with this identity already exists, or a related record is unavailable.'
          : 'The operation could not be completed.';
    res
      .status(status)
      .send(
        adminLayout(
          'CRM request',
          `<h1>Unable to complete this request</h1><p>${e(code)}</p><p>Nothing was saved. Refresh the record before retrying a version conflict.</p><p><a href="${member ? '/workspace/crm/contacts' : '/admin/crm'}">Return to CRM</a></p>`,
          member,
        ),
      );
  };
  crmAdminRouter.use(errors);
  return crmAdminRouter;
}

export const crmAdminRouter = createCrmRouter(false);
export const memberCrmRouter = createCrmRouter(true);
