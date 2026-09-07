/** On-demand sales demonstrations. This module has no production integration dependencies. */
export const MODULES = {
  voice: 'Receptionist conversation preview',
  chatbot: 'Website chat simulation',
  missed_call: 'Missed-call recovery simulation',
  nurture: 'Lead nurture simulation',
  audit: 'Homepage observations',
  roi: 'ROI scenario calculator',
} as const;
export type DemoModule = keyof typeof MODULES;
export type DemoInput = {
  businessName: string;
  niche: string;
  websiteUrl: string;
  googleBusinessProfileUrl: string;
  location: string;
  businessPhone: string;
  services: string;
  hours: string;
  publicSummary: string;
  salesNotes: string;
  prospectBusinessId: string;
  modules: DemoModule[];
  researchWebsite: boolean;
};
export type WebsiteEvidence = {
  status: 'not_requested' | 'fetched' | 'unavailable';
  sourceUrl: string;
  checkedAt: string;
  title: string;
  description: string;
  observations: string[];
  warning: string;
};
export type Presentation = {
  schemaVersion: 1;
  businessName: string;
  niche: string;
  websiteUrl: string;
  googleBusinessProfileUrl: string;
  location: string;
  services: string[];
  servicesSource: 'operator' | 'illustrative_template';
  hours: string;
  summary: string;
  modules: DemoModule[];
  websiteEvidence: WebsiteEvidence;
  disclosure: string;
};
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const TOKEN = /^[0-9a-f]{64}$/;
export const EVENTS = ['opened', 'voice_previewed', 'chatbot_tested', 'missed_call_tested', 'nurture_tested', 'audit_viewed', 'roi_used'] as const;
export class InputError extends Error {}

function text(body: Record<string, unknown>, key: string, max: number): string {
  const value = body[key];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max) throw new InputError(`${key}: invalid or too long (maximum ${max} characters).`);
  return value.trim();
}
export function normalizeBusinessUrl(value: string): string {
  if (!value) return '';
  let url: URL;
  try { url = new URL(value.includes('://') ? value : `https://${value}`); }
  catch { throw new InputError('Enter a valid HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) {
    throw new InputError('URLs must use HTTP/HTTPS, standard ports, and no embedded credentials.');
  }
  url.hash = '';
  return url.toString();
}
export function recommendModules(niche: string, salesNotes: string): DemoModule[] {
  // Recommendations are from operator-provided context, NOT unmeasured claims about this business.
  const notes = salesNotes.toLowerCase();
  if (/facebook|lead form|nurtur|follow.up|response speed|slow.*respond/.test(notes)) return ['nurture', 'chatbot', 'roi'];
  if (/missed call|unanswered|after.hours|receptionist/.test(notes)) return ['missed_call', 'voice', 'chatbot', 'roi'];
  if (/website|seo|google|ranking/.test(notes)) return ['audit', 'chatbot', 'roi'];
  return /insurance|real estate/i.test(niche) ? ['nurture', 'chatbot', 'roi'] : ['voice', 'missed_call', 'chatbot', 'roi'];
}
export function parseInput(raw: unknown): DemoInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InputError('Invalid form.');
  const body = raw as Record<string, unknown>;
  const businessName = text(body, 'businessName', 160);
  const niche = text(body, 'niche', 100);
  if (!businessName || !niche) throw new InputError('Business name and niche are required.');
  const salesNotes = text(body, 'salesNotes', 6000);
  const prospectBusinessId = text(body, 'prospectBusinessId', 36);
  if (prospectBusinessId && !UUID.test(prospectBusinessId)) throw new InputError('Invalid prospect ID.');
  let modules: DemoModule[];
  if (body.selectionMode === 'recommended') modules = recommendModules(niche, salesNotes);
  else {
    const values = Array.isArray(body.modules) ? body.modules : body.modules ? [body.modules] : [];
    if (!values.length || values.some((item) => typeof item !== 'string' || !Object.hasOwn(MODULES, item))) {
      throw new InputError('Choose at least one supported module.');
    }
    modules = [...new Set(values)] as DemoModule[];
  }
  return {
    businessName, niche, salesNotes, prospectBusinessId, modules,
    websiteUrl: normalizeBusinessUrl(text(body, 'websiteUrl', 2048)),
    googleBusinessProfileUrl: normalizeBusinessUrl(text(body, 'googleBusinessProfileUrl', 2048)),
    location: text(body, 'location', 200),
    businessPhone: text(body, 'businessPhone', 80),
    services: text(body, 'services', 2000),
    hours: text(body, 'hours', 600),
    publicSummary: text(body, 'publicSummary', 2000),
    researchWebsite: body.researchWebsite === 'on' || body.researchWebsite === true,
  };
}
export function emptyEvidence(sourceUrl = ''): WebsiteEvidence {
  return { status: 'not_requested', sourceUrl, checkedAt: '', title: '', description: '', observations: [], warning: 'Homepage not checked. Google Business Profile data is not fetched by this release.' };
}
function plain(value: string): string {
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}
export function extractEvidence(html: string, sourceUrl: string, checkedAt: string): WebsiteEvidence {
  const title = plain(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').slice(0, 300);
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  const descriptionTag = tags.find((tag) => /\bname\s*=\s*["']description["']/i.test(tag)) ?? '';
  const description = plain(descriptionTag.match(/\bcontent\s*=\s*(["'])([\s\S]*?)\1/i)?.[2] ?? '').slice(0, 600);
  return {
    status: 'fetched', sourceUrl, checkedAt, title, description,
    observations: [
      title ? 'An HTML page title was found.' : 'No page title was detected in the fetched HTML.',
      description ? 'A meta description was found.' : 'No quoted meta description was detected in the fetched HTML.',
      /name\s*=\s*["']viewport["']/i.test(html) ? 'A mobile viewport tag was detected.' : 'No quoted mobile viewport tag was detected.',
      /href\s*=\s*["']tel:/i.test(html) ? 'A telephone link was detected.' : 'No quoted telephone link was detected.',
      /application\/ld\+json/i.test(html) ? 'A JSON-LD marker was detected; its validity was not assessed.' : 'No JSON-LD marker was detected.',
    ],
    warning: 'Single-page HTML observations, not a Lighthouse test, accessibility audit, ranking report, or revenue estimate. JavaScript-rendered features may be missed. Verify findings before publishing. Google Business Profile data was not fetched.',
  };
}
function packServices(niche: string): string[] {
  if (/insurance/i.test(niche)) return ['Coverage inquiry', 'Quote consultation', 'Policy review'];
  if (/plumb/i.test(niche)) return ['Leak assessment', 'Drain service', 'Water heater inquiry'];
  if (/hvac|heating|cooling/i.test(niche)) return ['Heating inquiry', 'Cooling inquiry', 'Maintenance consultation'];
  if (/epoxy|floor/i.test(niche)) return ['Floor coating consultation', 'Project estimate'];
  if (/roof/i.test(niche)) return ['Roof inspection inquiry', 'Repair estimate'];
  if (/real estate/i.test(niche)) return ['Property inquiry', 'Showing request'];
  return ['Service inquiry', 'Consultation request', 'Project estimate'];
}
export function generatePresentation(input: DemoInput, websiteEvidence = emptyEvidence(input.websiteUrl)): Presentation {
  const services = [...new Set(input.services.split(/[,\n]/).map((item) => item.trim()).filter(Boolean))].slice(0, 25);
  // Explicit allowlist: never spread the input, private notes, phone number or prospect ID into public data.
  return {
    schemaVersion: 1,
    businessName: input.businessName, niche: input.niche, websiteUrl: input.websiteUrl,
    googleBusinessProfileUrl: input.googleBusinessProfileUrl, location: input.location,
    services: services.length ? services : packServices(input.niche),
    servicesSource: services.length ? 'operator' : 'illustrative_template',
    hours: input.hours, summary: input.publicSummary || websiteEvidence.description || `Explore a sample lead-response experience for ${input.businessName}.`,
    modules: [...input.modules], websiteEvidence,
    disclosure: 'Illustrative sales demo created by Steel Scale Systems, not this business’s live support system. No real calls, SMS messages, policy quotes, or appointments are created. Do not enter personal or customer information.',
  };
}
export function calculateRoi(values: number[]): { recoveredRevenue: number; contributionAfterFee: number; breakEvenJobs: number | null } {
  if (values.length !== 7 || values.some((n) => !Number.isFinite(n) || n < 0)) throw new InputError('Enter finite, nonnegative values.');
  const [missed, recovery, qualification, close, jobValue, margin, fee] = values as [number, number, number, number, number, number, number];
  if (missed > 100000 || jobValue > 10000000 || fee > 10000000 || [recovery, qualification, close, margin].some((n) => n > 100)) throw new InputError('Percentages must be 0–100; volume/value limits exceeded.');
  const recoveredRevenue = missed * (recovery / 100) * (qualification / 100) * (close / 100) * jobValue;
  const jobContribution = jobValue * margin / 100;
  return { recoveredRevenue, contributionAfterFee: recoveredRevenue * margin / 100 - fee, breakEvenJobs: jobContribution > 0 ? Math.ceil(fee / jobContribution) : null };
}
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
export function canView(status: string, expiresAt: Date | null, now = new Date()): boolean {
  return status === 'published' && expiresAt !== null && expiresAt.getTime() > now.getTime();
}
