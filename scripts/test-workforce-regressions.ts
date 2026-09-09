import { spawnSync } from 'node:child_process';
import { requireDemoTestDatabase } from '../src/demo-engine/test-database.js';

// Legacy scripts write fixtures and can load .env. Require a disposable DB and override
// all production providers before starting any child, including Prisma's seed process.
requireDemoTestDatabase();
const testEnvironment = {
  ...process.env,
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  WORKFORCE_ENABLED: 'false',
  CRM_ENABLED: 'false',
  AGENT_RUNTIME_ENABLED: 'false',
  AGENT_MODEL_ENABLED: 'false',
  AGENT_BUILDER_ENABLED: 'false',
  AGENT_BUILDER_AI_ENABLED: 'false',
  AGENT_BUILDER_MODEL: '',
  REVENUE_RECOVERY_ENABLED: 'false',
  REVENUE_RECOVERY_DELIVERY_ENABLED: 'false',
  BUSINESS_KNOWLEDGE_ENABLED: 'false',
  COMMUNICATIONS_ENABLED: 'false',
  COMMUNICATION_DELIVERY_ENABLED: 'false',
  AGENT_ALLOWED_MODELS: '',
  WORKFORCE_WORKER_ENABLED: 'false',
  DURABLE_BACKGROUND_ENABLED: 'false',
  REDIS_URL: '',
  WEBHOOK_DELIVERY_ENABLED: 'false',
  INTEGRATION_ENCRYPTION_KEY: '',
  DEMO_ENGINE_ENABLED: 'false',
  DEMO_AI_ENABLED: 'false',
  DEMO_VOICE_ENABLED: 'false',
  DOTENV_CONFIG_PATH: '/dev/null',
  LLM_PROVIDER: 'mock',
  TWILIO_SMS_DRY_RUN: 'true',
  BOOKING_DELIVERY_DRY_RUN: 'true',
  TWILIO_ACCOUNT_SID: '',
  TWILIO_AUTH_TOKEN: '',
  VAPI_API_KEY: '',
  VAPI_WEBHOOK_SECRET: '',
  OPENAI_API_KEY: '',
  ANTHROPIC_API_KEY: '',
  DEMO_OPENAI_API_KEY: '',
  GHL_API_KEY: '',
  GHL_LOCATION_ID: '',
  GHL_FALLBACK_CALENDAR_ID: '',
  GHL_API_BASE_URL: 'http://127.0.0.1:1',
  SLACK_WEBHOOK_URL: '',
  CRON_SECRET: '',
  OUTSCRAPER_API_KEY: '',
  APIFY_API_TOKEN: '',
  LEAD_PIPELINE_CAMPAIGNS_JSON: '[]',
};
const checks = [
  'prisma:seed',
  'test:missed-call',
  'test:vapi-booking',
  'test:chatbot',
  'test:booking-routing',
  'test:admin',
  'test:daily-summary',
  ...Array.from({ length: 11 }, (_, index) => `test:lead-intelligence-phase-${index + 1}`),
  'test:lead-intelligence-analyst',
  'test:lead-discovery-providers',
  'test:ghl-availability',
  'test:demos',
  'test:demos:integration',
  'test:workforce',
  'test:workforce:integration',
  'test:crm',
  'test:crm:integration',
  'test:events',
  'test:events:integration',
  'test:integrations',
  'test:integrations:integration',
  'test:agents',
  'test:agents:integration',
  'test:agent-builder',
  'test:agent-builder:integration',
  'test:recovery',
  'test:recovery:integration',
  'test:knowledge',
  'test:knowledge:integration',
  'test:communications',
  'test:communications:integration',
  'test:recovery:communications',
  'test:deployment',
  'test:deployment:integration',
  'test:workspace',
  'test:workspace:integration',
];
const failures: string[] = [];
for (const check of checks) {
  const result = spawnSync('npm', ['run', check], {
    env: testEnvironment,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const ok = result.status === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${check}`);
  if (!ok) {
    failures.push(check);
    console.log((result.stdout + result.stderr).slice(-8000));
    if (result.error) console.log(result.error.message);
    if (check === 'prisma:seed') break;
  }
}
console.log(JSON.stringify({ failures }, null, 2));
if (failures.length) process.exitCode = 1;
