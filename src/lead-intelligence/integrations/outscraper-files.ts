import path from 'node:path';

function parseCsvRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else field += character;
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field');
  if (field || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows.filter((candidate) => candidate.some((value) => value.trim()));
}

function coerceCsvValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

export function parseOutscraperCsv(input: string): unknown[] {
  const rows = parseCsvRows(input.replace(/^\uFEFF/, ''));
  const headers = rows.shift()?.map((header) => header.trim());
  if (!headers?.length) return [];
  if (new Set(headers).size !== headers.length) throw new Error('CSV contains duplicate headers');
  return rows.map((values, rowIndex) => {
    if (values.length > headers.length) {
      throw new Error(`CSV row ${rowIndex + 2} has more fields than the header`);
    }
    return Object.fromEntries(
      headers.map((header, index) => [header, coerceCsvValue(values[index] ?? '')]),
    );
  });
}

function flattenJsonResults(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(flattenJsonResults);
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (Array.isArray(object.data)) return flattenJsonResults(object.data);
    if (Array.isArray(object.results)) return flattenJsonResults(object.results);
  }
  return [value];
}

export function parseOutscraperJson(input: string): unknown[] {
  return flattenJsonResults(JSON.parse(input) as unknown);
}

export function parseOutscraperFileContents(filePath: string, input: string): unknown[] {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.csv') return parseOutscraperCsv(input);
  if (extension === '.json') return parseOutscraperJson(input);
  throw new Error('Outscraper import file must use a .json or .csv extension');
}
