import 'dotenv/config';

function parsePort(value: string | undefined): number {
  const port = Number(value ?? '3000');

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  return port;
}

function parseLlmProvider(value: string | undefined): 'openai' | 'anthropic' | 'mock' {
  const provider = value ?? 'openai';
  if (provider !== 'openai' && provider !== 'anthropic' && provider !== 'mock') {
    throw new Error('LLM_PROVIDER must be openai, anthropic, or mock');
  }
  return provider;
}

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  APP_URL: process.env.APP_URL,
  PORT: parsePort(process.env.PORT),
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  TWILIO_SMS_DRY_RUN: process.env.TWILIO_SMS_DRY_RUN === 'true',
  VAPI_WEBHOOK_SECRET: process.env.VAPI_WEBHOOK_SECRET,
  LLM_PROVIDER: parseLlmProvider(process.env.LLM_PROVIDER),
  LLM_MODEL: process.env.LLM_MODEL,
  LEAD_ANALYST_MODEL: process.env.LEAD_ANALYST_MODEL,
  OUTSCRAPER_API_KEY: process.env.OUTSCRAPER_API_KEY,
  OUTSCRAPER_API_BASE_URL: process.env.OUTSCRAPER_API_BASE_URL ?? 'https://api.outscraper.com',
  APIFY_API_TOKEN: process.env.APIFY_API_TOKEN,
  APIFY_API_BASE_URL: process.env.APIFY_API_BASE_URL ?? 'https://api.apify.com/v2',
  APIFY_ZILLOW_SEARCH_ACTOR_ID:
    process.env.APIFY_ZILLOW_SEARCH_ACTOR_ID ?? 'maxcopell/zillow-scraper',
  APIFY_ZILLOW_DETAIL_ACTOR_ID:
    process.env.APIFY_ZILLOW_DETAIL_ACTOR_ID ?? 'maxcopell/zillow-detail-scraper',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  GHL_API_KEY: process.env.GHL_API_KEY,
  GHL_LOCATION_ID: process.env.GHL_LOCATION_ID,
  GHL_FALLBACK_CALENDAR_ID: process.env.GHL_FALLBACK_CALENDAR_ID,
  GHL_API_BASE_URL: process.env.GHL_API_BASE_URL ?? 'https://services.leadconnectorhq.com',
  BOOKING_DELIVERY_DRY_RUN: process.env.BOOKING_DELIVERY_DRY_RUN === 'true',
  ADMIN_USERNAME: process.env.ADMIN_USERNAME,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
  SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL,
  CRON_SECRET: process.env.CRON_SECRET,
};
