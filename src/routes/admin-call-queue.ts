import { ProspectCallStatus } from '@prisma/client';
import { Router, type Request } from 'express';

import { getCallPerformance } from '../lead-intelligence/call-queue/metrics.js';
import {
  getRankedCallQueue,
  recordCallAttempt,
  setCallQueuePriority,
  type RankedCall,
} from '../lead-intelligence/call-queue/service.js';
import { adminLayout, escapeHtml } from '../utils/html.js';

export const adminCallQueueRouter = Router();

function body(request: Request, key: string): string {
  const value = (request.body as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value.trim() : '';
}
function date(value: string): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed;
}
function phone(value: string): string {
  const digits = value.replace(/\D/g, '');
  const local = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  return local.length === 10
    ? `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`
    : value;
}
function statusLabel(value: string): string {
  return value.replaceAll('_', ' ').replace(/^./, (character) => character.toUpperCase());
}

function attemptForm(call: RankedCall): string {
  return `<form class="call-outcome-form" method="post" action="/admin/call-queue/${call.queueEntryId}/attempt"><label>Call status<select name="status" required>${Object.values(
    ProspectCallStatus,
  )
    .filter((status) => status !== ProspectCallStatus.not_called)
    .map((status) => `<option value="${status}">${statusLabel(status)}</option>`)
    .join(
      '',
    )}</select></label><label>Next follow-up<input type="datetime-local" name="nextFollowUpAt"></label><label class="wide">Notes<textarea name="notes" rows="3" placeholder="Who answered, objection, timing, permission given…"></textarea></label><button type="submit">Record call outcome</button></form>`;
}

function callCard(call: RankedCall): string {
  return `<section class="next-call"><div class="call-rank"><span>Call next</span><strong>${Math.round(call.rankScore)}</strong><small>priority</small></div><div class="call-identity"><h1>${escapeHtml(call.business)}</h1><p>${escapeHtml(call.niche ?? 'Uncategorized')} · ${escapeHtml(call.offer.replaceAll('_', ' '))}</p><div class="call-phone"><span>Phone</span><a href="tel:${escapeHtml(call.phone)}">${escapeHtml(phone(call.phone))}</a></div>${call.website ? `<a href="${escapeHtml(call.website)}" target="_blank" rel="noopener">Open website</a>` : ''}</div><div class="call-proof"><div class="call-score"><strong>${call.score}</strong><span>${escapeHtml(call.scoreBand)} · ${escapeHtml(call.offer.replaceAll('_', ' '))}</span></div><h2>Why call them</h2><ul>${call.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul><div class="pitch-angle"><span>Angle</span><strong>“${escapeHtml(call.angle)}”</strong></div></div><div class="call-capture">${attemptForm(call)}</div></section>`;
}

function conversionTable(
  title: string,
  rows: Awaited<ReturnType<typeof getCallPerformance>>['byNiche'],
): string {
  return `<section class="panel conversion-panel"><h2>${title}</h2>${rows.length ? `<table><thead><tr><th>Segment</th><th>Calls</th><th>Reached</th><th>Interested</th><th>Demos</th><th>Demo rate</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${escapeHtml(row.label)}</td><td>${row.calls}</td><td>${row.ownersReached}</td><td>${row.interested}</td><td>${row.demosBooked}</td><td>${Math.round(row.conversionRate * 100)}%</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Call outcomes will populate this table.</div>'}</section>`;
}

adminCallQueueRouter.get('/', async (request, response, next) => {
  try {
    const clientId =
      typeof request.query.clientId === 'string' ? request.query.clientId : undefined;
    const [queue, performance] = await Promise.all([
      getRankedCallQueue({ clientId }),
      getCallPerformance({ clientId }),
    ]);
    const [nextCall, ...remaining] = queue;
    const queueRows = remaining
      .map(
        (call, index) =>
          `<tr><td class="queue-position">${index + 2}</td><td><a class="primary-link" href="/admin/leads/${call.leadId}">${escapeHtml(call.business)}</a><small class="block">${escapeHtml(call.angle)}</small></td><td><span class="score-cell score-${call.scoreBand.toLowerCase()}"><strong>${call.score}</strong><span>${call.scoreBand}</span></span></td><td><a class="mono" href="tel:${escapeHtml(call.phone)}">${escapeHtml(phone(call.phone))}</a></td><td>${statusLabel(call.status)}<small class="block">${call.attemptCount} attempts</small></td><td>${call.nextFollowUpAt ? call.nextFollowUpAt.toLocaleString() : '—'}</td><td><form class="priority-form" method="post" action="/admin/call-queue/${call.queueEntryId}/priority"><input aria-label="Manual priority" type="number" min="-25" max="25" name="manualPriority" value="${call.manualPriority}"><button>Set</button></form></td></tr>`,
      )
      .join('');
    response.send(
      adminLayout(
        'Prospecting call queue',
        `<nav class="admin-tabs"><a href="/admin">Clients</a><a href="/admin/leads">Lead Intelligence</a><a class="active" href="/admin/call-queue">Call queue</a></nav><header class="page-header"><div><h1>Prospecting call queue</h1><p>One ranked list for human outreach. No calls are placed automatically.</p></div><span class="queue-count">${queue.length} ready to call</span></header><section class="call-metrics"><div><strong>${performance.callsToday}</strong><span>Calls today</span></div><div><strong>${performance.ownersReached}</strong><span>Owners reached</span></div><div><strong>${performance.interested}</strong><span>Interested</span></div><div><strong>${performance.demosBooked}</strong><span>Demos booked</span></div></section>${nextCall ? callCard(nextCall) : '<div class="panel empty">No prospects are currently callable. Add qualified leads to a CALL_QUEUE campaign or wait for cooldowns to expire.</div>'}<section class="panel table-panel"><div class="table-caption"><strong>Up next</strong><span>Ranked by score, freshness, recency, attempts, cooldown, and manual priority</span></div>${queueRows ? `<div class="table-wrap"><table><thead><tr><th>Rank</th><th>Prospect</th><th>Score</th><th>Phone</th><th>Status</th><th>Follow-up</th><th>Priority</th></tr></thead><tbody>${queueRows}</tbody></table></div>` : '<div class="empty">No additional calls queued.</div>'}</section><div class="conversion-grid">${conversionTable('Conversion by niche', performance.byNiche)}${conversionTable('Conversion by score band', performance.byScoreBand)}${conversionTable('Conversion by pitch angle', performance.byPitchAngle)}</div>`,
      ),
    );
  } catch (error) {
    next(error);
  }
});

adminCallQueueRouter.post('/:queueEntryId/attempt', async (request, response, next) => {
  try {
    const status = body(request, 'status');
    if (
      !Object.values(ProspectCallStatus).includes(status as ProspectCallStatus) ||
      status === ProspectCallStatus.not_called
    ) {
      response
        .status(400)
        .send(
          adminLayout(
            'Invalid call outcome',
            '<div class="notice error">Choose a valid call status.</div>',
          ),
        );
      return;
    }
    await recordCallAttempt({
      queueEntryId: request.params.queueEntryId,
      status: status as ProspectCallStatus,
      notes: body(request, 'notes'),
      nextFollowUpAt: date(body(request, 'nextFollowUpAt')),
    });
    response.redirect(303, '/admin/call-queue');
  } catch (error) {
    next(error);
  }
});

adminCallQueueRouter.post('/:queueEntryId/priority', async (request, response, next) => {
  try {
    await setCallQueuePriority(
      request.params.queueEntryId,
      Number(body(request, 'manualPriority')),
    );
    response.redirect(303, '/admin/call-queue');
  } catch (error) {
    next(error);
  }
});
