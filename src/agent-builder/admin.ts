import express from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { db } from '../db/client.js';
import { workspaceLayout as adminLayout, escapeHtml as e } from '../utils/html.js';
import { authenticate, tokenHash, type Principal } from '../workforce/tenancy/service.js';
import { signForm, verifyForm } from '../demo-engine/security.js';
import { object, WorkforceError } from '../workforce/shared.js';
import { enabled } from '../integrations/http.js';
import { organizationLimit, peerLimit } from '../integrations/rate-limit.js';
import { authorizeCurrent } from '../agents/service.js';
import { tenantTransaction } from '../workforce/shared.js';
import { eventTypes } from '../events/contracts.js';
import { subjectTypes, toolNames } from '../agents/contracts.js';
import { builderEnabled } from './http.js';
import { BlueprintService } from './service.js';
import {
  actions,
  blankBlueprint,
  channels,
  conditions,
  escalationConditions,
  goals,
  operators,
  routes,
  stops,
} from './blueprint.js';
import { formBlueprint } from './form.js';

const label = (s: string) =>
  s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .replaceAll('.', ' · ');
const input = (name: string, title: string, value: unknown, type = 'text') =>
  `<label>${e(title)}<input name="${e(name)}" type="${type}" value="${e(typeof value === 'string' || typeof value === 'number' ? value : '')}"${type === 'number' ? ' step="any"' : ''}></label>`;
const area = (name: string, title: string, value: unknown) =>
  `<label>${e(title)}<textarea name="${e(name)}">${e(typeof value === 'string' ? value : '')}</textarea></label>`;
const select = (name: string, title: string, value: unknown, values: readonly string[]) =>
  `<label>${e(title)}<select name="${e(name)}"><option value="">Not specified</option>${values.map((v) => `<option value="${e(v)}"${v === value ? ' selected' : ''}>${e(label(v))}</option>`).join('')}</select></label>`;
const checks = (
  name: string,
  title: string,
  selected: readonly string[],
  values: readonly string[],
) =>
  `<fieldset class="builder-checks"><legend>${e(title)}</legend>${values.map((v) => `<label><input type="checkbox" name="${e(name)}" value="${e(v)}"${selected.includes(v) ? ' checked' : ''}>${e(label(v))}</label>`).join('')}</fieldset>`;
const css = `<style>.builder-shell{max-width:1200px}.builder-layout{display:grid;grid-template-columns:minmax(0,2fr) minmax(260px,1fr);gap:22px}.builder-main,.builder-aside{min-width:0}.builder-pad{padding:20px}.builder-intro{max-width:75ch;margin:10px 0 22px}.builder-section{padding:20px;border:0;border-bottom:1px solid var(--line);margin:0}.builder-section h2{margin-bottom:12px}.builder-fields{display:grid;grid-template-columns:1fr 1fr;gap:14px}.builder-fields>*{min-width:0}.builder-fields textarea{min-height:90px}.builder-checks{border:1px solid var(--line);padding:12px;margin:10px 0;display:grid;grid-template-columns:1fr 1fr;gap:8px}.builder-checks legend{font-weight:700}.builder-checks label,.builder-check{display:flex;align-items:flex-start;gap:8px;font-weight:400}.builder-checks input,.builder-check input{width:auto;margin:4px 0}.builder-item{padding:14px 0;border-top:1px solid var(--line)}.builder-item:first-of-type{border-top:0}.builder-summary{color:var(--navy);font-weight:650;margin:8px 0 14px}.builder-aside li{margin:9px 0}.builder-aside ul{padding-left:20px}.builder-aside .panel{margin-top:0;margin-bottom:18px}.builder-requirements{border-left:4px solid var(--warn)}.builder-ready{border-left:4px solid var(--ok)}.builder-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:15px}.builder-history{font-size:13px}.builder-history li{padding:10px 0;overflow-wrap:anywhere}.builder-source{white-space:pre-wrap;overflow-wrap:anywhere;margin:10px 0;color:var(--steel)}.builder-result{white-space:pre-wrap;overflow-wrap:anywhere;font:13px system-ui}.builder-shell button:disabled{opacity:.5;cursor:not-allowed}.builder-shell textarea:focus-visible{outline:3px solid #f59e0b;outline-offset:2px}.builder-note{margin:8px 0 14px}#unsaved{display:none}.builder-shell [data-dirty=true]~* #unsaved{display:block}@media(max-width:850px){.builder-layout{grid-template-columns:1fr}.builder-aside{order:-1}.builder-fields{grid-template-columns:1fr}}@media(max-width:480px){.builder-checks{grid-template-columns:1fr}.topbar>div{flex-wrap:wrap;gap:8px;padding:12px 0}.topbar nav{overflow-wrap:anywhere}}</style>`;
export const builderAdminRouter = express.Router();
builderAdminRouter.use(enabled, builderEnabled, peerLimit);
builderAdminRouter.use(async (req, res, next) => {
  let authorization = req.header('authorization');
  if (authorization?.startsWith('Basic ')) {
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    authorization = `Bearer ${decoded.slice(decoded.indexOf(':') + 1)}`;
  }
  try {
    const principal = await authenticate(db, authorization);
    await organizationLimit(db, principal.organizationId);
    await tenantTransaction(db, principal.organizationId, (tx) =>
      authorizeCurrent(tx, principal, 'agents:write'),
    );
    res.locals.principal = principal;
  } catch (error) {
    if (error instanceof WorkforceError && error.status === 401)
      res.setHeader(
        'WWW-Authenticate',
        'Basic realm="Steel Scale Agent Builder (member API key)", charset="UTF-8"',
      );
    throw error;
  }
  const nonce = randomBytes(16).toString('base64');
  res.locals.nonce = nonce;
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  );
  next();
});
builderAdminRouter.use(express.urlencoded({ extended: false, limit: '64kb', parameterLimit: 600 }));
builderAdminRouter.use((req, _res, next) => {
  const authorization = req.header('authorization') ?? '';
  if (
    req.method !== 'GET' &&
    !verifyForm(
      object(req.body).csrf,
      tokenHash(authorization),
      authorization,
      req.originalUrl.split('?')[0]!,
    )
  )
    throw new WorkforceError(403, 'form_expired_or_invalid');
  next();
});
const service = (locals: Record<string, unknown>) =>
  new BlueprintService(db, locals.principal as Principal);
const csrf = (req: express.Request, path: string) =>
  `<input type="hidden" name="csrf" value="${e(signForm(tokenHash(req.header('authorization')!), req.header('authorization')!, path))}">`;
const hidden = (name: string, value: string | number) =>
  `<input type="hidden" name="${e(name)}" value="${e(value)}">`;
builderAdminRouter.get('/', async (req, res) => {
  const rows = await service(res.locals).list(),
    root = req.baseUrl;
  res.send(
    adminLayout(
      'Agent Builder',
      `${css}<div class="builder-shell"><h1>Build an AI employee</h1><p class="builder-intro">Describe the work, boundaries and when a person should step in. Steel Scale proposes a structured draft. Nothing runs until you review, test and activate it.</p><section class="panel builder-pad"><form method="post" action="${root}/generate">${csrf(req, root + '/generate')}${hidden('requestKey', randomUUID())}${area('description', 'What should this agent do?', '')}<p class="builder-note">Example: Follow up with estimates over $2,500 after two days. Do not offer discounts. Route price negotiation to the assigned salesperson.</p><p>No customer records or secrets are needed. Your description is sent to the configured AI provider only when you generate a draft.</p><div class="builder-actions"><button${process.env.AGENT_BUILDER_AI_ENABLED === 'true' ? '' : ' disabled'}>Generate blueprint</button></div>${process.env.AGENT_BUILDER_AI_ENABLED === 'true' ? '' : '<p class="notice">AI drafting is disabled. An operator must configure an approved builder model; you can still create and edit a draft manually.</p>'}</form><form method="post" action="${root}/draft">${csrf(req, root + '/draft')}<div class="builder-actions"><button class="secondary">Start empty draft</button></div></form></section><section class="panel builder-pad"><h2>Your blueprints</h2>${rows.length ? `<ul>${rows.map((r) => `<li><a href="${root}/${r.id}">${e(r.name)}</a> — draft version ${r.currentVersion}${r.agent?.enabled ? ' · runtime agent enabled' : ''}</li>`).join('')}</ul>` : '<p>No blueprints yet. Start with the work you want the agent to handle.</p>'}</section></div>`,
    ),
  );
});
builderAdminRouter.post('/draft', async (req, res) => {
  const v = await service(res.locals).save({ specification: blankBlueprint() });
  res.redirect(303, `${req.baseUrl}/${v.blueprintId}`);
});
builderAdminRouter.post('/generate', async (req, res) => {
  const b = object(req.body);
  const v = await service(res.locals).generate({
    description: b.description,
    requestKey: b.requestKey,
    ...(b.blueprintId
      ? { blueprintId: b.blueprintId, expectedVersion: Number(b.expectedVersion) }
      : {}),
  });
  res.redirect(303, `${req.baseUrl}/${v.blueprintId}`);
});
builderAdminRouter.get('/:id', async (req, res) => {
  const state = await service(res.locals).detail(
      String(req.params.id),
      req.query.version === undefined ? undefined : Number(req.query.version),
    ),
    b = state.specification;
  const root = req.baseUrl,
    path = `${root}/${state.blueprint.id}`,
    current = state.version.number === state.blueprint.currentVersion;
  const section = (title: string, content: string) =>
    `<section class="builder-section"><h2>${e(title)}</h2>${content}</section>`;
  const conditionRows = [
    ...b.triggerConditions,
    { field: '', operator: '', value: null, number: null, values: [] },
  ]
    .map(
      (c, i) =>
        `<div class="builder-item"><p class="builder-summary">${c.field ? e(`${label(c.field)} ${c.operator} ${c.field === 'amount_minor' && c.number !== null ? (c.number / 100).toFixed(2) : (c.number ?? c.value ?? c.values.join(', '))}`) : 'Add a condition (optional)'}</p><div class="builder-fields">${select(`condition_${i}_field`, 'Field', c.field, conditions)}${select(`condition_${i}_operator`, 'Comparison', c.operator, operators)}${input(`condition_${i}_number`, 'Number (amounts use major units, e.g. 2500.00)', c.field === 'amount_minor' && c.number !== null ? (c.number / 100).toFixed(2) : c.number, 'number')}${input(`condition_${i}_value`, 'Single status or text value', c.value)}${input(`condition_${i}_values`, 'Status values (comma separated)', c.values.join(', '))}</div>${c.field ? `<label class="builder-check"><input type="checkbox" name="condition_${i}_remove" value="true">Remove condition</label>` : ''}</div>`,
    )
    .join('');
  const escalationRows = [...b.escalationRules, { condition: '', route: null, memberId: null }]
    .map(
      (r, i) =>
        `<div class="builder-item"><div class="builder-fields">${select(`escalation_${i}_condition`, 'Escalate when', r.condition, escalationConditions)}${select(`escalation_${i}_route`, 'Route to', r.route, routes)}${input(`escalation_${i}_memberId`, 'Selected employee membership ID (if applicable)', r.memberId)}</div>${r.condition ? `<label class="builder-check"><input type="checkbox" name="escalation_${i}_remove" value="true">Remove escalation</label>` : ''}</div>`,
    )
    .join('');
  const knowledgeRows = [...b.knowledgeRequirements, { name: '', content: null, approved: false }]
    .map(
      (k, i) =>
        `<div class="builder-item">${input(`knowledge_${i}_name`, 'Knowledge needed', k.name)}${area(`knowledge_${i}_content`, 'Approved business facts or instructions', k.content)}<label class="builder-check"><input type="checkbox" name="knowledge_${i}_approved" value="true"${k.approved ? ' checked' : ''}>I verified this knowledge for the agent</label>${k.name ? `<label class="builder-check"><input type="checkbox" name="knowledge_${i}_remove" value="true">Remove knowledge item</label>` : ''}</div>`,
    )
    .join('');
  const form = `<form id="blueprint-editor" class="panel" method="post" action="${path}/save">${csrf(req, path + '/save')}${hidden('expectedVersion', state.version.number)}<fieldset style="padding:0;border:0;margin:0"${current ? '' : ' disabled'}>
    ${section('Objective', `${input('name', 'Agent name', b.name)}${area('objective', 'What outcome should this agent pursue?', b.objective)}${area('businessContext', 'Business context (not the original prompt)', b.businessContext)}${area('communicationStyle', 'Communication style', b.communicationStyle)}`)}
    ${section('Trigger', `<p class="builder-summary">${e(b.triggerEvent ? `${label(b.triggerEvent)}${b.delayMinutes ? ` after ${b.delayMinutes} minutes` : ''}` : 'Trigger needs configuration')}</p><div class="builder-fields">${select('triggerEvent', 'Canonical business event', b.triggerEvent, eventTypes)}${input('delayMinutes', 'Delay in minutes (0 means immediate)', b.delayMinutes, 'number')}</div>`)}
    ${section('Eligibility', `${checks('eligibleEntityTypes', 'Eligible records', b.eligibleEntityTypes, subjectTypes)}${input('currency', 'Threshold currency (ISO code, such as USD)', b.currency)}${conditionRows}<p class="builder-note">Conditions are ANDed. Use one “in” status condition for alternatives. Add items in the empty row, then save to add another.</p>`)}
    ${section('AI may', `${checks('allowedActions', 'Allowed actions', b.allowedActions, actions)}${checks('automaticActions', 'Explicit automatic permissions (Autopilot only)', b.automaticActions, toolNames)}<p>Checked items describe your intended permissions. The readiness checklist identifies unavailable tools.</p>`)}
    ${section('AI may not', checks('prohibitedActions', 'Prohibited actions', b.prohibitedActions, actions))}
    ${section('Escalate to a person', `${escalationRows}<p>Run review is the existing audit/review surface, not automatic employee paging.</p>`)}
    ${section('Follow-up and communication', `<div class="builder-fields">${select('cadenceEnabled', 'Repeat follow-ups?', b.cadence.enabled === null ? null : String(b.cadence.enabled), ['true', 'false'])}${input('cadenceInterval', 'Interval between follow-ups (minutes)', b.cadence.intervalMinutes, 'number')}${input('maximumAttempts', 'Maximum action proposals', b.cadence.maximumAttempts, 'number')}</div>${checks('communicationChannels', 'Communication channels', b.communicationChannels, channels)}`)}
    ${section('Goal and stop conditions', `${select('goalKind', 'Success criterion', b.successCriteria.kind, goals)}${area('goalDescription', 'Evidence of success', b.successCriteria.description)}${checks('stopConditions', 'Stop conditions', b.stopConditions, stops)}`)}
    ${section('Operating hours', `<div class="builder-fields">${input('timezone', 'Timezone (IANA, such as America/New_York)', b.operatingHours?.timezone)}${input('startHour', 'Start hour (0–23)', b.operatingHours?.startHour, 'number')}${input('endHour', 'End hour (1–24)', b.operatingHours?.endHour, 'number')}</div>${checks('days', 'Days (0 Sunday, 1 Monday … 6 Saturday)', b.operatingHours?.days.map(String) ?? [], ['0', '1', '2', '3', '4', '5', '6'])}`)}
    ${section('Knowledge requirements', knowledgeRows)}
    ${section(
      'Execution and review',
      `<div class="builder-fields">${select('mode', 'Execution mode', b.mode, ['ADVISORY', 'COPILOT', 'AUTOPILOT'])}${select('humanApprovalMode', 'Human approval policy', b.humanApprovalMode, ['all_mutations', 'sensitive_only'])}${select(
        'runtimeModel',
        'Approved runtime model',
        b.runtimeModel,
        [
          ...new Set([
            ...(process.env.AGENT_ALLOWED_MODELS ?? '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
            ...(b.runtimeModel ? [b.runtimeModel] : []),
          ]),
        ],
      )}</div><p>Compiled safety limits: 5 steps, at most 3 actions, 5-minute run window and 20 runs/day. Contact details and message bodies are excluded from model context.</p>`,
    )}
    ${section('Unanswered configuration', `${area('missingConfiguration', 'Questions to resolve (one per line)', b.missingConfiguration.join('\n'))}${area('unsupportedRequests', 'Requests not mapped to capabilities (one per line)', b.unsupportedRequests.join('\n'))}<p>Removing these notes does not remove the independent readiness checks.</p>`)}
    <div class="builder-pad"><button>Save Draft</button><p>Saving adds an immutable version. It does not change a previously activated agent.</p></div></fieldset></form>`;
  const testForm = `<form method="post" action="${path}/test">${csrf(req, path + '/test')}${hidden('expectedVersion', state.version.number)}${select('entityType', 'Fictional record type', b.eligibleEntityTypes[0] ?? 'contact', subjectTypes)}${input('status', 'Fictional status', 'open')}${input('inactiveDays', 'Inactive days', 0, 'number')}<label class="builder-check"><input type="checkbox" name="suppressed" value="true">Contact is opted out</label><div class="builder-actions"><button data-saved-action${current ? '' : ' disabled'}>Test Agent</button></div><p>Checks saved-version eligibility and policy only. No model run, message, booking or CRM changes.</p></form>`;
  const canActivate =
    current && !state.compilation.requirements.length && !state.version.activatedAt;
  const activation = `<form method="post" action="${path}/activate">${csrf(req, path + '/activate')}${hidden('expectedVersion', state.version.number)}${hidden('specificationHash', state.version.specificationHash)}${hidden('expectedAgentVersion', state.blueprint.agent?.configVersion ?? 0)}<label class="builder-check"><input type="checkbox" name="reviewed" value="true" required>I reviewed the original request and every item in saved version ${state.version.number}, including permissions and safety limits.</label><div class="builder-actions"><button data-saved-action${canActivate ? '' : ' disabled'}>Activate Agent</button></div><p>Requires a successful configuration test of this exact version. Activation uses the existing Agent Runtime and Policy Engine.</p></form>`;
  res.send(
    adminLayout(
      'Review agent blueprint',
      `${css}<div class="builder-shell"><p><a href="${root}">Agent Builder</a></p><h1>${e(b.name ?? 'Untitled agent')}</h1><p class="builder-intro">Reviewing saved version ${state.version.number} · ${e(state.version.origin === 'ai' ? 'AI-proposed draft' : 'Owner-edited draft')}. ${state.version.activatedAt ? 'This version was activated.' : current ? 'Draft only; not activated.' : 'Historical version — read only.'} ${state.blueprint.agent?.enabled ? 'An existing runtime version is enabled; draft edits do not change it.' : ''}</p><div class="notice" id="unsaved" role="status">Unsaved changes. Save Draft before testing or activating.</div><div class="builder-layout"><div class="builder-main">${form}</div><aside class="builder-aside"><section class="panel builder-pad ${state.compilation.requirements.length ? 'builder-requirements' : 'builder-ready'}"><h2>${state.compilation.requirements.length ? 'Configuration required' : 'Ready for a configuration test'}</h2>${state.compilation.requirements.length ? `<ul>${state.compilation.requirements.map((r) => `<li><strong>${e(label(r.field))}</strong><br>${e(r.message)}</li>`).join('')}</ul>` : '<p>All requested settings have supported runtime mappings. Review and test before activation.</p>'}</section><section class="panel builder-pad"><h2>Test the saved draft</h2>${testForm}${state.tests.map((t) => `<details><summary>Test ${e(t.createdAt.toISOString())}</summary><pre class="builder-result">${e(JSON.stringify(t.report, null, 2))}</pre></details>`).join('')}</section><section class="panel builder-pad"><h2>Review and activate</h2>${activation}</section><section class="panel builder-pad"><h2>Original request</h2><p class="builder-source">${e(state.version.sourceText ?? 'Manually created draft; no source prompt.')}</p><small>Retained for review, never used directly as the production system prompt.</small></section><section class="panel builder-pad builder-history"><h2>Version history</h2><ul>${state.history.map((v) => `<li><a href="${path}?version=${v.number}">Version ${v.number}</a> · ${e(v.origin)}${v.activatedAt ? ' · activated' : ''}<br>${e(v.createdAt.toISOString())}<br>Changed: ${e(v.changedFields.map(label).join(', '))}</li>`).join('')}</ul>${!current ? `<a href="${path}">Return to current draft</a>` : ''}</section></aside></div><noscript><p>Save all edits before testing or activating. Those actions apply only to the saved version, not unsaved form values.</p></noscript></div><script nonce="${e(String(res.locals.nonce))}">document.getElementById('blueprint-editor').addEventListener('input',function(){document.getElementById('unsaved').style.display='block';document.querySelectorAll('[data-saved-action]').forEach(function(button){button.disabled=true;});});</script>`,
    ),
  );
});
builderAdminRouter.post('/:id/save', async (req, res) => {
  const b = object(req.body);
  await service(res.locals).save(
    { specification: formBlueprint(b), expectedVersion: Number(b.expectedVersion) },
    String(req.params.id),
  );
  res.redirect(303, `${req.baseUrl}/${String(req.params.id)}`);
});
builderAdminRouter.post('/:id/test', async (req, res) => {
  const b = object(req.body);
  await service(res.locals).test(String(req.params.id), {
    expectedVersion: Number(b.expectedVersion),
    scenario: {
      entityType: b.entityType,
      status: b.status,
      inactiveDays: Number(b.inactiveDays),
      suppressed: b.suppressed === 'true',
    },
  });
  res.redirect(303, `${req.baseUrl}/${String(req.params.id)}`);
});
builderAdminRouter.post('/:id/activate', async (req, res) => {
  const b = object(req.body);
  await service(res.locals).activate(String(req.params.id), {
    expectedVersion: Number(b.expectedVersion),
    specificationHash: b.specificationHash,
    expectedAgentVersion: Number(b.expectedAgentVersion),
    reviewed: b.reviewed === 'true',
  });
  res.redirect(303, `${req.baseUrl}/${String(req.params.id)}`);
});
builderAdminRouter.use(((error: unknown, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const parserStatus =
    error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
  const status =
    error instanceof WorkforceError
      ? error.status
      : [400, 413].includes(parserStatus)
        ? parserStatus
        : 500;
  if (status === 429) res.setHeader('Retry-After', '60');
  const code = error instanceof WorkforceError ? error.code : 'invalid_builder_request';
  res
    .status(status)
    .send(
      adminLayout(
        'Agent Builder needs attention',
        `${css}<h1>Agent Builder needs attention</h1><p class="notice error">${e(code)}</p><p>No unsafe activation was performed. Return to the draft, refresh its version, and resolve the displayed requirements.</p><p><a href="${e(req.baseUrl || '/agent-builder')}">Return to Agent Builder</a></p>`,
      ),
    );
}) as express.ErrorRequestHandler);
