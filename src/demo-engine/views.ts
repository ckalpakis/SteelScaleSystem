import { escapeHtml as e, MODULES, type DemoInput } from './core.js';

const styles = `:root{color-scheme:dark;--bg:#101216;--card:#1b1f26;--line:#363c48;--ink:#f4f5f7;--muted:#adb7c8;--yellow:#f5c518}*{box-sizing:border-box}body{background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,sans-serif;margin:0}header,main,footer{width:min(1080px,calc(100% - 40px));margin:auto}header{padding:28px 0;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap}main{padding:42px 0}footer{padding:30px 0;color:var(--muted);font-size:13px}.brand{font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:var(--yellow);font-weight:800}h1{font-size:clamp(30px,5vw,52px);line-height:1.1;letter-spacing:-.03em}h2{font-size:22px;margin-top:0}p,small{color:var(--muted)}a{color:var(--yellow)}a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:3px solid var(--yellow);outline-offset:4px}button,.button{display:inline-block;font:700 15px system-ui;border:0;border-radius:7px;background:var(--yellow);color:#121416;padding:12px 18px;cursor:pointer;text-decoration:none}button:disabled{opacity:.5;cursor:default}.secondary{background:transparent;color:var(--ink);border:1px solid var(--line)}section,.card{margin:22px 0;padding:26px;border:1px solid var(--line);border-radius:12px;background:var(--card)}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.wide{grid-column:1/-1}label{display:block;font-size:14px;font-weight:600}input,textarea,select{display:block;width:100%;padding:11px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink);font:inherit;margin:7px 0 16px}textarea{min-height:110px;resize:vertical}input[type=checkbox]{display:inline-block;width:auto;margin:0 9px 0 0}.check{margin:12px 0}.notice{padding:15px 18px;background:#29281d;border-left:4px solid var(--yellow);color:var(--ink);font-size:14px}.actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center}table{border-collapse:collapse;width:100%;font-size:14px}td,th{text-align:left;border-bottom:1px solid var(--line);padding:12px}th{color:var(--muted)}.table-wrap{overflow:auto}.pill{display:inline-block;padding:4px 10px;font-size:12px;border-radius:20px;background:#303745;margin:4px}.messages{white-space:pre-wrap;min-height:90px;margin:18px 0;padding:18px;border-radius:8px;background:var(--bg)}.stat{font-size:27px;color:var(--yellow);font-weight:800}.error{border-left-color:#ff8989}code{overflow-wrap:anywhere}@media(max-width:680px){.grid{grid-template-columns:1fr}.wide{grid-column:auto}section{padding:18px}header,main,footer{width:calc(100% - 28px)}}`;
export function layout(title: string, body: string, admin = false, script = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>${e(title)} · Steel Scale</title><style>${styles}</style></head><body><header><div class="brand">Steel Scale Systems · ${admin ? 'Demo Builder' : 'Interactive sales demo'}</div>${admin ? '<nav><a href="/admin">Operations</a> · <a href="/admin/leads">Leads</a> · <a href="/admin/demos">Demos</a></nav>' : '<span class="pill">Sandbox — not live customer service</span>'}</header><main>${body}</main><footer>Steel Scale Systems. ${admin ? 'Demos are created only by explicit operator action.' : 'Illustrative workflow preview. No live calls, texts, quotes, or appointments.'}</footer>${script ? `<script>${script}</script>` : ''}</body></html>`;
}
export function formView(
  input: Partial<DemoInput>,
  csrf: string,
  requestId: string,
  action: string,
  version = 0,
): string {
  const textField = (name: keyof DemoInput, title: string, max: number, required = false) =>
    `<label>${e(title)}<input name="${name}" maxlength="${max}" value="${e(input[name])}"${required ? ' required' : ''}></label>`;
  const textarea = (name: keyof DemoInput, title: string, max: number) =>
    `<label class="wide">${e(title)}<textarea name="${name}" maxlength="${max}">${e(input[name])}</textarea></label>`;
  return layout(
    'Create or update demo',
    `<h1>${version ? 'Edit demo' : 'Create an on-demand demo'}</h1><p>Enter what you know. Generate a draft, review the examples and website observations, then publish intentionally.</p><p><a href="/admin/demos/prospects">Start from an existing prospect</a> or continue with a standalone demo. No live client account is required.</p>
    <form method="post" action="${e(action)}"><input type="hidden" name="csrf" value="${e(csrf)}"><input type="hidden" name="requestId" value="${e(requestId)}"><input type="hidden" name="version" value="${version}"><input type="hidden" name="prospectBusinessId" value="${e(input.prospectBusinessId)}">
    <section><h2>Business information</h2><div class="grid">${textField('businessName', 'Business name', 160, true)}${textField('niche', 'Niche / industry', 100, true)}${textField('websiteUrl', 'Website (optional)', 2048)}${textField('googleBusinessProfileUrl', 'Google Business Profile URL (optional; reference only)', 2048)}${textField('location', 'City / service area', 200)}${textField('businessPhone', 'Business phone (private reference; never dialed)', 80)}${textarea('services', 'Verified services (comma or newline separated)', 2000)}${textarea('hours', 'Verified business hours (optional)', 600)}${textarea('publicSummary', 'Public-facing summary (optional; review before publishing)', 2000)}${textarea('salesNotes', 'Private sales notes / pain points — never included on the public page', 6000)}</div>
    <label class="check"><input type="checkbox" name="researchWebsite"${input.researchWebsite ? ' checked' : ''}>Read the public website homepage during this generation (optional).</label><p>This is a bounded HTML fetch, not a full crawl. GBP is saved as a reference link; reviews, hours, and ratings are not inferred from it.</p></section>
    <section><h2>Demo modules</h2><label>Selection mode<select name="selectionMode"><option value="custom"${input.modules?.length ? ' selected' : ''}>Use checked modules</option><option value="recommended"${!input.modules?.length ? ' selected' : ''}>Recommend from my niche and private notes</option></select></label>${Object.entries(
      MODULES,
    )
      .map(
        ([key, title]) =>
          `<label class="check"><input type="checkbox" name="modules" value="${key}"${input.modules?.includes(key as keyof typeof MODULES) ? ' checked' : ''}>${e(title)}</label>`,
      )
      .join(
        '',
      )}<p>Voice and chat support live AI conversations when enabled by the operator. Appointment bookings and messaging examples remain simulated.</p></section>
    <div class="notice">${version ? 'Saving regenerates the draft and unpublishes the previous version until you review and publish again.' : 'Generation creates a private draft only. Nothing is sent to the prospect.'}</div><p><button>Generate draft</button> <a href="/admin/demos">Cancel</a></p></form>`,
    true,
  );
}

export { publicView } from './experience-view.js';
