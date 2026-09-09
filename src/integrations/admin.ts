import express from 'express';
import { db } from '../db/client.js';
import { env } from '../config/env.js';
import { requireAdminAuth } from '../middleware/admin-auth.js';
import { adminLayout, escapeHtml as e } from '../utils/html.js';
import { signForm, verifyForm } from '../demo-engine/security.js';
import { tokenHash, type Principal } from '../workforce/tenancy/service.js';
import { object, uuid, WorkforceError } from '../workforce/shared.js';
import { IntegrationService, organizationAdmin } from './service.js';
import { enabled, integrationErrors } from './http.js';
import { organizationLimit, peerLimit } from './rate-limit.js';
import { outboundEvents } from './outbox.js';

function ui() {
  const router = express.Router({ mergeParams: true });
  router.use(express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 50 }));
  router.use((req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
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
  router.get('/', async (req, res) => {
    const service = new IntegrationService(db, res.locals.principal as Principal);
    const state = await service.overview();
    const root = req.baseUrl;
    const csrf = (path: string) =>
      `<input type="hidden" name="csrf" value="${e(signForm(tokenHash(req.header('authorization')!), req.header('authorization')!, path))}">`;
    const button = (path: string, label: string) =>
      `<form method="post" action="${path}">${csrf(path)}<button>${e(label)}</button></form>`;
    const example = {
      version: 1,
      event: 'contact.created',
      external_id: 'crm-change-123',
      occurred_at: new Date().toISOString(),
      contact: { external_id: 'crm-contact-456', name: 'Alex Example', email: 'alex@example.test' },
    };
    const connections = state.connections
      .map(
        (c) =>
          `<section class="panel"><div class="pad"><h2>${e(c.name)}</h2><p>${e(c.provider)} · ${c.enabled ? 'Enabled' : 'Disabled'}</p><label>Inbound webhook URL<input readonly value="${e(`${env.APP_URL?.replace(/\/$/, '') ?? ''}/api/integrations/webhooks/${c.id}/events`)}"></label><p>Send your connection API key in the Authorization bearer header. The URL alone grants no access.</p>${button(`${root}/connections/${c.id}/credentials`, 'Create replacement API key')}</div><div class="table-wrap"><table><thead><tr><th>Credential</th><th>Expires</th><th>Status</th><th>Action</th></tr></thead><tbody>${c.credentials.map((key) => `<tr><td>${e(key.id.slice(0, 8))}</td><td>${e(key.expiresAt.toISOString())}</td><td>${key.revokedAt ? 'Revoked' : key.expiresAt <= new Date() ? 'Expired' : 'Active'}</td><td>${key.revokedAt ? '' : button(`${root}/credentials/${key.id}/revoke`, 'Revoke key')}</td></tr>`).join('')}</tbody></table></div></section>`,
      )
      .join('');
    const endpoints = state.endpoints
      .map(
        (item) =>
          `<tr><td>${e(item.name)}<small class="block">${e(item.host)} (URL hidden)</small></td><td>${e(item.events.join(', '))}</td><td>${item.enabled ? 'Enabled' : 'Disabled'}</td><td>${button(`${root}/outbound/${item.id}/${item.enabled ? 'disable' : 'enable'}`, item.enabled ? 'Disable' : 'Enable')}${item.enabled ? button(`${root}/outbound/${item.id}/test`, 'Send test event') : ''}</td></tr>`,
      )
      .join('');
    const inbound = state.inbound
      .map(
        (a) =>
          `<tr><td>${e(a.createdAt.toISOString())}</td><td>${e(a.connectionId.slice(0, 8))}</td><td>${a.statusCode}</td><td>${e(a.code)}</td><td>${e(a.payloadHash.slice(0, 12))}</td></tr>`,
      )
      .join('');
    const deliveries = state.deliveries
      .map(
        (d) =>
          `<tr><td>${e(d.id)}</td><td>${e(d.status)}</td><td>${d.attempts}</td><td>${e(d.lastErrorCode ?? '—')}<small class="block">${d.history
            .map((a) => `${a.attempt}: ${a.statusCode ?? a.errorCode ?? 'unknown'}`)
            .map(e)
            .join(
              '; ',
            )}</small></td><td>${d.status === 'dead' ? button(`${root}/deliveries/${d.id}/retry`, 'Retry delivery') : e(d.availableAt.toISOString())}</td></tr>`,
      )
      .join('');
    const body = `<style>.pad{padding:20px}.integration-intro{max-width:76ch}.integration-example{white-space:pre-wrap;overflow-wrap:anywhere;padding:20px}.integration-table td{overflow-wrap:anywhere;max-width:350px}.integration-table form{margin:5px 0}</style><h1>Integrations</h1><p>${e(state.organization.name)}</p><p class="integration-intro">Keep your CRM. Send its changes into Steel Scale, and choose which Steel Scale updates go back to Zapier. API keys and signing secrets are shown only when created.</p><p>Outbound worker: ${process.env.WEBHOOK_DELIVERY_ENABLED === 'true' ? 'enabled in this process' : 'paused — deliveries remain queued'}. Use a running workforce worker to deliver queued events.</p>
    <section class="panel"><div class="pad"><h2>Connect your CRM</h2><p>Create a separate connection for each source account. Keys expire after 90 days.</p></div><form method="post" action="${root}/connections" class="form-grid">${csrf(`${root}/connections`)}<label>Connection name<input name="name" required maxlength="200"></label><label>Provider<select name="provider"><option value="zapier">Zapier</option><option value="generic_webhook">Generic webhook</option></select></label><label class="wide">Field mapping JSON (optional)<textarea name="mapping" placeholder='{"contact.name":"customer.full_name"}'></textarea><small>Map Steel Scale field paths to your payload's field paths. Omit this when using the example below.</small></label><button class="wide">Create connection and API key</button></form></section>
    ${connections || '<p class="empty">No inbound connections yet.</p>'}<section class="panel"><div class="pad"><h2>Example Zapier payload</h2><p>POST JSON with Authorization: Bearer &lt;connection API key&gt;. Preserve the event ID and timestamp on retry.</p></div><pre class="integration-example">${e(JSON.stringify(example, null, 2))}</pre></section>
    <section class="panel"><div class="pad"><h2>Send updates to Zapier</h2><p>Paste your HTTPS Catch Hook URL. Treat it as a secret. Test events also run through the durable delivery queue.</p></div><form method="post" action="${root}/outbound" class="form-grid">${csrf(`${root}/outbound`)}<label>Name<input name="name" required maxlength="200"></label><label>Webhook URL<input name="url" type="url" required autocomplete="off"></label><label class="wide">Events<select name="events" multiple required size="${outboundEvents.length}">${outboundEvents.map((v) => `<option value="${v}">${e(v)}</option>`).join('')}</select></label><label>Include imported events<select name="includeExternal"><option value="false">No — prevent CRM feedback loops</option><option value="true">Yes — configure loop prevention in Zapier</option></select></label><label>Include contact details<select name="includeContactData"><option value="false">No — identifiers and status only</option><option value="true">Yes — include changed name/email/phone/title</option></select></label><button class="wide">Configure outbound webhook</button></form></section>
    <section class="panel table-wrap"><table class="integration-table"><thead><tr><th>Destination</th><th>Events</th><th>Status</th><th>Actions</th></tr></thead><tbody>${endpoints || '<tr><td colspan="4">No destinations configured.</td></tr>'}</tbody></table></section>
    <h2>Recent inbound activity</h2><section class="panel table-wrap"><table><thead><tr><th>Time</th><th>Connection</th><th>HTTP</th><th>Result</th><th>Payload hash</th></tr></thead><tbody>${inbound || '<tr><td colspan="5">No inbound deliveries yet.</td></tr>'}</tbody></table></section>
    <h2>Recent outbound deliveries</h2><p>Failed deliveries are retained. A successful HTTP response means the receiver accepted the webhook, not that its CRM action finished.</p><section class="panel table-wrap"><table class="integration-table"><thead><tr><th>Delivery ID</th><th>Status</th><th>Attempts</th><th>Result / history</th><th>Next attempt / action</th></tr></thead><tbody>${deliveries || '<tr><td colspan="5">No outbound deliveries yet.</td></tr>'}</tbody></table></section>`;
    res.send(
      adminLayout(
        'Integrations',
        (env.APP_URL
          ? ''
          : '<p class="notice error">Public APP_URL is not configured. The inbound address below is a relative path; ask the operator to configure the public HTTPS origin before connecting Zapier.</p>') +
          body,
        root === '/integrations',
      ),
    );
  });
  router.post('/:kind/:id/:operation', async (req, res) => {
    const service = new IntegrationService(db, res.locals.principal as Principal);
    const id = uuid(req.params.id);
    const operation = req.params.operation;
    let secret: string | undefined;
    if (req.params.kind === 'connections' && operation === 'credentials')
      secret = (await service.issue(id)).token;
    else if (req.params.kind === 'credentials' && operation === 'revoke') await service.revoke(id);
    else if (req.params.kind === 'outbound' && ['test', 'enable', 'disable'].includes(operation))
      await service.endpoint(id, operation as 'test' | 'enable' | 'disable');
    else if (req.params.kind === 'deliveries' && operation === 'retry') await service.retry(id);
    else throw new WorkforceError(404, 'operation_not_found');
    if (secret) {
      res.send(secretPage(secret, req.baseUrl, 'API key'));
      return;
    }
    res.redirect(303, req.baseUrl);
  });
  router.post('/:kind', async (req, res) => {
    const service = new IntegrationService(db, res.locals.principal as Principal);
    const b = object(req.body);
    if (req.params.kind === 'connections') {
      let mapping: unknown = {};
      try {
        if (typeof b.mapping === 'string' && b.mapping.trim())
          mapping = JSON.parse(b.mapping) as unknown;
      } catch {
        throw new WorkforceError(400, 'invalid_mapping_json');
      }
      const result = await service.createConnection({
        name: b.name,
        provider: b.provider,
        mapping,
      });
      res.send(secretPage(result.token, req.baseUrl, 'API key'));
    } else if (req.params.kind === 'outbound') {
      const result = await service.createEndpoint({
        name: b.name,
        url: b.url,
        events: Array.isArray(b.events) ? b.events : [b.events],
        includeExternal: b.includeExternal === 'true',
        includeContactData: b.includeContactData === 'true',
      });
      res.send(secretPage(result.signingSecret, req.baseUrl, 'Signing secret'));
    } else throw new WorkforceError(404, 'operation_not_found');
  });
  return router;
}
function secretPage(secret: string, root: string, label: string) {
  return adminLayout(
    label,
    `<h1>${e(label)} created</h1><p>Copy this now into your secret manager. It cannot be retrieved again.</p><label>${e(label)}<input readonly autocomplete="off" value="${e(secret)}"></label><p><a href="${root}">Return to Integrations</a></p>`,
    root === '/integrations',
  );
}

// Customer UI uses organization membership credentials, not the platform operator password.
export const integrationAdminRouter = express.Router();
integrationAdminRouter.use(enabled, peerLimit);
integrationAdminRouter.use(async (req, res, next) => {
  let authorization = req.header('authorization');
  if (authorization?.startsWith('Basic ')) {
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    const token = decoded.slice(decoded.indexOf(':') + 1);
    authorization = `Bearer ${token}`;
  }
  try {
    const principal = await organizationAdmin(db, authorization);
    await organizationLimit(db, principal.organizationId);
    res.locals.principal = principal;
    next();
  } catch (error) {
    if (error instanceof WorkforceError && error.status === 401)
      res.setHeader(
        'WWW-Authenticate',
        'Basic realm="Steel Scale organization (use your member API key as password)", charset="UTF-8"',
      );
    throw error;
  }
});
integrationAdminRouter.use(ui());
integrationAdminRouter.use(integrationErrors);

export const integrationOperatorRouter = express.Router();
integrationOperatorRouter.use(enabled, peerLimit, requireAdminAuth);
integrationOperatorRouter.get('/', async (_req, res) => {
  const orgs = await db.organization.findMany({ take: 100, orderBy: { name: 'asc' } });
  res.send(
    adminLayout(
      'Integrations',
      `<h1>Integrations</h1><p>Select an organization.</p><section class="panel"><ul>${orgs.map((o) => `<li><a href="/admin/integrations/${o.id}">${e(o.name)}</a></li>`).join('')}</ul></section>`,
    ),
  );
});
integrationOperatorRouter.use(
  '/:organizationId',
  (req, res, next) => {
    res.locals.principal = {
      organizationId: uuid(req.params.organizationId),
      credentialId: 'platform-operator',
      actor: `platform_operator:${env.ADMIN_USERNAME}`,
      role: 'owner',
      scopes: ['integrations:write'],
    } satisfies Principal;
    next();
  },
  ui(),
);
integrationOperatorRouter.use(integrationErrors);
