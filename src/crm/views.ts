import type { CustomFieldDefinition, Organization, OrganizationMember, User } from '@prisma/client';
import { adminLayout, escapeHtml as e } from '../utils/html.js';
import type { CrmEntity, CrmService } from './service.js';
import type { Resource } from './validation.js';

const value = (v: unknown) =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
const input = (
  label: string,
  name: string,
  current: unknown = '',
  type = 'text',
  required = false,
) =>
  `<label>${e(label)}<input name="${name}" type="${type}" value="${e(value(current))}" ${required ? 'required' : ''} ${type === 'number' ? (name.startsWith('custom_') ? 'step="any"' : 'step="1" min="0"') : ''}></label>`;
const select = (
  label: string,
  name: string,
  options: Array<[string, string]>,
  current: unknown = '',
  required = false,
) =>
  `<label>${e(label)}<select aria-label="${e(label)}" name="${name}" ${required ? 'required' : ''}>${options.map(([id, label]) => `<option value="${e(id)}" ${id === value(current) ? 'selected' : ''}>${e(label)}</option>`).join('')}</select></label>`;

export function crmLayout(
  organization: Organization,
  active: string,
  title: string,
  body: string,
  workspace = false,
): string {
  const root = workspace ? '/workspace/crm' : `/admin/crm/${organization.id}`;
  return adminLayout(
    title,
    `<style>.crm-board{display:flex;gap:14px;overflow-x:auto;padding:4px 0 18px}.crm-column{flex:0 0 270px;background:#e8eef5;border-radius:6px;padding:12px}.crm-column h2{display:flex;justify-content:space-between;font-size:15px;margin:0 0 12px}.crm-card{display:block;background:#fff;padding:14px;border:1px solid #d7dee8;border-radius:5px;margin:10px 0;text-decoration:none}.crm-card strong{display:block;color:#172033}.crm-card small{display:block;margin-top:8px}.crm-timeline{list-style:none;padding:0;margin:0}.crm-timeline li{padding:14px 18px;border-bottom:1px solid #d7dee8}.crm-timeline time{display:block;color:#526174;font-size:12px}.crm-timeline pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;margin:6px 0}.crm-detail{padding:18px}.crm-inline{display:flex;gap:12px;align-items:end;flex-wrap:wrap}.crm-inline label{flex:1;min-width:150px}.crm-inline button{margin-bottom:1px}.crm-context{display:flex;justify-content:space-between;gap:12px;margin-bottom:14px}.crm-context a{font-size:12px}.crm-heading{margin-bottom:18px}.crm-board:focus-visible{outline:3px solid #f59e0b}@media(max-width:760px){.crm-inline{display:block}.crm-inline>*{margin-bottom:10px}.crm-context{display:block}}</style>
    <div class="crm-context"><strong>${e(organization.name)}</strong>${workspace ? '<a href="/workspace">Back to Today</a>' : '<a href="/admin/crm">Switch organization</a>'}</div>
    <nav class="admin-tabs" aria-label="CRM">${[
      ['contacts', 'Contacts'],
      ['opportunities', 'Opportunities'],
      ['pipeline', 'Pipeline'],
      ['pipelines', 'Pipeline settings'],
    ]
      .map(
        ([path, label]) =>
          `<a href="${root}/${path}" ${active === path ? 'class="active" aria-current="page"' : ''}>${label}</a>`,
      )
      .join('')}</nav>
    <div class="crm-heading"><h1>${e(title)}</h1></div>${body}`,
    workspace,
  );
}

export function money(amount: unknown, currency: unknown): string {
  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: value(currency) || 'USD',
  });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(Number(amount ?? 0) / 10 ** digits);
}

export interface FormContext {
  organization: Organization;
  csrf: string;
  action: string;
  contacts: CrmEntity[];
  stages: CrmEntity[];
  pipelines: CrmEntity[];
  members: Array<OrganizationMember & { user: User | null }>;
  fields: CustomFieldDefinition[];
  customValues?: Record<string, unknown>;
}
export function entityForm(kind: Resource, ctx: FormContext, row?: CrmEntity): string {
  const fields: string[] = [];
  if (kind === 'contacts') {
    fields.push(
      input('Name', 'name', row?.name, 'text', true),
      input('Email', 'email', row?.email, 'email'),
      input('Phone (international format)', 'phone', row?.phone, 'tel'),
    );
  } else if (kind === 'opportunities') {
    fields.push(input('Opportunity', 'title', row?.title, 'text', true));
    if (!row)
      fields.push(
        select(
          'Contact',
          'customerId',
          [
            ['', 'Choose a contact'],
            ...ctx.contacts.map((c): [string, string] => [c.id, value(c.name)]),
          ],
          '',
          true,
        ),
      );
    const pipelineNames = new Map(ctx.pipelines.map((p) => [p.id, value(p.name)]));
    fields.push(
      select(
        'Pipeline and stage',
        'stageSelection',
        [
          ['', 'Choose a stage'],
          ...ctx.stages.map((s): [string, string] => [
            `${value(s.pipelineId)}:${s.id}`,
            `${pipelineNames.get(value(s.pipelineId)) ?? 'Pipeline'} / ${value(s.name)}`,
          ]),
        ],
        row?.stageId ? `${value(row.pipelineId)}:${value(row.stageId)}` : '',
        true,
      ),
      input('Value in currency minor units', 'amountMinor', row?.amountMinor ?? 0, 'number', true),
    );
    if (!row)
      fields.push(input('Currency', 'currency', ctx.organization.defaultCurrency, 'text', true));
    else
      fields.push(
        `<p>Currency: ${e(value(row.currency))}. Values use minor units: for USD, 100 = $1.00.</p>`,
      );
  } else if (kind === 'pipelines') {
    fields.push(
      input('Pipeline name', 'name', row?.name, 'text', true),
      input('Description', 'description', row?.description),
    );
  } else if (kind === 'stages') {
    fields.push(input('Stage name', 'name', row?.name, 'text', true));
    if (!row)
      fields.push(
        select(
          'Pipeline',
          'pipelineId',
          ctx.pipelines.map((p): [string, string] => [p.id, value(p.name)]),
          '',
          true,
        ),
      );
    fields.push(
      input('Position', 'position', row?.position ?? 0, 'number', true),
      select(
        'Outcome',
        'outcome',
        [
          ['open', 'Open'],
          ['won', 'Won'],
          ['lost', 'Lost'],
        ],
        row?.outcome ?? 'open',
      ),
    );
  }
  if (kind === 'contacts' || kind === 'opportunities') {
    const currentAssignee = row?.record.assignedMemberId;
    fields.push(
      select(
        'Assigned to',
        'assignedMemberId',
        [
          ['', 'Unassigned'],
          ...(currentAssignee && !ctx.members.some((m) => m.active && m.id === currentAssignee)
            ? [
                [currentAssignee, 'Current assignee (inactive or outside this list)'] as [
                  string,
                  string,
                ],
              ]
            : []),
          ...ctx.members
            .filter((m) => m.active)
            .map((m): [string, string] => [m.id, m.displayName ?? m.user?.name ?? m.subject]),
        ],
        row?.record.assignedMemberId,
      ),
    );
    for (const field of ctx.fields.filter(
      (f) => f.entityType === (kind === 'contacts' ? 'contact' : 'opportunity'),
    )) {
      const current = ctx.customValues?.[field.id];
      const name = `custom_${field.id}`;
      if (field.fieldType === 'boolean')
        fields.push(
          select(
            field.label,
            name,
            [
              ['', 'Not set'],
              ['true', 'Yes'],
              ['false', 'No'],
            ],
            current,
            field.required,
          ),
        );
      else if (field.fieldType === 'single_select')
        fields.push(
          select(
            field.label,
            name,
            [['', 'Not set'], ...field.options.map((v): [string, string] => [v, v])],
            current,
            field.required,
          ),
        );
      else
        fields.push(
          input(
            field.fieldType === 'multi_select' ? `${field.label} (comma-separated)` : field.label,
            name,
            Array.isArray(current) ? current.join(', ') : current,
            field.fieldType === 'date' ? 'date' : field.fieldType === 'number' ? 'number' : 'text',
            field.required,
          ),
        );
    }
  }
  return `<form class="form-grid" method="post" action="${e(ctx.action)}"><input type="hidden" name="csrf" value="${e(ctx.csrf)}">${row ? `<input type="hidden" name="expectedVersion" value="${row.record.version}">` : ''}${fields.join('')}<div class="wide form-actions"><button type="submit">${row ? 'Save changes' : `Create ${kind === 'opportunities' ? 'opportunity' : kind === 'contacts' ? 'contact' : kind === 'stages' ? 'stage' : 'pipeline'}`}</button></div></form>`;
}

export function recordTable(
  kind: 'contacts' | 'opportunities' | 'pipelines',
  rows: CrmEntity[],
  root: string,
  stageNames = new Map<string, string>(),
): string {
  if (!rows.length)
    return '<div class="empty">No records yet. Use the form above to add the first one.</div>';
  return `<div class="table-wrap"><table><thead><tr>${(kind === 'contacts' ? ['Name', 'Email', 'Phone'] : kind === 'opportunities' ? ['Opportunity', 'Stage', 'Value'] : ['Pipeline', 'Description']).map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr><td><a class="primary-link" href="${root}/${kind}/${row.id}">${e(value(row.name ?? row.title))}</a></td>${kind === 'contacts' ? `<td>${e(value(row.email))}</td><td>${e(value(row.phone))}</td>` : kind === 'opportunities' ? `<td>${e(stageNames.get(value(row.stageId)) ?? 'Unassigned')}</td><td>${e(money(row.amountMinor, row.currency))}</td>` : `<td>${e(value(row.description))}</td>`}</tr>`).join('')}</tbody></table></div>`;
}

export function timeline(detail: Awaited<ReturnType<CrmService['detail']>>): string {
  if (!detail.activity.length) return '<p class="empty">No activity recorded yet.</p>';
  return `<ol class="crm-timeline">${detail.activity
    .map((event) => {
      const payload = event.payload as {
        changes?: { body?: string; title?: string; name?: string };
        data?: { changes?: { body?: string; title?: string; name?: string } };
      };
      const changes = payload?.data?.changes ?? payload?.changes;
      const summary = changes?.body ?? changes?.title ?? changes?.name;
      return `<li><time datetime="${event.receivedAt.toISOString()}">${e(event.receivedAt.toISOString().replace('T', ' ').slice(0, 19))} UTC</time><strong>${e(event.type.replaceAll('_', ' ').replaceAll('.', ' · '))}</strong>${summary ? `<pre>${e(summary)}</pre>` : ''}</li>`;
    })
    .join('')}</ol>`;
}

export function pipelineBoard(
  opportunities: CrmEntity[],
  stages: CrmEntity[],
  root: string,
): string {
  const columns = [...stages].sort((a, b) => Number(a.position) - Number(b.position));
  return `<div class="crm-board" tabindex="0" aria-label="Opportunity pipeline">${columns
    .map((stage) => {
      const items = opportunities.filter((o) => value(o.stageId) === stage.id);
      return `<section class="crm-column"><h2>${e(value(stage.name))}<span class="badge">${items.length}</span></h2>${items.length ? items.map((row) => `<a class="crm-card" href="${root}/opportunities/${row.id}"><strong>${e(value(row.title))}</strong><small>${e(money(row.amountMinor, row.currency))}</small></a>`).join('') : '<p>No opportunities in this stage.</p>'}</section>`;
    })
    .join('')}</div>`;
}
