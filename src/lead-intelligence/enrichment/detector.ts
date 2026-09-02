import { isAllowedBusinessDomain, normalizeAuditUrl } from './http-fetcher.js';
import type { WebsiteDetection, WebsitePage } from './types.js';

export const WEBSITE_SIGNAL_KEYS = {
  HAS_WEBSITE: 'has_website',
  WEBSITE_REACHABLE: 'website_reachable',
  HAS_CHATBOT: 'has_chatbot',
  HAS_ONLINE_BOOKING: 'has_online_booking',
  HAS_CONTACT_FORM: 'has_contact_form',
  HAS_VISIBLE_PHONE: 'has_visible_phone',
  HAS_CLICK_TO_CALL: 'has_click_to_call',
  MENTIONS_24_7: 'mentions_24_7',
  MENTIONS_EMERGENCY: 'mentions_emergency',
  MENTIONS_SAME_DAY: 'mentions_same_day',
  MENTIONS_FREE_ESTIMATE: 'mentions_free_estimate',
  HAS_FACEBOOK: 'has_facebook',
  HAS_INSTAGRAM: 'has_instagram',
  HAS_TIKTOK: 'has_tiktok',
  HAS_GOOGLE_ANALYTICS: 'has_google_analytics',
  HAS_GHL_WIDGET: 'has_ghl_widget',
  HAS_HOUSECALL_PRO: 'has_housecall_pro',
  HAS_JOBBER: 'has_jobber',
  HAS_SERVICETITAN: 'has_servicetitan',
  HAS_CALENDLY: 'has_calendly',
  HAS_GHL_BOOKING: 'has_ghl_booking',
  HAS_OTHER_BOOKING_PROVIDER: 'has_other_booking_provider',
} as const;

export type WebsiteSignalKey = (typeof WEBSITE_SIGNAL_KEYS)[keyof typeof WEBSITE_SIGNAL_KEYS];

interface PatternDefinition {
  key: WebsiteSignalKey;
  patterns: RegExp[];
  confidence: number;
  method: string;
}

function visibleText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ');
}

function excerpt(value: string, index: number, length: number): string {
  return value.slice(Math.max(0, index - 60), Math.min(value.length, index + length + 60));
}

function detectPattern(pages: WebsitePage[], definition: PatternDefinition): WebsiteDetection {
  for (const page of pages) {
    const target = definition.method === 'visible_text' ? visibleText(page.html) : page.html;
    for (const pattern of definition.patterns) {
      const match = pattern.exec(target);
      pattern.lastIndex = 0;
      if (match?.index !== undefined) {
        return {
          key: definition.key,
          result: true,
          confidence: definition.confidence,
          evidenceUrl: page.finalUrl,
          metadata: {
            method: definition.method,
            matchedPattern: pattern.source,
            excerpt: excerpt(target, match.index, match[0].length),
          },
        };
      }
    }
  }
  return {
    key: definition.key,
    result: false,
    confidence: definition.key === WEBSITE_SIGNAL_KEYS.HAS_CHATBOT ? 0.65 : 0.75,
    evidenceUrl: pages[0]?.finalUrl ?? '',
    metadata: {
      method: 'full_page_artifact_scan',
      inspectedPages: pages.map(({ finalUrl }) => finalUrl),
      signaturesChecked: definition.patterns.map(({ source }) => source),
      limitation: 'No known artifact was observed; absence is not definitive.',
    },
  };
}

const definitions: PatternDefinition[] = [
  {
    key: WEBSITE_SIGNAL_KEYS.HAS_CHATBOT,
    patterns: [
      /intercom(?:cdn|\.io)|intercomSettings/i,
      /drift\.com|drift-widget|driftSettings/i,
      /client\.crisp\.chat|CRISP_WEBSITE_ID/i,
      /embed\.tawk\.to|Tawk_API/i,
      /livechatinc\.com|LiveChatWidget/i,
      /chatwoot|hubspot-messages-iframe-container|chat-widget|chatbot/i,
      /leadconnectorhq\.com\/(?:chat-widget|widget\/chat)|msgsndr\.com\/widget\/chat/i,
    ],
    confidence: 0.9,
    method: 'html_artifact',
  },
  {
    key: WEBSITE_SIGNAL_KEYS.HAS_CONTACT_FORM,
    patterns: [
      /<form\b[\s\S]{0,4000}(?:name=["']?(?:email|phone|message)|type=["']?(?:email|tel)|textarea\b|action=["'][^"']*contact)/i,
    ],
    confidence: 0.88,
    method: 'html_artifact',
  },
  {
    key: WEBSITE_SIGNAL_KEYS.HAS_VISIBLE_PHONE,
    patterns: [/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/],
    confidence: 0.9,
    method: 'visible_text',
  },
  {
    key: WEBSITE_SIGNAL_KEYS.HAS_CLICK_TO_CALL,
    patterns: [/href\s*=\s*["']tel:\+?[\d().\s-]{7,}/i],
    confidence: 0.98,
    method: 'html_artifact',
  },
  {
    key: WEBSITE_SIGNAL_KEYS.MENTIONS_24_7,
    patterns: [/\b24\s*(?:\/|hours?\s+a\s+day[, ]*)\s*7\b|\b24[- ]hour\b|\baround the clock\b/i],
    confidence: 0.87,
    method: 'visible_text',
  },
  {
    key: WEBSITE_SIGNAL_KEYS.MENTIONS_EMERGENCY,
    patterns: [/\bemergency\s+(?:service|repair|plumb|hvac|roof|electric)/i],
    confidence: 0.9,
    method: 'visible_text',
  },
  {
    key: WEBSITE_SIGNAL_KEYS.MENTIONS_SAME_DAY,
    patterns: [/\bsame[- ]day\s+(?:service|repair|appointment|availability)/i],
    confidence: 0.88,
    method: 'visible_text',
  },
  {
    key: WEBSITE_SIGNAL_KEYS.MENTIONS_FREE_ESTIMATE,
    patterns: [/\bfree\s+(?:estimate|quote|consultation)s?\b/i],
    confidence: 0.9,
    method: 'visible_text',
  },
  {
    key: WEBSITE_SIGNAL_KEYS.HAS_FACEBOOK,
    patterns: [/href\s*=\s*["']https?:\/\/(?:www\.)?facebook\.com\//i],
    confidence: 0.98,
    method: 'html_artifact',
  },
  {
    key: WEBSITE_SIGNAL_KEYS.HAS_INSTAGRAM,
    patterns: [/href\s*=\s*["']https?:\/\/(?:www\.)?instagram\.com\//i],
    confidence: 0.98,
    method: 'html_artifact',
  },
  {
    key: WEBSITE_SIGNAL_KEYS.HAS_TIKTOK,
    patterns: [/href\s*=\s*["']https?:\/\/(?:www\.)?tiktok\.com\//i],
    confidence: 0.98,
    method: 'html_artifact',
  },
  {
    key: WEBSITE_SIGNAL_KEYS.HAS_GOOGLE_ANALYTICS,
    patterns: [
      /googletagmanager\.com\/(?:gtag\/js|gtm\.js)|google-analytics\.com\/analytics\.js|\bgtag\s*\(/i,
    ],
    confidence: 0.96,
    method: 'html_artifact',
  },
  {
    key: WEBSITE_SIGNAL_KEYS.HAS_GHL_WIDGET,
    patterns: [/leadconnectorhq\.com\/(?:chat-widget|widget)|msgsndr\.com\/widget/i],
    confidence: 0.97,
    method: 'html_artifact',
  },
  {
    key: WEBSITE_SIGNAL_KEYS.HAS_HOUSECALL_PRO,
    patterns: [/(?:book|online-booking)\.housecallpro\.com|housecallpro\.com\/book/i],
    confidence: 0.98,
    method: 'html_artifact',
  },
  {
    key: WEBSITE_SIGNAL_KEYS.HAS_JOBBER,
    patterns: [/(?:clienthub\.)?getjobber\.com\/(?:booking|client_hubs)|getjobber\.com\/booking/i],
    confidence: 0.98,
    method: 'html_artifact',
  },
  {
    key: WEBSITE_SIGNAL_KEYS.HAS_SERVICETITAN,
    patterns: [/(?:book\.)?servicetitan\.(?:com|io)|servicetitan[^"']*(?:scheduler|booking)/i],
    confidence: 0.96,
    method: 'html_artifact',
  },
  {
    key: WEBSITE_SIGNAL_KEYS.HAS_CALENDLY,
    patterns: [/calendly\.com\//i],
    confidence: 0.98,
    method: 'html_artifact',
  },
  {
    key: WEBSITE_SIGNAL_KEYS.HAS_GHL_BOOKING,
    patterns: [
      /(?:api\.|links\.)?leadconnectorhq\.com\/widget\/booking|msgsndr\.com\/widget\/booking/i,
    ],
    confidence: 0.98,
    method: 'html_artifact',
  },
];

export function discoverAuditPages(
  homepage: WebsitePage,
  allowedDomain: string,
  maxPages: number,
): string[] {
  if (maxPages <= 1) return [];
  const candidates: Array<{ url: string; rank: number }> = [];
  const anchorPattern = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of homepage.html.matchAll(anchorPattern)) {
    const href = match[1];
    if (!href || /^(?:mailto:|tel:|javascript:|#)/i.test(href)) continue;
    try {
      const url = normalizeAuditUrl(new URL(href, homepage.finalUrl).toString());
      if (!isAllowedBusinessDomain(url.hostname, allowedDomain)) continue;
      const text = visibleText(match[2] ?? '').toLowerCase();
      const path = url.pathname.toLowerCase();
      const contact = /contact|quote|estimate/.test(`${text} ${path}`);
      const booking = /book|schedule|appointment/.test(`${text} ${path}`);
      if (contact || booking) candidates.push({ url: url.toString(), rank: booking ? 1 : 2 });
    } catch {
      // Ignore malformed and non-HTTP links.
    }
  }
  return [
    ...new Map(candidates.sort((a, b) => a.rank - b.rank).map((item) => [item.url, item])).keys(),
  ]
    .filter((url) => url !== homepage.finalUrl)
    .slice(0, maxPages - 1);
}

export function detectWebsiteSignals(pages: WebsitePage[]): WebsiteDetection[] {
  const detections = definitions.map((definition) => detectPattern(pages, definition));
  const byKey = new Map(detections.map((detection) => [detection.key, detection]));
  const namedBookingKeys = new Set<string>([
    WEBSITE_SIGNAL_KEYS.HAS_HOUSECALL_PRO,
    WEBSITE_SIGNAL_KEYS.HAS_JOBBER,
    WEBSITE_SIGNAL_KEYS.HAS_SERVICETITAN,
    WEBSITE_SIGNAL_KEYS.HAS_CALENDLY,
    WEBSITE_SIGNAL_KEYS.HAS_GHL_BOOKING,
  ]);
  const genericBooking = detectPattern(pages, {
    key: WEBSITE_SIGNAL_KEYS.HAS_OTHER_BOOKING_PROVIDER,
    patterns: [
      /href\s*=\s*["'][^"']*(?:book|schedule|appointment)[^"']*["']/i,
      /<(?:iframe|script)\b[^>]*(?:booking|scheduler|appointment)/i,
    ],
    confidence: 0.78,
    method: 'html_artifact',
  });
  const namedProviderFound = [...namedBookingKeys].some((key) => byKey.get(key)?.result);
  if (namedProviderFound) {
    genericBooking.result = false;
    genericBooking.metadata = {
      method: 'provider_classification',
      reason: 'A named booking provider was detected instead.',
    };
  }
  detections.push(genericBooking);
  const bookingDetection: WebsiteDetection = {
    key: WEBSITE_SIGNAL_KEYS.HAS_ONLINE_BOOKING,
    result: namedProviderFound || genericBooking.result,
    confidence: namedProviderFound ? 0.97 : genericBooking.result ? 0.78 : 0.72,
    evidenceUrl:
      detections.find(
        (detection) =>
          detection.result &&
          (namedBookingKeys.has(detection.key) ||
            detection.key === WEBSITE_SIGNAL_KEYS.HAS_OTHER_BOOKING_PROVIDER),
      )?.evidenceUrl ??
      pages[0]?.finalUrl ??
      '',
    metadata: {
      method: 'booking_provider_rollup',
      detectedProviders: detections
        .filter((detection) => detection.result && namedBookingKeys.has(detection.key))
        .map(({ key }) => key),
      genericBookingArtifact: genericBooking.result,
    },
  };
  detections.push(bookingDetection);
  return detections;
}
