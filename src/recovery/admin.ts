import express from 'express';
import { randomUUID } from 'node:crypto';
import { db } from '../db/client.js';
import { workspaceLayout as adminLayout, escapeHtml as e } from '../utils/html.js';
import { authenticate, tokenHash, type Principal } from '../workforce/tenancy/service.js';
import { signForm, verifyForm } from '../demo-engine/security.js';
import { enabled } from '../integrations/http.js';
import { organizationLimit, peerLimit } from '../integrations/rate-limit.js';
import { object, WorkforceError } from '../workforce/shared.js';
import { recoveryEnabled } from './http.js';
import { RecoveryService } from './service.js';
import { RecoveryDashboardService } from './dashboard.js';
import { RecoveryHandoffService } from './handoffs.js';
import { RecoverySimulationService } from './simulation.js';
import { RecoveryAttributionService, attributionStatuses } from './attribution.js';
import { exampleConfig } from './contracts.js';
import { recoveryScenarios, safeState } from './scenarios.js';
import { decideApproval } from '../agents/approvals.js';

export const recoveryAdminRouter = express.Router();
recoveryAdminRouter.use(enabled, recoveryEnabled, peerLimit);
recoveryAdminRouter.use(async (req, res, next) => {
  let authorization = req.header('authorization');
  if (authorization?.startsWith('Basic ')) {
    const text = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    authorization = `Bearer ${text.slice(text.indexOf(':') + 1)}`;
  }
  try {
    const p = await authenticate(db, authorization);
    await organizationLimit(db, p.organizationId);
    await new RecoveryService(db, p).tx(() => Promise.resolve(true), 'crm:read');
    res.locals.principal = p;
  } catch (error) {
    if (error instanceof WorkforceError && error.status === 401)
      res.setHeader(
        'WWW-Authenticate',
        'Basic realm="Steel Scale Revenue Recovery (member API key)"',
      );
    throw error;
  }
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  next();
});
recoveryAdminRouter.use(
  express.urlencoded({ extended: false, limit: '64kb', parameterLimit: 100 }),
);
recoveryAdminRouter.use((req, _res, next) => {
  const auth = req.header('authorization') ?? '';
  if (
    req.method !== 'GET' &&
    !verifyForm(object(req.body).csrf, tokenHash(auth), auth, req.originalUrl.split('?')[0]!)
  )
    throw new WorkforceError(403, 'form_expired_or_invalid');
  next();
});
const principal = (res: express.Response) => res.locals.principal as Principal;
const display = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const csrf = (req: express.Request, path: string) =>
  `<input type="hidden" name="csrf" value="${e(signForm(tokenHash(req.header('authorization')!), req.header('authorization')!, path))}">`;
const hidden = (name: string, value: unknown) =>
  `<input type="hidden" name="${e(name)}" value="${e(String(value))}">`;
const input = (name: string, label: string, value: unknown = '') =>
  `<label>${e(label)}<input name="${e(name)}" value="${e(display(value))}"></label>`;
const area = (name: string, label: string, value: unknown = '') =>
  `<label>${e(label)}<textarea name="${e(name)}" rows="5">${e(display(value))}</textarea></label>`;
const money = (minor: number, currency: string) =>
  `${e(currency)} ${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const label = (text: string) => text.replaceAll('_', ' ').replaceAll('.', ' · ');
const css = `<style>.recovery-shell{max-width:1200px}.recovery-intro{max-width:76ch;margin:10px 0 24px}.recovery-layout{display:grid;grid-template-columns:minmax(0,2fr) minmax(250px,1fr);gap:24px}.recovery-layout>*{min-width:0}.recovery-panel{padding:20px}.recovery-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line);margin:20px 0}.recovery-metric{padding:16px;background:white;min-width:0}.recovery-metric dt{font-size:13px;color:var(--steel)}.recovery-metric dd{font-size:22px;font-weight:700;margin:10px 0 0;color:var(--navy)}.recovery-table{overflow-x:auto}.recovery-table table{min-width:620px}.recovery-note{color:var(--steel);font-size:13px}.recovery-actions{display:flex;gap:8px;flex-wrap:wrap;margin:15px 0}.recovery-source{white-space:pre-wrap;overflow-wrap:anywhere}.recovery-activity{padding-left:20px}.recovery-activity li{margin:12px 0;overflow-wrap:anywhere}.recovery-shell details{margin:16px 0}.recovery-shell summary{cursor:pointer;font-weight:650}.recovery-shell label{margin:10px 0}.recovery-shell textarea{font:14px/1.5 system-ui;resize:vertical}.recovery-shell input[type=checkbox]{width:auto}.recovery-fields{display:grid;grid-template-columns:1fr 1fr;gap:15px}.recovery-shell button:focus-visible,.recovery-shell input:focus-visible,.recovery-shell textarea:focus-visible{outline:3px solid #f59e0b;outline-offset:2px}@media(max-width:850px){.recovery-layout{grid-template-columns:1fr}.recovery-metrics{grid-template-columns:1fr 1fr}}@media(max-width:480px){.recovery-fields{grid-template-columns:1fr}.topbar>div{flex-wrap:wrap;gap:8px;padding:12px}.topbar nav{overflow-wrap:anywhere}.recovery-metric dd{font-size:19px}}</style>`;
function parsed(text: unknown): unknown {
  try {
    return JSON.parse(String(text)) as unknown;
  } catch {
    throw new WorkforceError(400, 'invalid_configuration_json');
  }
}
recoveryAdminRouter.get('/', async (req, res) => {
  const p = principal(res),
    data = await new RecoveryDashboardService(db, p).dashboard(),
    root = req.baseUrl,
    m = data.metrics;
  const admin = ['owner', 'admin'].includes(p.role ?? '');
  const metric = (name: string, value: string | number) =>
    `<div class="recovery-metric"><dt>${e(name)}</dt><dd>${value}</dd></div>`;
  const cases = await new RecoveryService(db, p).tx(
    (tx, organizationId) =>
      tx.recoveryCase.findMany({
        where: { organizationId },
        include: { opportunity: { select: { title: true } }, contact: { select: { name: true } } },
        orderBy: { updatedAt: 'desc' },
        take: 50,
      }),
    'crm:read',
  );
  const approvalRows = [];
  for (const a of data.approvals) {
    const id = object(a.action.input).text;
    const decision =
      typeof id === 'string'
        ? await db.recoveryDecision.findFirst({ where: { organizationId: p.organizationId, id } })
        : null;
    approvalRows.push(
      `<section class="panel recovery-panel"><h3>Review follow-up</h3><p class="recovery-source">${e(decision ? display(object(decision.decision).message_if_allowed ?? 'No approved text') : 'Decision unavailable')}</p><p><a href="${root}/cases/${decision?.caseId ?? ''}">Inspect opportunity context</a></p><form method="post" action="${root}/approvals/${a.id}">${csrf(req, `${root}/approvals/${a.id}`)}${input('reason', 'Review reason')}<div class="recovery-actions"><button name="decision" value="approve">Approve exact message</button><button class="secondary" name="decision" value="reject">Reject</button></div></form></section>`,
    );
  }
  res.send(
    adminLayout(
      'Revenue Recovery',
      `${css}<div class="recovery-shell"><h1>Revenue Recovery</h1><p class="recovery-intro">Work unsold opportunities without losing control of the conversation. Customer replies pause automated follow-up. Revenue below requires reviewed evidence—not just an AI touch.</p><p>${data.program?.agent.enabled ? 'Recovery agent enabled' : 'Recovery agent disabled'} · ${process.env.REVENUE_RECOVERY_DELIVERY_ENABLED === 'true' ? 'Delivery adapter claims enabled' : 'Live delivery disabled'}</p><dl class="recovery-metrics">${metric('Unsold Pipeline', m.unsoldPipeline.map((v) => `${v._count} · ${money(v._sum.amountMinor ?? 0, v.currency)}`).join('<br>') || '0')}${metric('Currently Being Worked', m.currentlyWorked)}${metric('Responses Generated', m.responsesGenerated)}${metric('Contacts Engaged', m.contactsEngaged)}${metric('Appointments Recovered', m.appointmentsRecovered)}${metric('Deals Recovered', m.dealsRecovered)}${metric('Recovered Revenue', m.recoveredRevenue.map((v) => money(v.amountMinor, v.currency)).join('<br>') || '0')}${metric('Needs Human Attention', m.needsHumanAttention)}</dl><p class="recovery-note">${m.monitoredPipeline.map((v) => `${v._count} opportunities monitored (${money(v._sum.monitoredValueMinor ?? 0, v.currency)} at enrollment)`).join('; ') || 'No monitored opportunities yet.'} Responses are inbound messages after confirmed AI delivery; recovered revenue is reviewed payment evidence. Currencies are never combined.</p><div class="recovery-layout"><div><section class="panel recovery-panel"><h2>Needs human attention</h2><p>Showing up to 50 recent handoffs. Taking over pauses AI for the contact's tracked opportunities.</p><div class="recovery-table"><table><thead><tr><th>Customer / opportunity</th><th>Value</th><th>Reason / employee</th><th>Review</th></tr></thead><tbody>${data.handoffs.map((h) => `<tr><td>${e(h.case.contact.name)}<br>${e(h.case.opportunity.title)}</td><td>${money(h.case.opportunity.amountMinor, h.case.opportunity.currency)}</td><td>${e(label(h.reason))}<br>${e(h.assignedMember?.displayName ?? 'Unassigned')}</td><td><a href="${root}/cases/${h.caseId}">Open handoff</a></td></tr>`).join('') || '<tr><td colspan="4">No open handoffs. Replies and delivery problems will appear here.</td></tr>'}</tbody></table></div></section>${admin ? approvalRows.join('') : ''}<section class="panel recovery-panel"><h2>Monitored opportunities</h2><ul>${cases.map((c) => `<li><a href="${root}/cases/${c.id}">${e(c.contact.name)} — ${e(c.opportunity.title)}</a> · ${e(label(c.state))} · ${c.attempts} attempts</li>`).join('') || '<li>No cases yet. Configure and enable recovery, then enroll an eligible opportunity or let the scheduler evaluate your pipeline.</li>'}</ul></section><section class="panel recovery-panel"><h2>Simulation lab</h2><p>Try ${recoveryScenarios.length} seeded fictional scenarios. No customer record, agent run or communication is created.</p><form method="post" action="${root}/simulate">${csrf(req, root + '/simulate')}<label>Scenario<select aria-label="Scenario" name="scenarioKey">${recoveryScenarios.map((s) => `<option value="${s.key}">${e(s.business)}: ${e(s.key)}</option>`).join('')}</select></label><button>Run simulation</button></form><details><summary>Try a custom fictional message</summary><form method="post" action="${root}/simulate">${csrf(req, root + '/simulate')}${area('message', 'Fake customer message')}${area('state', 'Fake safety state (JSON)', JSON.stringify(safeState, null, 2))}<button>Test fake message</button></form></details>${data.simulations.map((s) => `<details><summary>${e(s.scenarioKey ?? 'Custom scenario')} · ${e(s.createdAt.toISOString())}</summary><pre class="recovery-source">${e(JSON.stringify(s.result, null, 2))}</pre></details>`).join('')}</section></div><aside><section class="panel recovery-panel"><h2>Recent agent activity</h2><ol class="recovery-activity">${data.activity.map((a) => `<li>${e(label(a.type))}<br><small>${e(a.createdAt.toISOString())}</small></li>`).join('') || '<li>No recovery activity yet.</li>'}</ol></section><section class="panel recovery-panel"><h2>Delivery attention</h2><ul>${data.dispatchErrors.map((d) => `<li><a href="${root}/cases/${d.caseId}">${e(label(d.status))}</a>: ${e(label(d.errorCode ?? 'review required'))}</li>`).join('') || '<li>No recorded delivery errors.</li>'}</ul></section></aside></div>${admin ? `<details class="panel recovery-panel"><summary>Recovery configuration and consent</summary><p>Configuration is versioned with the generic runtime. Save disables the agent and pauses existing work. Confirm hours, currency, rules and every knowledge entry before enabling. All customer messages still require human approval in this release.</p><form method="post" action="${root}/configure">${csrf(req, root + '/configure')}${hidden('expectedVersion', data.program?.runtimeVersion.number ?? 0)}${area('config', 'Structured recovery rules', JSON.stringify(data.program?.runtimeVersion.specialization ?? exampleConfig(), null, 2))}${input('connectionId', 'Optional delivery connection ID', data.program?.connectionId ?? '')}<label><input type="checkbox" name="reviewed" value="true" required> I reviewed the rules and approved knowledge.</label><button>Save recovery configuration</button></form>${data.program ? `<form method="post" action="${root}/enable">${csrf(req, root + '/enable')}<div class="recovery-actions"><button name="enabled" value="true">Enable recovery</button><button class="secondary" name="enabled" value="false">Disable recovery</button></div></form>` : ''}<form method="post" action="${root}/consent">${csrf(req, root + '/consent')}${input('contactId', 'Contact ID')}<label>Channel<select name="channel"><option>sms</option><option>email</option></select></label>${area('evidence', 'Consent evidence (source and scope)')}<div class="recovery-actions"><button name="granted" value="true">Record permission</button><button class="secondary" name="granted" value="false">Revoke permission</button></div></form><form method="post" action="${root}/enroll">${csrf(req, root + '/enroll')}${input('opportunityId', 'Opportunity ID')}<button>Monitor opportunity</button></form></details>` : ''}</div>`,
    ),
  );
});
recoveryAdminRouter.get('/cases/:id', async (req, res) => {
  const p = principal(res),
    data = await new RecoveryService(db, p).detail(String(req.params.id)),
    root = req.baseUrl,
    c = data.case,
    h = data.handoff;
  const handoffPath = h ? `${root}/handoffs/${h.id}` : '';
  const control = (action: string, title: string) =>
    `<form method="post" action="${handoffPath}">${csrf(req, handoffPath)}${hidden('expectedRevision', h!.revision)}<button name="action" value="${action}">${title}</button></form>`;
  const draft = data.decisions[0] ? object(data.decisions[0].decision).message_if_allowed : null;
  res.send(
    adminLayout(
      'Recovery opportunity',
      `${css}<div class="recovery-shell"><p><a href="${root}">Revenue Recovery</a></p><h1>${e(c.opportunity.title)}</h1><p>${e(c.contact.name)} · ${money(c.opportunity.amountMinor, c.opportunity.currency)} · ${e(label(c.state))}</p><p>${e(label(c.reason ?? 'Monitoring configured eligibility'))}</p><div class="recovery-layout"><div><section class="panel recovery-panel"><h2>Customer conversation</h2><p class="recovery-source">${e(c.latestResponse?.body ?? 'No customer response recorded.')}</p><p class="recovery-note">${c.attempts} follow-up attempts. ${c.nextDueAt ? `Next evaluation: ${e(c.nextDueAt.toISOString())}` : 'No automatic follow-up scheduled.'}</p></section>${h ? `<section class="panel recovery-panel"><h2>Human handoff</h2><p>${e(label(h.reason))}</p><p>${e(h.summary)}</p><p>Employee membership: ${e(h.assignedMemberId ?? 'Unassigned')}. Status: ${e(h.status)}.</p><div class="recovery-actions">${control('take_over', 'Take Over')}${control('return_to_ai', 'Return to AI')}${control('close', 'Close Handoff')}</div><p class="recovery-note">Closing keeps AI paused. Return to AI preserves attempt limits and waits through the employee quiet period. Already claimed external messages may be in flight.</p><form method="post" action="${handoffPath}">${csrf(req, handoffPath)}${hidden('expectedRevision', h.revision)}${hidden('action', 'respond')}${hidden('requestKey', randomUUID())}${area('message', 'Employee response (review before queuing)', typeof draft === 'string' ? draft : '')}<label>Channel<select name="channel"><option>sms</option><option>email</option></select></label><button>Respond</button><p class="recovery-note">Take over first. This queues your response for the configured delivery adapter; it does not claim the message was sent.</p></form></section>` : ''}<section class="panel recovery-panel"><h2>Decisions and dispatches</h2>${data.decisions.map((d) => `<details><summary>${e(String(object(d.decision).intent))} · ${e(d.createdAt.toISOString())}</summary><pre class="recovery-source">${e(JSON.stringify(d.decision, null, 2))}</pre></details>`).join('')}<ul>${data.dispatches.map((d) => `<li>${e(label(d.status))} · ${e(d.channel)}<p class="recovery-source">${e(d.body)}</p>${d.errorCode ? e(d.errorCode) : ''}</li>`).join('') || '<li>No dispatches.</li>'}</ul></section></div><aside><section class="panel recovery-panel"><h2>Attribution evidence</h2><p>AI-assisted is not automatically AI-recovered. Recovery needs delivered-message, response and outcome evidence; revenue also needs a verified payment reference.</p>${data.attributions.map((a) => `<details><summary>${e(a.kind)}: ${e(a.status)}</summary><pre class="recovery-source">${e(JSON.stringify(a.evidence, null, 2))}</pre>${['owner', 'admin'].includes(p.role ?? '') ? `<form method="post" action="${root}/attributions/${a.id}">${csrf(req, `${root}/attributions/${a.id}`)}${hidden('caseId', c.id)}<label>Attribution status<select name="status">${attributionStatuses.map((s) => `<option${s === a.status ? ' selected' : ''}>${s}</option>`).join('')}</select></label>${input('amountMinor', 'Verified revenue in minor units', a.amountMinor)}${input('currency', 'Currency', a.currency)}${input('paymentReference', 'Verified payment reference', a.paymentReference)}${input('paidAt', 'Payment timestamp (ISO, with timezone)')}${area('evidence', 'Evidence and explanation')}<button>Record attribution review</button></form>` : ''}</details>`).join('') || '<p>No booked/won outcome has been recorded.</p>'}</section></aside></div></div>`,
    ),
  );
});
recoveryAdminRouter.post('/configure', async (req, res) => {
  const b = object(req.body);
  await new RecoveryService(db, principal(res)).configure({
    config: parsed(b.config),
    expectedVersion: Number(b.expectedVersion),
    connectionId: b.connectionId ? display(b.connectionId) : null,
    reviewed: b.reviewed === 'true',
  });
  res.redirect(303, req.baseUrl);
});
recoveryAdminRouter.post('/enable', async (req, res) => {
  await new RecoveryService(db, principal(res)).enable(object(req.body).enabled === 'true');
  res.redirect(303, req.baseUrl);
});
recoveryAdminRouter.post('/consent', async (req, res) => {
  const b = object(req.body);
  await new RecoveryService(db, principal(res)).consent({
    contactId: b.contactId,
    channel: b.channel,
    granted: b.granted === 'true',
    evidence: b.evidence,
  });
  res.redirect(303, req.baseUrl);
});
recoveryAdminRouter.post('/enroll', async (req, res) => {
  const c = await new RecoveryService(db, principal(res)).enroll(
    String(object(req.body).opportunityId),
  );
  res.redirect(303, `${req.baseUrl}/cases/${c.id}`);
});
recoveryAdminRouter.post('/simulate', async (req, res) => {
  const b = object(req.body);
  await new RecoverySimulationService(db, principal(res)).run(
    b.scenarioKey ? { scenarioKey: b.scenarioKey } : { message: b.message, state: parsed(b.state) },
  );
  res.redirect(303, req.baseUrl);
});
recoveryAdminRouter.post('/handoffs/:id', async (req, res) => {
  const b = Object.fromEntries(Object.entries(object(req.body)).filter(([key]) => key !== 'csrf'));
  await new RecoveryHandoffService(db, principal(res)).act(String(req.params.id), {
    ...b,
    expectedRevision: Number(b.expectedRevision),
  });
  res.redirect(303, req.baseUrl);
});
recoveryAdminRouter.post('/attributions/:id', async (req, res) => {
  const b = object(req.body);
  await new RecoveryAttributionService(db, principal(res)).review(String(req.params.id), {
    status: b.status,
    evidence: b.evidence,
    amountMinor: Number(b.amountMinor),
    currency: b.currency,
    paymentReference: b.paymentReference || null,
    paidAt: b.paidAt || null,
  });
  res.redirect(303, req.baseUrl);
});
recoveryAdminRouter.post('/approvals/:id', async (req, res) => {
  const b = object(req.body);
  if (!['approve', 'reject'].includes(String(b.decision)))
    throw new WorkforceError(400, 'invalid_approval_decision');
  await decideApproval(
    db,
    principal(res),
    String(req.params.id),
    b.decision as 'approve' | 'reject',
    String(b.reason),
  );
  res.redirect(303, req.baseUrl);
});
recoveryAdminRouter.use(((error: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const status = error instanceof WorkforceError ? error.status : 500,
    code = error instanceof WorkforceError ? error.code : 'recovery_request_failed';
  res
    .status(status)
    .send(
      adminLayout(
        'Recovery request unavailable',
        `<h1>Request not completed</h1><p>${e(code)}</p><p>Review the saved state and resolve the requirement before retrying.</p><a href="/revenue-recovery">Return to Revenue Recovery</a>`,
      ),
    );
}) as express.ErrorRequestHandler);
