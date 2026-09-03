import express from 'express';
import pinoHttp from 'pino-http';
import path from 'node:path';

import { healthRouter } from './routes/health.js';
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

registerConfiguredLeadDiscoveryProviders();

export const app = express();

app.disable('x-powered-by');
app.use(pinoHttp({ logger }));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use('/admin', adminRouter);
app.use('/internal/cron', cronRouter);

app.use('/health', healthRouter);
app.use('/chatbot', chatbotRouter);
app.use('/internal/bookings', internalBookingRouter);
app.use('/internal/availability', zapierAvailabilityRouter);
app.use('/webhooks/twilio', twilioWebhookRouter);
app.use('/webhooks/vapi', vapiWebhookRouter);
app.use('/widget', express.static(path.resolve(process.cwd(), 'public')));
app.use('/assets', express.static(path.resolve(process.cwd(), 'public/site')));
app.use('/', marketingRouter);
