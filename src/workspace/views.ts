import { workspaceLayout, escapeHtml as e } from '../utils/html.js';
import { money } from '../crm/views.js';
import type { WorkspaceOverview } from './service.js';

const date = (value: Date) => value.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const title = (value: string) => value.replaceAll('_', ' ');
const css = `<style>
  .topbar>div{gap:20px;flex-wrap:wrap;padding:16px 0}.topbar nav{display:flex;gap:7px;flex-wrap:wrap;font-size:13px}
  .workspace{max-width:1220px;margin:auto}.workspace header p{max-width:78ch}.workspace h2{font-size:21px}
  .workspace-grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(300px,1fr);gap:24px;align-items:start}.workspace-grid>*{min-width:0}
  .workspace .pad{padding:20px}.workspace .panel>h2{padding:20px 20px 0}.workspace .panel>p{padding:8px 20px}
  .workspace .status-line{display:flex;gap:10px;flex-wrap:wrap;margin:20px 0}.workspace .status-line span{padding:7px 10px;background:#e2e8f0;border-radius:4px}
  .workspace .warning{border-left:4px solid var(--warn);background:#fffbeb;padding:14px 18px;margin:14px 0}.workspace .warning p{color:var(--ink)}
  .workspace .work-item{padding:18px 20px;border-top:1px solid var(--line)}.workspace .work-item:first-child{border-top:0}.workspace .work-item h3{font-size:16px;margin:0 0 4px}.workspace .work-item small{display:block;margin:8px 0}
  .workspace .checklist{list-style:none;padding:0;margin:0}.workspace .checklist li{padding:17px 20px;border-top:1px solid var(--line)}.workspace .checklist h3{margin:0 0 6px;font-size:15px}.workspace .checklist p{margin:6px 0 10px}
  .workspace .filters{display:flex;gap:12px;align-items:end;flex-wrap:wrap;margin:18px 0}.workspace .filters label{flex:1;min-width:160px}.workspace .filters select{margin-top:4px}
  .workspace .results{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:1px solid var(--line);background:white;margin:18px 0}.workspace .results>div{padding:20px;border-right:1px solid var(--line)}.workspace .results>div:last-child{border:0}.workspace .results strong{display:block;font-size:24px;color:var(--navy);margin:8px 0}.workspace .results small{display:block}
  .workspace .details-table{min-width:600px}.workspace .subtle{font-size:13px}.workspace .text-link{display:inline-block;margin-top:8px}.workspace .empty{text-align:left;padding:20px}
  @media(max-width:850px){.workspace-grid{grid-template-columns:1fr}.workspace .results{grid-template-columns:1fr}.workspace .results>div{border-right:0;border-bottom:1px solid var(--line)}.workspace .filters button{width:100%}.admin-tabs{overflow-x:auto}}
</style>`;

export function workspacePage(data: WorkspaceOverview, role?: string) {
  const admin = role === 'owner' || role === 'admin';
  const recoveryLink = (label: string) =>
    data.features.recovery
      ? `<a href="/revenue-recovery">${e(label)}</a>`
      : 'Ask your operator to enable Revenue Recovery.';
  const completed = data.checks.filter((check) => check.complete).length;
  const urgent = [
    data.uncertainDeliveries
      ? `<p><strong>Messages with unknown delivery status: ${data.uncertainDeliveries}.</strong> Do not resend blindly: reconcile the provider receipt first. ${recoveryLink('Review delivery exceptions')}</p>`
      : '',
    data.failedDeliveries
      ? `<p>${data.failedDeliveries} failed message deliveries are retained. ${recoveryLink('Review failures before retrying')}</p>`
      : '',
    data.approvals
      ? `<p><strong>${data.approvals} message drafts await approval.</strong> ${admin ? recoveryLink('Review exact drafts') : 'An organization admin must review these.'}</p>`
      : '',
    data.expiredApprovals
      ? `<p>${data.expiredApprovals} expired approvals await worker reconciliation. They cannot authorize a send. ${recoveryLink('Review agent activity')}</p>`
      : '',
    data.outboundFailures
      ? `<p>${data.outboundFailures} outbound webhook deliveries failed. ${admin ? '<a href="/integrations">Review integration errors</a>' : 'Ask an organization admin to review integration errors.'}</p>`
      : '',
  ].filter(Boolean);
  const work = data.handoffs
    .map((handoff) => {
      const waiting = Math.max(
        0,
        Math.floor((data.now.getTime() - handoff.updatedAt.getTime()) / 3600000),
      );
      const opportunity = handoff.case.opportunity;
      return `<article class="work-item"><h3>${e(handoff.case.contact.name)}</h3><p>${e(opportunity.title)} · ${e(money(opportunity.amountMinor, opportunity.currency))}</p><p><strong>${e(title(handoff.reason))}</strong></p><small>${e(handoff.assignedMember ? (handoff.assignedMember.displayName ?? 'Assigned member') : 'Unassigned — admin attention needed')} · ${e(title(handoff.status))} · ${waiting < 1 ? 'Less than 1 hour' : `${waiting} hours`} since last handoff update</small>${data.features.recovery ? `<a class="button secondary" href="/revenue-recovery/cases/${handoff.caseId}">Review conversation</a>` : ''}</article>`;
    })
    .join('');
  const checklist = data.checks
    .map((check) => {
      const featureAvailable =
        check.key === 'records' ||
        check.key === 'delivery' ||
        (check.key === 'knowledge' && data.features.knowledge) ||
        data.features.recovery;
      return `<li><h3><span class="badge ${check.complete ? 'success' : ''}">${check.complete ? 'Recorded' : 'To review'}</span> ${e(check.title)}</h3><p>${e(check.detail)}</p>${admin && featureAvailable ? `<a href="${check.href}">${e(check.action)}</a>` : '<small>Review this step with your organization admin.</small>'}</li>`;
    })
    .join('');
  const revenue = data.revenue
    .map(
      (row) =>
        `<strong>${e(money(row._sum.amountMinor, row.currency))}</strong><small>${row._count} reviewed opportunities · ${e(row.currency)}</small>`,
    )
    .join('');
  const evidence = data.evidence
    .map(
      (row) =>
        `<tr><td>${data.features.recovery ? `<a href="/revenue-recovery/cases/${row.caseId}">${e(row.case.opportunity.title)}</a>` : e(row.case.opportunity.title)}<small class="block">${e(row.kind)}</small></td><td>${e(title(row.status))}<small class="block">${row.reviewedAt ? 'Human-reviewed' : 'Not reviewed'}</small></td><td>${date(row.occurredAt)}</td></tr>`,
    )
    .join('');
  return workspaceLayout(
    'Today',
    `${css}<div class="workspace">
    <header><div class="eyebrow">${e(data.organization.name)}</div><h1>Your workforce, at a glance</h1><p>Start with the people who need you. Then check launch requirements and the results you can substantiate.</p><p class="subtle">Snapshot: ${date(data.now)}. Reload to see new activity.</p></header>
    ${!data.organization.active ? '<div class="notice error" role="status">Organization inactive. Contact your operator before resuming work.</div>' : ''}
    <div class="status-line" aria-label="Recovery configuration status"><span>Agent: <strong>${data.agentEnabled ? 'Enabled' : 'Disabled'}</strong></span><span>Model switch: ${data.modelSwitch ? 'On' : 'Off'}</span><span>Recovery delivery switch: ${data.deliverySwitch ? 'On' : 'Off'}</span><span>${data.working} cases monitoring or working</span></div>
    <p class="subtle">Switches reflect this web service’s configuration, not worker or provider health. ${data.lastDelivery ? `Last recorded delivered message: ${date(data.lastDelivery)}.` : 'No delivered recovery message has been recorded yet.'}</p>
    ${urgent.length ? `<section class="warning" aria-label="Needs attention"><h2>Needs attention</h2>${urgent.join('')}</section>` : ''}
    <div class="workspace-grid"><section><div class="page-header" style="margin:24px 0 0"><div><h2>Human work queue</h2><p>Oldest update first. AI stays paused while a human owns the handoff.</p></div></div>
      <form method="get" class="filters"><input type="hidden" name="days" value="${data.filters.days}"><label>Show handoffs<select name="queue">${(['all', 'mine', 'unassigned'] as const).map((value) => `<option value="${value}" ${data.filters.queue === value ? 'selected' : ''}>${value === 'mine' ? 'Assigned to me' : value === 'all' ? 'All open handoffs' : 'Unassigned'}</option>`).join('')}</select></label><button>Update queue</button></form>
      <p>${data.queueCount} matching handoffs · ${data.agingCount} unchanged for at least 24 hours</p>
      <div class="panel">${work || `<div class="empty"><h3>${data.filters.queue === 'mine' ? 'No open handoffs assigned to you' : 'No handoffs in this view'}</h3><p>${data.filters.queue === 'mine' ? 'Check all open handoffs or ask your admin about unassigned conversations.' : 'Customer replies that need a person appear here. No follow-up needs to be sent to test the workflow.'}</p><p>${recoveryLink('Open Recovery and try a simulation')}</p></div>`}</div>
      ${data.queueCount > 30 ? '<p>Showing the 30 oldest matches. Resolve these first or filter to your own work.</p>' : ''}
      <section class="panel pad"><h2>Business data</h2><p>Current unsold pipeline, not attributed recovery revenue.</p>${data.pipeline.length ? data.pipeline.map((row) => `<p><strong>${e(money(row._sum.amountMinor, row.currency))}</strong> · ${row._count} open opportunities · ${e(row.currency)}</p>`).join('') : '<p>No open opportunities yet. Add a contact and opportunity, or connect the CRM you already use.</p>'}<div class="header-actions" style="margin-top:16px">${data.features.crm ? '<a class="button secondary" href="/workspace/crm/contacts">Open CRM</a>' : ''}${admin ? '<a class="button secondary" href="/integrations">Connect existing CRM</a>' : ''}</div></section>
    </section><aside class="panel"><h2>Recovery launch checklist</h2><p>${completed} of ${data.checks.length} setup records present. This is guidance—not clearance to send.</p><ol class="checklist">${checklist}</ol><p class="subtle">No step here enables an agent. Approval, DND, consent, operating hours, and policy checks remain mandatory at execution.</p></aside></div>
    <section aria-labelledby="results-title"><h2 id="results-title">Recovery results with evidence</h2><form method="get" class="filters"><input type="hidden" name="queue" value="${data.filters.queue}"><label>Outcome window<select name="days">${[7, 30, 90].map((days) => `<option value="${days}" ${days === data.filters.days ? 'selected' : ''}>Last ${days} days</option>`).join('')}</select></label><button>Update results</button></form>
    <p>${date(data.from)} through ${date(data.now)}. Based on when the outcome occurred, not when payment was received or a review was completed.</p>
    <div class="results"><div>Verified recovered payments${revenue || '<strong>No verified payments</strong>'}<small>Human-reviewed AI_RECOVERED opportunities with a recorded payment reference and positive paid amount. Currencies are never combined.</small></div><div>Recovered appointments<strong>${data.recoveredAppointments}</strong><small>Human-reviewed AI_RECOVERED appointment outcomes.</small></div><div>Outcomes awaiting evidence review<strong>${data.pendingEvidence}</strong><small>Unreviewed outcomes are excluded from verified totals.</small></div></div>
    <p class="subtle">This is attributed payment evidence, not profit, incremental revenue, or a causal ROI claim. Assisted and uncertain outcomes are not recovered revenue. Reviews can restate earlier windows.</p>
    <p class="subtle">Recorded statuses: ${data.outcomes.length ? data.outcomes.map((row) => `${e(title(row.status))}: ${row._count}`).join(' · ') : 'No outcomes recorded in this window.'}</p>
    <div class="panel table-wrap"><table class="details-table"><caption class="pad" style="text-align:left">20 most recent outcomes in this window. Open a case to inspect or review its evidence.</caption><thead><tr><th scope="col">Opportunity / outcome</th><th scope="col">Attribution</th><th scope="col">Occurred</th></tr></thead><tbody>${evidence || '<tr><td colspan="3">No outcome evidence yet. Delivered messages and customer engagement must precede recovery; simply monitoring an opportunity earns no revenue credit.</td></tr>'}</tbody></table></div></section>
  </div>`,
  );
}
