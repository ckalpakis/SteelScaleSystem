import { validTwilioSignature } from './contracts.js';
import express from 'express';
import { db } from '../db/client.js';
import { enabled, integrationErrors } from '../integrations/http.js';
import { peerLimit, organizationLimit } from '../integrations/rate-limit.js';
import { unseal } from '../integrations/security.js';
import { authenticate, type Principal } from '../workforce/tenancy/service.js';
import { object, string, uuid, WorkforceError } from '../workforce/shared.js';
import { CommunicationService, processInboundMessage } from './service.js';
import { processDeliveryStatus } from './worker.js';

export const communicationRouter = express.Router();
communicationRouter.use(
  enabled,
  (req, _res, next) => {
    if (process.env.COMMUNICATIONS_ENABLED !== 'true') throw new WorkforceError(404, 'not_found');
    if (req.header('origin')) throw new WorkforceError(403, 'browser_origin_not_supported');
    next();
  },
  peerLimit,
);
const providerRouter = express.Router();
providerRouter.use(express.urlencoded({ extended: false, limit: '32kb', parameterLimit: 100 }));
providerRouter.use('/:accountId', async (req, res, next) => {
  const id = uuid(req.params.accountId),
    account = await db.communicationAccount.findUnique({ where: { id } });
  if (!account || account.provider !== 'twilio')
    throw new WorkforceError(403, 'invalid_provider_signature');
  const base = process.env.APP_URL;
  if (!base || !/^https:\/\//.test(base))
    throw new WorkforceError(503, 'communication_public_https_required');
  if (req.originalUrl.includes('?')) throw new WorkforceError(400, 'provider_query_not_supported');
  const body = object(req.body),
    token = unseal(account.encryptedCredentials, `communication:${account.organizationId}:${id}`);
  if (
    !validTwilioSignature(
      new URL(req.originalUrl, base).toString(),
      body,
      req.header('x-twilio-signature') ?? '',
      token,
    ) ||
    body.AccountSid !== account.externalAccountId
  )
    throw new WorkforceError(403, 'invalid_provider_signature');
  await organizationLimit(db, account.organizationId);
  res.locals.account = account;
  next();
});
providerRouter.post('/:accountId/inbound', async (req, res) => {
  const b = object(req.body);
  await processInboundMessage(db, String(req.params.accountId), {
    externalId: b.MessageSid,
    from: b.From,
    to: b.To,
    body: b.Body,
  });
  res.type('text/xml').send('<Response></Response>');
});
providerRouter.post('/:accountId/status/:deliveryId', async (req, res) => {
  const b = object(req.body),
    rawStatus = string(b.MessageStatus, 40);
  const statuses: Record<string, 'accepted' | 'sent' | 'delivered' | 'failed' | undefined> = {
    accepted: 'accepted',
    queued: 'accepted',
    sending: 'accepted',
    sent: 'sent',
    delivered: 'delivered',
    undelivered: 'failed',
    failed: 'failed',
    canceled: 'failed',
  };
  const status = statuses[rawStatus];
  if (!status) throw new WorkforceError(400, 'unsupported_provider_status');
  const sid = string(b.MessageSid, 34);
  if (!/^[A-Z]{2}[a-f0-9]{32}$/i.test(sid))
    throw new WorkforceError(400, 'invalid_provider_message_id');
  await processDeliveryStatus(
    db,
    uuid(req.params.accountId),
    uuid(req.params.deliveryId),
    sid,
    status,
    b.ErrorCode === '21610'
      ? 'provider_opt_out'
      : b.ErrorCode
        ? `provider_${string(b.ErrorCode, 20).replace(/[^0-9]/g, '')}`
        : null,
  );
  res.sendStatus(204);
});
communicationRouter.use('/providers/twilio', providerRouter);
communicationRouter.use(async (req, res, next) => {
  res.locals.principal = await authenticate(db, req.header('authorization'));
  await organizationLimit(db, (res.locals.principal as Principal).organizationId);
  if (req.method !== 'GET' && !req.is('application/json'))
    throw new WorkforceError(415, 'json_required');
  next();
});
communicationRouter.use(express.json({ limit: '32kb', strict: true }));
const service = (res: express.Response) =>
  new CommunicationService(db, res.locals.principal as Principal);
communicationRouter.get('/', async (_req, res) => {
  res.json(await service(res).list());
});
communicationRouter.post('/accounts', async (req, res) => {
  res.status(201).json(await service(res).configure(req.body));
});
communicationRouter.post('/accounts/:id/enabled', async (req, res) => {
  res.json(await service(res).setEnabled(String(req.params.id), req.body));
});
communicationRouter.post('/consent', async (req, res) => {
  res.json(await service(res).consent(req.body));
});
communicationRouter.get('/conversations/:id', async (req, res) => {
  res.json(await service(res).getConversation(String(req.params.id)));
});
communicationRouter.post('/sms', async (req, res) => {
  res.status(202).json(await service(res).sendSms(req.body));
});
communicationRouter.post('/email', async (req, res) => {
  res.status(202).json(await service(res).sendEmail(req.body));
});
communicationRouter.use(integrationErrors);
