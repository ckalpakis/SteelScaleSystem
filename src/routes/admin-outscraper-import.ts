import express, { Router, type Request, type Response } from 'express';

import { db } from '../db/client.js';
import { parseOutscraperFileContents } from '../lead-intelligence/integrations/outscraper-files.js';
import {
  applyOutscraperFieldMapping,
  OUTSCRAPER_IMPORT_FIELDS,
  suggestOutscraperFieldMapping,
  type OutscraperFieldMapping,
} from '../lead-intelligence/integrations/outscraper-field-mapping.js';
import { importOutscraperGoogleMaps } from '../lead-intelligence/integrations/outscraper-import.js';
import { adminLayout, escapeHtml } from '../utils/html.js';

export const adminOutscraperImportRouter = Router();
const receiveFileText = express.text({ type: 'text/plain', limit: '25mb' });

function queryValue(request: Request, key: string): string | undefined {
  const input = request.query[key];
  return typeof input === 'string' && input.trim() ? input.trim() : undefined;
}

function uploadedText(request: Request): string {
  if (typeof request.body !== 'string' || !request.body.trim()) {
    throw new Error('The upload is empty');
  }
  return request.body;
}

function safeFilename(request: Request): string {
  const filename = queryValue(request, 'filename') ?? '';
  if (!/^[^/\\]{1,180}\.(?:json|csv)$/i.test(filename)) {
    throw new Error('Choose an Outscraper .json or .csv file');
  }
  return filename;
}

function displaySample(value: unknown): string {
  if (value === undefined || value === null) return '';
  const rendered = typeof value === 'string' ? value : JSON.stringify(value);
  return rendered.length > 120 ? `${rendered.slice(0, 117)}...` : rendered;
}

function parseMapping(request: Request): OutscraperFieldMapping {
  const raw = queryValue(request, 'mapping');
  if (!raw || raw.length > 10_000) throw new Error('Field mapping is missing or too large');
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Field mapping must be an object');
  }
  const allowed = new Set(OUTSCRAPER_IMPORT_FIELDS.map(({ target }) => target));
  const mapping: OutscraperFieldMapping = {};
  for (const [target, source] of Object.entries(parsed)) {
    if (!allowed.has(target) || typeof source !== 'string' || source.length > 200) continue;
    if (source) mapping[target] = source;
  }
  if (!mapping.name) throw new Error('Map a source field to Business name');
  return mapping;
}

function errorResponse(response: Response, error: unknown): void {
  response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
}

adminOutscraperImportRouter.get('/', async (_request, response, next) => {
  try {
    const clients = await db.client.findMany({
      select: { id: true, businessName: true },
      orderBy: { businessName: 'asc' },
    });
    const definitions = JSON.stringify(
      OUTSCRAPER_IMPORT_FIELDS.map(({ target, label, required }) => ({
        target,
        label,
        required,
      })),
    );
    response.send(
      adminLayout(
        'Import Google Maps leads',
        `<nav class="admin-tabs"><a href="/admin">Clients</a><a class="active" href="/admin/leads">Lead Intelligence</a><a href="/admin/call-queue">Call queue</a></nav>
        <header class="page-header"><div><a class="eyebrow" href="/admin/leads">← Lead Intelligence</a><h1>Import Outscraper results</h1><p>Upload, review field mappings, and import without database or terminal access.</p></div></header>
        <div id="import-error" class="notice error" hidden></div>
        <section class="panel">
          <div class="section-heading"><span>01</span><div><h2>Choose the batch</h2><p>JSON is recommended because it preserves nested hours, services, booking links, and evidence.</p></div></div>
          <div class="form-grid">
            <label>Client<select id="import-client"><option value="">Select a client</option>${clients.map((client) => `<option value="${client.id}">${escapeHtml(client.businessName)}</option>`).join('')}</select></label>
            <label>Country calling code<input id="country-code" value="1" inputmode="numeric"><small>Used to normalize domestic phone numbers.</small></label>
            <label class="wide">Outscraper JSON or CSV<input id="lead-file" type="file" accept=".json,.csv,application/json,text/csv" required><small>Maximum upload size: 25 MB.</small></label>
            <div class="form-actions wide"><button id="analyze-file" type="button">Preview and map fields</button></div>
          </div>
        </section>
        <section id="mapping-panel" class="panel" hidden>
          <div class="section-heading"><span>02</span><div><h2>Confirm field mapping</h2><p id="preview-summary"></p></div></div>
          <div class="table-wrap"><table><thead><tr><th>Canonical field</th><th>Source field</th><th>Example</th></tr></thead><tbody id="mapping-rows"></tbody></table></div>
          <details class="import-advanced"><summary>Advanced import settings</summary><div class="form-grid"><label class="wide">Idempotency key<input id="idempotency-key"><small>Generated from this file. Keep it unchanged when retrying the same batch.</small></label></div></details>
          <div class="import-submit"><button id="run-import" type="button">Import mapped records</button></div>
        </section>
        <section id="import-result" class="panel" hidden></section>
        <script>
        (() => {
          const definitions = ${definitions};
          const byId = (id) => document.getElementById(id);
          let selectedFile;
          let preview;
          const showError = (message) => { const box = byId('import-error'); box.textContent = message; box.hidden = false; };
          const clearError = () => { byId('import-error').hidden = true; };
          const request = async (path, file) => {
            const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: await file.text() });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Import request failed');
            return result;
          };
          const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
          byId('analyze-file').addEventListener('click', async () => {
            clearError();
            selectedFile = byId('lead-file').files[0];
            if (!selectedFile) return showError('Choose a JSON or CSV file first.');
            if (!byId('import-client').value) return showError('Select the client that owns these prospects.');
            const button = byId('analyze-file'); button.disabled = true; button.textContent = 'Reading file…';
            try {
              preview = await request('/admin/leads/import/preview?filename=' + encodeURIComponent(selectedFile.name), selectedFile);
              byId('preview-summary').textContent = preview.recordCount.toLocaleString() + ' records and ' + preview.fields.length + ' source fields detected.';
              const rows = byId('mapping-rows'); rows.replaceChildren();
              for (const definition of definitions) {
                const row = document.createElement('tr');
                const target = document.createElement('td'); target.textContent = definition.label + (definition.required ? ' (required)' : '');
                const sourceCell = document.createElement('td');
                const select = document.createElement('select'); select.dataset.target = definition.target;
                select.append(new Option('Not mapped', ''));
                for (const field of preview.fields) select.append(new Option(field, field));
                select.value = preview.suggestions[definition.target] || '';
                sourceCell.append(select);
                const example = document.createElement('td'); example.className = 'mapping-example';
                const updateExample = () => { example.textContent = select.value ? (preview.samples[select.value] || '—') : '—'; };
                select.addEventListener('change', updateExample); updateExample();
                row.append(target, sourceCell, example); rows.append(row);
              }
              const filenameParts = selectedFile.name.split('.'); filenameParts.pop();
              byId('idempotency-key').value = 'admin-' + slug(filenameParts.join('.') || selectedFile.name) + '-' + selectedFile.size + '-' + selectedFile.lastModified;
              byId('mapping-panel').hidden = false; byId('import-result').hidden = true;
              byId('mapping-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
            } catch (error) { showError(error instanceof Error ? error.message : String(error)); }
            finally { button.disabled = false; button.textContent = 'Preview and map fields'; }
          });
          byId('run-import').addEventListener('click', async () => {
            clearError();
            if (!selectedFile || !preview) return showError('Preview the file before importing.');
            const mapping = {};
            document.querySelectorAll('#mapping-rows select').forEach((select) => { if (select.value) mapping[select.dataset.target] = select.value; });
            if (!mapping.name) return showError('Choose a source field for Business name.');
            const params = new URLSearchParams({ filename: selectedFile.name, clientId: byId('import-client').value, countryCode: byId('country-code').value.trim(), idempotencyKey: byId('idempotency-key').value.trim(), mapping: JSON.stringify(mapping) });
            const button = byId('run-import'); button.disabled = true; button.textContent = 'Importing… keep this page open';
            try {
              const result = await request('/admin/leads/import/execute?' + params.toString(), selectedFile);
              const panel = byId('import-result'); panel.replaceChildren(); panel.hidden = false;
              const heading = document.createElement('div'); heading.className = 'section-heading'; heading.innerHTML = '<span>03</span><div><h2>Import complete</h2><p>The canonical ingestion report is shown below.</p></div>';
              const report = document.createElement('dl'); report.className = 'import-report';
              const values = [['Status', result.status], ['Records', result.received], ['Created businesses', result.newBusinesses], ['Existing businesses updated', result.updatedBusinesses], ['Duplicates', result.duplicates], ['Rejected', result.invalid + result.failed], ['Signals created/updated', result.signalsCreated + result.signalsUpdated]];
              for (const [label, resultValue] of values) { const box = document.createElement('div'); const dt = document.createElement('dt'); const dd = document.createElement('dd'); dt.textContent = label; dd.textContent = typeof resultValue === 'number' ? resultValue.toLocaleString() : resultValue; box.append(dt, dd); report.append(box); }
              const actions = document.createElement('div'); actions.className = 'import-submit'; actions.innerHTML = '<a class="button" href="/admin/leads">View imported prospects</a>';
              panel.append(heading, report, actions); panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } catch (error) { showError(error instanceof Error ? error.message : String(error)); }
            finally { button.disabled = false; button.textContent = 'Import mapped records'; }
          });
        })();
        </script>`,
      ),
    );
  } catch (error) {
    next(error);
  }
});

adminOutscraperImportRouter.post('/preview', receiveFileText, (request, response) => {
  try {
    const filename = safeFilename(request);
    const records = parseOutscraperFileContents(filename, uploadedText(request));
    if (!records.length) throw new Error('The file contains no records');
    if (records.length > 25_000)
      throw new Error('A single admin import is limited to 25,000 records');
    const fields = [
      ...new Set(
        records.flatMap((record) =>
          record && typeof record === 'object' && !Array.isArray(record) ? Object.keys(record) : [],
        ),
      ),
    ].sort((left, right) => left.localeCompare(right));
    if (!fields.length) throw new Error('No object fields were detected in this file');
    const samples = Object.fromEntries(
      fields.map((field) => {
        const sample = records
          .map((record) =>
            record && typeof record === 'object' && !Array.isArray(record)
              ? (record as Record<string, unknown>)[field]
              : undefined,
          )
          .find((entry) => entry !== undefined && entry !== null && entry !== '');
        return [field, displaySample(sample)];
      }),
    );
    response.json({
      recordCount: records.length,
      fields,
      samples,
      suggestions: suggestOutscraperFieldMapping(fields),
    });
  } catch (error) {
    errorResponse(response, error);
  }
});

adminOutscraperImportRouter.post('/execute', receiveFileText, async (request, response) => {
  try {
    const filename = safeFilename(request);
    const clientId = queryValue(request, 'clientId');
    const idempotencyKey = queryValue(request, 'idempotencyKey');
    const countryCode = queryValue(request, 'countryCode');
    if (!clientId || !(await db.client.count({ where: { id: clientId } }))) {
      throw new Error('Select a valid client');
    }
    if (!idempotencyKey || idempotencyKey.length > 180) {
      throw new Error('Provide an idempotency key of 180 characters or fewer');
    }
    const mapping = parseMapping(request);
    const records = parseOutscraperFileContents(filename, uploadedText(request));
    if (!records.length || records.length > 25_000) {
      throw new Error('Import must contain 1-25,000 records');
    }
    const result = await importOutscraperGoogleMaps({
      clientId,
      idempotencyKey,
      records: applyOutscraperFieldMapping(records, mapping),
      sourceReference: `admin-upload:${filename}`,
      defaultCountryCallingCode: countryCode,
      metadata: {
        importType: filename.toLowerCase().endsWith('.json') ? 'json' : 'csv',
        filename,
        mapping,
      },
    });
    response.json(result);
  } catch (error) {
    errorResponse(response, error);
  }
});
