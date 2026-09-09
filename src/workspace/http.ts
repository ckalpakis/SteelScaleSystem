import express, { type ErrorRequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { db } from '../db/client.js';
import { enabled } from '../integrations/http.js';
import { peerLimit } from '../integrations/rate-limit.js';
import { WorkforceError } from '../workforce/shared.js';
import { workspaceLayout, escapeHtml as e } from '../utils/html.js';
import { memberAuth, workspacePrincipal } from './auth.js';
import { WorkspaceService } from './service.js';
import { workspacePage } from './views.js';
import { logger } from '../utils/logger.js';

export const workspaceRouter = express.Router();
workspaceRouter.use(enabled, peerLimit);
workspaceRouter.use((_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  next();
});
workspaceRouter.use(memberAuth);
workspaceRouter.get('/', async (req, res) => {
  const principal = workspacePrincipal(res);
  res.send(
    workspacePage(
      await new WorkspaceService(db, principal).overview(req.query.days, req.query.queue),
      principal.role,
    ),
  );
});
workspaceRouter.use((_req, res) => {
  res.sendStatus(404);
});
const errors: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const status = error instanceof WorkforceError ? error.status : 500;
  const reference = randomUUID();
  if (status >= 500)
    logger.error(
      {
        requestId: reference,
        organizationId: res.locals.principal ? workspacePrincipal(res).organizationId : undefined,
        errorCode: 'workspace_request_failed',
      },
      'Workspace could not be loaded',
    );
  if (status === 429) res.setHeader('Retry-After', '60');
  res
    .status(status)
    .send(
      workspaceLayout(
        'Workspace unavailable',
        `<h1>Unable to open the workspace</h1><p>${e(error instanceof WorkforceError ? error.code.replaceAll('_', ' ') : 'The workspace could not be loaded. Try again or contact your operator.')}</p>${status >= 500 ? `<p>Support reference: ${reference}</p>` : ''}<p><a href="/workspace">Return to Today</a></p>`,
      ),
    );
};
workspaceRouter.use(errors);
