import { Router, type Request } from 'express';
import { Prisma } from '@prisma/client';

import { db } from '../db/client.js';
import { requireAdminAuth } from '../middleware/admin-auth.js';
import { adminLayout, escapeHtml } from '../utils/html.js';
import { adminCallQueueRouter } from './admin-call-queue.js';
import { adminLeadIntelligenceRouter } from './admin-lead-intelligence.js';

export const adminRouter = Router();

adminRouter.use(requireAdminAuth);
adminRouter.use('/call-queue', adminCallQueueRouter);
adminRouter.use('/leads', adminLeadIntelligenceRouter);

type ClientForm = {
  businessName: string;
  phoneNumber: string;
  timezone: string;
  services: string;
  missedCallSmsTemplate: string;
  ownerNotificationNumber: string;
  notifyBookingSms: boolean;
  notifyMissedCallSms: boolean;
  notifyUnbookedCallSms: boolean;
  notifyFailedBookingSms: boolean;
  notifyTransferFailureSms: boolean;
  dailySummarySms: boolean;
  destinationType: 'zapier' | 'ghl_fallback';
  zapierWebhookUrl: string;
  zapierAvailabilityWebhookUrl: string;
  ghlCalendarId: string;
  voiceProvider: 'vapi' | 'retell';
  agentId: string;
  phoneNumberId: string;
  systemPrompt: string;
  ownerTransferNumber: string;
  ownerTransferMode: 'blind-transfer' | 'warm-transfer-say-summary';
};

const defaultForm: ClientForm = {
  businessName: '',
  phoneNumber: '',
  timezone: 'America/New_York',
  services: '',
  missedCallSmsTemplate:
    "Hey, sorry we missed your call! This is {business_name} — reply here and we'll get you booked in.",
  ownerNotificationNumber: '',
  notifyBookingSms: true,
  notifyMissedCallSms: true,
  notifyUnbookedCallSms: true,
  notifyFailedBookingSms: true,
  notifyTransferFailureSms: true,
  dailySummarySms: true,
  destinationType: 'zapier',
  zapierWebhookUrl: '',
  zapierAvailabilityWebhookUrl: '',
  ghlCalendarId: '',
  voiceProvider: 'vapi',
  agentId: '',
  phoneNumberId: '',
  systemPrompt: '',
  ownerTransferNumber: '',
  ownerTransferMode: 'blind-transfer',
};

function bodyValue(body: Request['body'], key: string): string {
  const values = body as Record<string, unknown> | undefined;
  const value = values?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function bodyChecked(body: Request['body'], key: string): boolean {
  const values = body as Record<string, unknown> | undefined;
  return values?.[key] === 'on';
}

function parseForm(request: Request): ClientForm {
  return {
    businessName: bodyValue(request.body, 'businessName'),
    phoneNumber: bodyValue(request.body, 'phoneNumber'),
    timezone: bodyValue(request.body, 'timezone'),
    services: bodyValue(request.body, 'services'),
    missedCallSmsTemplate: bodyValue(request.body, 'missedCallSmsTemplate'),
    ownerNotificationNumber: bodyValue(request.body, 'ownerNotificationNumber'),
    notifyBookingSms: bodyChecked(request.body, 'notifyBookingSms'),
    notifyMissedCallSms: bodyChecked(request.body, 'notifyMissedCallSms'),
    notifyUnbookedCallSms: bodyChecked(request.body, 'notifyUnbookedCallSms'),
    notifyFailedBookingSms: bodyChecked(request.body, 'notifyFailedBookingSms'),
    notifyTransferFailureSms: bodyChecked(request.body, 'notifyTransferFailureSms'),
    dailySummarySms: bodyChecked(request.body, 'dailySummarySms'),
    destinationType:
      bodyValue(request.body, 'destinationType') === 'ghl_fallback' ? 'ghl_fallback' : 'zapier',
    zapierWebhookUrl: bodyValue(request.body, 'zapierWebhookUrl'),
    zapierAvailabilityWebhookUrl: bodyValue(request.body, 'zapierAvailabilityWebhookUrl'),
    ghlCalendarId: bodyValue(request.body, 'ghlCalendarId'),
    voiceProvider: bodyValue(request.body, 'voiceProvider') === 'retell' ? 'retell' : 'vapi',
    agentId: bodyValue(request.body, 'agentId'),
    phoneNumberId: bodyValue(request.body, 'phoneNumberId'),
    systemPrompt: bodyValue(request.body, 'systemPrompt'),
    ownerTransferNumber: bodyValue(request.body, 'ownerTransferNumber'),
    ownerTransferMode:
      bodyValue(request.body, 'ownerTransferMode') === 'warm-transfer-say-summary'
        ? 'warm-transfer-say-summary'
        : 'blind-transfer',
  };
}

function parseServices(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((service) => service.trim())
        .filter(Boolean),
    ),
  ];
}

function validateForm(form: ClientForm): string[] {
  const errors: string[] = [];
  const required: Array<[keyof ClientForm, string]> = [
    ['businessName', 'Business name'],
    ['phoneNumber', 'Phone number'],
    ['timezone', 'Timezone'],
    ['services', 'Services'],
    ['missedCallSmsTemplate', 'Missed-call SMS template'],
    ['agentId', 'Voice agent ID'],
    ['phoneNumberId', 'Voice phone number ID'],
    ['systemPrompt', 'Voice system prompt'],
  ];

  for (const [key, label] of required) {
    if (!form[key]) errors.push(`${label} is required.`);
  }

  if (form.phoneNumber && !/^\+[1-9]\d{7,14}$/.test(form.phoneNumber)) {
    errors.push('Phone number must use E.164 format, such as +15551234567.');
  }

  if (form.ownerTransferNumber && !/^\+[1-9]\d{7,14}$/.test(form.ownerTransferNumber)) {
    errors.push('Owner transfer number must use E.164 format, such as +15551234567.');
  }

  if (form.ownerNotificationNumber && !/^\+[1-9]\d{7,14}$/.test(form.ownerNotificationNumber)) {
    errors.push('Owner notification number must use E.164 format, such as +15551234567.');
  }

  if (form.ownerTransferNumber && form.ownerTransferNumber === form.phoneNumber) {
    errors.push('Owner transfer number must be different from the main phone number.');
  }

  if (form.destinationType === 'zapier') {
    for (const [rawUrl, label] of [
      [form.zapierWebhookUrl, 'booking'],
      [form.zapierAvailabilityWebhookUrl, 'availability'],
    ] as const) {
      try {
        const url = new URL(rawUrl);
        if (url.protocol !== 'https:') errors.push(`Zapier ${label} webhook URL must use HTTPS.`);
      } catch {
        errors.push(`A valid Zapier ${label} webhook URL is required.`);
      }
    }
  } else if (!form.ghlCalendarId) {
    errors.push('GHL calendar ID is required for the GHL fallback destination.');
  }

  return errors;
}

function errorNotice(errors: string[]): string {
  if (!errors.length) return '';
  return `<div class="notice error"><strong>Please fix the following:</strong><ul>${errors
    .map((error) => `<li>${escapeHtml(error)}</li>`)
    .join('')}</ul></div>`;
}

function renderForm(
  form: ClientForm,
  options: { title: string; action: string; errors?: string[] },
): string {
  const selected = (value: string, expected: string) => (value === expected ? ' selected' : '');
  const checked = (value: boolean) => (value ? ' checked' : '');
  const e = escapeHtml;

  return adminLayout(
    options.title,
    `<header class="page-header">
      <div><a class="eyebrow" href="/admin">← All clients</a><h1>${e(options.title)}</h1></div>
    </header>
    ${errorNotice(options.errors ?? [])}
    <form method="post" action="${e(options.action)}" class="stack">
      <section class="panel">
        <div class="section-heading"><span>01</span><div><h2>Client profile</h2><p>Identity and lead-response configuration.</p></div></div>
        <div class="form-grid">
          <label>Business name<input name="businessName" value="${e(form.businessName)}" required></label>
          <label>Main phone number<input name="phoneNumber" value="${e(form.phoneNumber)}" placeholder="+15551234567" required></label>
          <label>Timezone<input name="timezone" value="${e(form.timezone)}" placeholder="America/New_York" required></label>
          <label class="wide">Services<textarea name="services" rows="3" placeholder="HVAC repair, Maintenance, Installation" required>${e(form.services)}</textarea><small>Separate services with commas or new lines.</small></label>
          <label class="wide">Missed-call SMS template<textarea name="missedCallSmsTemplate" rows="3" required>${e(form.missedCallSmsTemplate)}</textarea><small>Use <code>{business_name}</code> for the client's business name.</small></label>
        </div>
      </section>

      <section class="panel">
        <div class="section-heading"><span>02</span><div><h2>Owner notifications</h2><p>Immediate operational alerts sent from the client's Twilio number.</p></div></div>
        <div class="form-grid">
          <label>Owner notification number<input type="tel" name="ownerNotificationNumber" value="${e(form.ownerNotificationNumber)}" placeholder="+15551234567"><small>Leave blank to disable every owner SMS notification.</small></label>
          <label><input type="checkbox" name="notifyBookingSms"${checked(form.notifyBookingSms)}> Successful bookings</label>
          <label><input type="checkbox" name="notifyMissedCallSms"${checked(form.notifyMissedCallSms)}> Missed calls</label>
          <label><input type="checkbox" name="notifyUnbookedCallSms"${checked(form.notifyUnbookedCallSms)}> Completed calls without a booking</label>
          <label><input type="checkbox" name="notifyFailedBookingSms"${checked(form.notifyFailedBookingSms)}> Failed bookings requiring follow-up</label>
          <label><input type="checkbox" name="notifyTransferFailureSms"${checked(form.notifyTransferFailureSms)}> Failed owner transfers</label>
          <label><input type="checkbox" name="dailySummarySms"${checked(form.dailySummarySms)}> Daily activity summary</label>
        </div>
      </section>

      <section class="panel">
        <div class="section-heading"><span>03</span><div><h2>Booking destination</h2><p>Only the fields for the selected route are saved.</p></div></div>
        <div class="form-grid">
          <label>Destination type<select name="destinationType" required>
            <option value="zapier"${selected(form.destinationType, 'zapier')}>Zapier</option>
            <option value="ghl_fallback"${selected(form.destinationType, 'ghl_fallback')}>GHL fallback</option>
          </select></label>
          <label>Zapier webhook URL<input type="url" name="zapierWebhookUrl" value="${e(form.zapierWebhookUrl)}" placeholder="https://hooks.zapier.com/..."></label>
          <label>Zapier availability webhook URL<input type="url" name="zapierAvailabilityWebhookUrl" value="${e(form.zapierAvailabilityWebhookUrl)}" placeholder="https://hooks.zapier.com/..."><small>A separate Zap that checks the calendar and posts results to the supplied callback URL.</small></label>
          <label>GHL calendar ID<input name="ghlCalendarId" value="${e(form.ghlCalendarId)}"></label>
        </div>
      </section>

      <section class="panel">
        <div class="section-heading"><span>04</span><div><h2>Voice agent</h2><p>Provider identity and per-client call instructions.</p></div></div>
        <div class="form-grid">
          <label>Provider<select name="voiceProvider" required>
            <option value="vapi"${selected(form.voiceProvider, 'vapi')}>Vapi</option>
            <option value="retell"${selected(form.voiceProvider, 'retell')}>Retell</option>
          </select></label>
          <label>Agent ID<input name="agentId" value="${e(form.agentId)}" required></label>
          <label>Provider phone number ID<input name="phoneNumberId" value="${e(form.phoneNumberId)}" required></label>
          <label>Owner transfer number<input type="tel" name="ownerTransferNumber" value="${e(form.ownerTransferNumber)}" placeholder="+15551234567"><small>Optional. Leave blank to disable live owner transfers. Must not route back to the main AI number.</small></label>
          <label>Owner transfer type<select name="ownerTransferMode">
            <option value="blind-transfer"${selected(form.ownerTransferMode, 'blind-transfer')}>Blind transfer</option>
            <option value="warm-transfer-say-summary"${selected(form.ownerTransferMode, 'warm-transfer-say-summary')}>Warm transfer with summary</option>
          </select><small>Warm transfer summarizes the conversation to the owner before connecting the caller.</small></label>
          <label class="wide">System prompt<textarea name="systemPrompt" rows="8" required>${e(form.systemPrompt)}</textarea></label>
        </div>
      </section>

      <div class="form-actions"><button type="submit">Save client configuration</button></div>
    </form>`,
  );
}

async function saveClient(form: ClientForm, clientId?: string): Promise<string> {
  const services = parseServices(form.services);
  const clientData = {
    businessName: form.businessName,
    phoneNumber: form.phoneNumber,
    timezone: form.timezone,
    services,
    missedCallSmsTemplate: form.missedCallSmsTemplate,
    ownerNotificationNumber: form.ownerNotificationNumber || null,
    notifyBookingSms: form.notifyBookingSms,
    notifyMissedCallSms: form.notifyMissedCallSms,
    notifyUnbookedCallSms: form.notifyUnbookedCallSms,
    notifyFailedBookingSms: form.notifyFailedBookingSms,
    notifyTransferFailureSms: form.notifyTransferFailureSms,
    dailySummarySms: form.dailySummarySms,
  };

  return db.$transaction(async (transaction) => {
    const client = clientId
      ? await transaction.client.update({ where: { id: clientId }, data: clientData })
      : await transaction.client.create({ data: clientData });

    await transaction.clientDestination.upsert({
      where: { clientId: client.id },
      create: {
        clientId: client.id,
        destinationType: form.destinationType,
        zapierWebhookUrl: form.destinationType === 'zapier' ? form.zapierWebhookUrl : null,
        zapierAvailabilityWebhookUrl:
          form.destinationType === 'zapier' ? form.zapierAvailabilityWebhookUrl : null,
        ghlCalendarId: form.destinationType === 'ghl_fallback' ? form.ghlCalendarId : null,
      },
      update: {
        destinationType: form.destinationType,
        zapierWebhookUrl: form.destinationType === 'zapier' ? form.zapierWebhookUrl : null,
        zapierAvailabilityWebhookUrl:
          form.destinationType === 'zapier' ? form.zapierAvailabilityWebhookUrl : null,
        ghlCalendarId: form.destinationType === 'ghl_fallback' ? form.ghlCalendarId : null,
      },
    });

    await transaction.voiceAgentConfig.upsert({
      where: { clientId: client.id },
      create: {
        clientId: client.id,
        provider: form.voiceProvider,
        agentId: form.agentId,
        phoneNumberId: form.phoneNumberId,
        systemPrompt: form.systemPrompt,
        ownerTransferNumber: form.ownerTransferNumber || null,
        ownerTransferMode: form.ownerTransferMode,
      },
      update: {
        provider: form.voiceProvider,
        agentId: form.agentId,
        phoneNumberId: form.phoneNumberId,
        systemPrompt: form.systemPrompt,
        ownerTransferNumber: form.ownerTransferNumber || null,
        ownerTransferMode: form.ownerTransferMode,
      },
    });

    return client.id;
  });
}

adminRouter.get('/', async (_request, response, next) => {
  try {
    const clients = await db.client.findMany({
      include: { destination: true, voiceAgentConfig: true },
      orderBy: { businessName: 'asc' },
    });

    const rows = clients
      .map(
        (client) => `<tr>
          <td><a class="primary-link" href="/admin/clients/${e(client.id)}">${e(client.businessName)}</a><small class="block mono">${e(client.id)}</small></td>
          <td class="mono">${e(client.phoneNumber)}</td>
          <td>${e(client.services.join(', '))}</td>
          <td><span class="badge neutral">${e(client.destination?.destinationType ?? 'not set')}</span></td>
          <td>${e(client.voiceAgentConfig?.provider ?? 'not set')}</td>
          <td><a href="/admin/clients/${e(client.id)}">Manage →</a></td>
        </tr>`,
      )
      .join('');

    response.send(
      adminLayout(
        'Clients',
        `<nav class="admin-tabs"><a class="active" href="/admin">Clients</a><a href="/admin/leads">Lead Intelligence</a><a href="/admin/call-queue">Call queue</a></nav>
        <header class="page-header"><div><p class="eyebrow">Steel Scale / Control room</p><h1>Client configurations</h1><p>Manage routing, automation, and operational health from one place.</p></div><a class="button" href="/admin/clients/new">Add client</a></header>
        <section class="panel table-panel">
          <div class="section-heading"><span>${String(clients.length).padStart(2, '0')}</span><div><h2>Active clients</h2><p>Open a client to edit configuration or inspect recent activity.</p></div></div>
          ${clients.length ? `<div class="table-wrap"><table><thead><tr><th>Client</th><th>Phone</th><th>Services</th><th>Destination</th><th>Voice</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">No clients configured yet.</div>'}
        </section>`,
      ),
    );
  } catch (error) {
    next(error);
  }
});

adminRouter.get('/clients/new', (_request, response) => {
  response.send(renderForm(defaultForm, { title: 'Add client', action: '/admin/clients' }));
});

adminRouter.post('/clients', async (request, response, next) => {
  const form = parseForm(request);
  const errors = validateForm(form);
  if (errors.length) {
    response
      .status(400)
      .send(renderForm(form, { title: 'Add client', action: '/admin/clients', errors }));
    return;
  }

  try {
    const id = await saveClient(form);
    response.redirect(303, `/admin/clients/${id}?saved=1`);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      response.status(409).send(
        renderForm(form, {
          title: 'Add client',
          action: '/admin/clients',
          errors: ['That phone number is already assigned to another client.'],
        }),
      );
      return;
    }
    next(error);
  }
});

adminRouter.get('/clients/:id', async (request, response, next) => {
  try {
    const client = await db.client.findUnique({
      where: { id: request.params.id },
      include: {
        destination: true,
        voiceAgentConfig: true,
        callLogs: { orderBy: { createdAt: 'desc' }, take: 25 },
        bookingAttempts: { orderBy: { createdAt: 'desc' }, take: 25 },
        ownerNotifications: { orderBy: { createdAt: 'desc' }, take: 25 },
      },
    });

    if (!client) {
      response
        .status(404)
        .send(
          adminLayout(
            'Client not found',
            '<div class="notice error">Client not found. <a href="/admin">Return to clients</a>.</div>',
          ),
        );
      return;
    }

    const form: ClientForm = {
      businessName: client.businessName,
      phoneNumber: client.phoneNumber,
      timezone: client.timezone,
      services: client.services.join(', '),
      missedCallSmsTemplate: client.missedCallSmsTemplate,
      ownerNotificationNumber: client.ownerNotificationNumber ?? '',
      notifyBookingSms: client.notifyBookingSms,
      notifyMissedCallSms: client.notifyMissedCallSms,
      notifyUnbookedCallSms: client.notifyUnbookedCallSms,
      notifyFailedBookingSms: client.notifyFailedBookingSms,
      notifyTransferFailureSms: client.notifyTransferFailureSms,
      dailySummarySms: client.dailySummarySms,
      destinationType: client.destination?.destinationType ?? 'zapier',
      zapierWebhookUrl: client.destination?.zapierWebhookUrl ?? '',
      zapierAvailabilityWebhookUrl: client.destination?.zapierAvailabilityWebhookUrl ?? '',
      ghlCalendarId: client.destination?.ghlCalendarId ?? '',
      voiceProvider: client.voiceAgentConfig?.provider ?? 'vapi',
      agentId: client.voiceAgentConfig?.agentId ?? '',
      phoneNumberId: client.voiceAgentConfig?.phoneNumberId ?? '',
      systemPrompt: client.voiceAgentConfig?.systemPrompt ?? '',
      ownerTransferNumber: client.voiceAgentConfig?.ownerTransferNumber ?? '',
      ownerTransferMode:
        client.voiceAgentConfig?.ownerTransferMode === 'warm-transfer-say-summary'
          ? 'warm-transfer-say-summary'
          : 'blind-transfer',
    };

    const callRows = client.callLogs
      .map(
        (log) =>
          `<tr><td>${formatDate(log.createdAt)}</td><td class="mono">${e(log.callerNumber)}</td><td>${e(log.callType)}</td><td><span class="badge neutral">${e(log.outcome)}</span></td><td>${log.durationSeconds}s</td><td>${e(log.smsAttemptStatus ?? '—')}${log.smsErrorMessage ? `<small class="block error-text">${e(log.smsErrorMessage)}</small>` : ''}</td></tr>`,
      )
      .join('');
    const bookingRows = client.bookingAttempts
      .map(
        (attempt) =>
          `<tr><td>${formatDate(attempt.createdAt)}</td><td>${e(attempt.source)}</td><td><span class="badge ${attempt.status === 'success' ? 'success' : 'failure'}">${e(attempt.status)}</span></td><td>${e(attempt.deliveredDestinationType ?? attempt.destinationType ?? '—')}</td><td>${attempt.manualFollowUpRequired ? '<span class="badge failure">follow up</span>' : '—'}</td><td>${e(attempt.errorMessage ?? '—')}</td></tr>`,
      )
      .join('');
    const notificationRows = client.ownerNotifications
      .map(
        (notification) =>
          `<tr><td>${formatDate(notification.createdAt)}</td><td>${e(notification.notificationType.replaceAll('_', ' '))}</td><td class="mono">${e(notification.recipient)}</td><td><span class="badge ${notification.status === 'sent' ? 'success' : notification.status === 'failed' ? 'failure' : 'neutral'}">${e(notification.status)}</span></td><td>${e(notification.errorMessage ?? '—')}</td></tr>`,
      )
      .join('');

    const formHtml = renderForm(form, {
      title: client.businessName,
      action: `/admin/clients/${client.id}`,
    });
    const saveNotice =
      request.query.saved === '1'
        ? '<div class="notice success-notice">Client configuration saved.</div>'
        : '';
    const activity = `<section class="activity stack">
      <section class="panel table-panel"><div class="section-heading"><span>${String(client.callLogs.length).padStart(2, '0')}</span><div><h2>Recent calls</h2><p>Latest 25 call and missed-call SMS events.</p></div></div>${callRows ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Caller</th><th>Type</th><th>Outcome</th><th>Duration</th><th>SMS</th></tr></thead><tbody>${callRows}</tbody></table></div>` : '<div class="empty">No call activity yet.</div>'}</section>
      <section class="panel table-panel"><div class="section-heading"><span>${String(client.bookingAttempts.length).padStart(2, '0')}</span><div><h2>Recent booking attempts</h2><p>Latest 25 delivery results and fallback flags.</p></div></div>${bookingRows ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Source</th><th>Status</th><th>Delivered to</th><th>Manual</th><th>Error</th></tr></thead><tbody>${bookingRows}</tbody></table></div>` : '<div class="empty">No booking attempts yet.</div>'}</section>
      <section class="panel table-panel"><div class="section-heading"><span>${String(client.ownerNotifications.length).padStart(2, '0')}</span><div><h2>Owner notifications</h2><p>Latest 25 owner SMS delivery attempts.</p></div></div>${notificationRows ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Type</th><th>Recipient</th><th>Status</th><th>Error</th></tr></thead><tbody>${notificationRows}</tbody></table></div>` : '<div class="empty">No owner notifications yet.</div>'}</section>
    </section>`;

    response.send(
      formHtml.replace('<main>', `<main>${saveNotice}`).replace('</main>', `${activity}</main>`),
    );
  } catch (error) {
    next(error);
  }
});

adminRouter.post('/clients/:id', async (request, response, next) => {
  const form = parseForm(request);
  const errors = validateForm(form);
  if (errors.length) {
    response.status(400).send(
      renderForm(form, {
        title: form.businessName || 'Edit client',
        action: `/admin/clients/${request.params.id}`,
        errors,
      }),
    );
    return;
  }

  try {
    await saveClient(form, request.params.id);
    response.redirect(303, `/admin/clients/${request.params.id}?saved=1`);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      response
        .status(404)
        .send(
          adminLayout(
            'Client not found',
            '<div class="notice error">Client not found. <a href="/admin">Return to clients</a>.</div>',
          ),
        );
      return;
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      response.status(409).send(
        renderForm(form, {
          title: form.businessName,
          action: `/admin/clients/${request.params.id}`,
          errors: ['That phone number is already assigned to another client.'],
        }),
      );
      return;
    }
    next(error);
  }
});

function e(value: string | number): string {
  return escapeHtml(value);
}

function formatDate(value: Date): string {
  return escapeHtml(value.toISOString().replace('T', ' ').slice(0, 16) + ' UTC');
}
