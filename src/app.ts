import express from 'express';
import { communicationRouter } from './communications/http.js';
import { knowledgeRouter } from './knowledge/http.js';
import { knowledgeAdminRouter } from './knowledge/admin.js';
import { recoveryRouter } from './recovery/http.js';
import { recoveryAdminRouter } from './recovery/admin.js';
import { agentRouter } from './agents/http.js';
import { blueprintRouter } from './agent-builder/http.js';
import { builderAdminRouter } from './agent-builder/admin.js';
import { integrationRouter } from './integrations/http.js';
import { integrationAdminRouter, integrationOperatorRouter } from './integrations/admin.js';
import pinoHttp from 'pino-http';
import path from 'node:path';

import { demoAdminRouter, demoPublicRouter } from './demo-engine/routes.js';

import { healthRoutes, databaseReady } from './platform/health.js';
import { db } from './db/client.js';
import { operationsRouter } from './platform/operations.js';
import { chatbotRouter } from './routes/chatbot.js';
import { adminRouter } from './routes/admin.js';
import { cronRouter } from './routes/cron.js';
import { internalBookingRouter } from './routes/internal-bookings.js';
import { twilioWebhookRouter } from './routes/twilio-webhooks.js';
import { vapiWebhookRouter } from './routes/vapi-webhooks.js';
import { zapierAvailabilityRouter } from './routes/zapier-availability.js';
import { logger } from './utils/logger.js';
import { registerConfiguredLeadDiscoveryProviders } from './lead-intelligence/providers/register.js';
import { marketingRouter } from './routes/marketing.js';
import { workforceRouter } from './workforce/http/routes.js';
import { crmAdminRouter, memberCrmRouter } from './crm/admin.js';
import { workspaceRouter } from './workspace/http.js';

registerConfiguredLeadDiscoveryProviders();

export const app = express();

app.disable('x-powered-by');
app.use(healthRoutes(() => databaseReady(db)));
app.use('/admin/operations', operationsRouter);
app.use('/api/communications', communicationRouter);
app.use('/api/knowledge', knowledgeRouter);
app.use('/business-knowledge', knowledgeAdminRouter);
app.use('/api/recovery', recoveryRouter);
app.use('/revenue-recovery', recoveryAdminRouter);
app.use('/api/agent-blueprints', blueprintRouter);
app.use('/agent-builder', builderAdminRouter);
app.use('/api/agents', agentRouter);
app.use('/api/integrations', integrationRouter);
app.use('/integrations', integrationAdminRouter);
app.use('/admin/integrations', integrationOperatorRouter);
// Workforce owns auth, parsing and safe errors; credentials and CRM bodies bypass generic logs.
app.use('/api/workforce', workforceRouter);
app.use('/admin/crm', crmAdminRouter);
app.use('/workspace/crm', memberCrmRouter);
app.use('/workspace', workspaceRouter);
// Demo routes own parsing, authentication, and redacted error handling. Mount them before
// generic request logging so private form bodies and bearer share tokens are not logged here.
app.use('/admin/demos', demoAdminRouter);
app.use('/demo', demoPublicRouter);
app.use(pinoHttp({ logger }));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use('/admin', adminRouter);
app.use('/internal/cron', cronRouter);

app.use('/chatbot', chatbotRouter);
app.use('/internal/bookings', internalBookingRouter);
app.use('/internal/availability', zapierAvailabilityRouter);
app.use('/webhooks/twilio', twilioWebhookRouter);
app.use('/webhooks/vapi', vapiWebhookRouter);
app.use('/widget', express.static(path.resolve(process.cwd(), 'public')));
app.use('/assets', express.static(path.resolve(process.cwd(), 'public/site')));
app.use('/', marketingRouter);
