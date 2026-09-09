import type { RequestHandler, Response } from 'express';
import { db } from '../db/client.js';
import { authorizeCurrent } from '../agents/service.js';
import { authenticate, type Principal } from '../workforce/tenancy/service.js';
import { tenantTransaction, WorkforceError } from '../workforce/shared.js';
import { organizationLimit } from '../integrations/rate-limit.js';

export const workspacePrincipal = (res: Response) => res.locals.principal as Principal;

/** Resolve the tenant from a current member credential, never from URL or form data. */
export const memberAuth: RequestHandler = async (req, res, next) => {
  let authorization = req.header('authorization');
  if (authorization?.startsWith('Basic ')) {
    const value = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    authorization = `Bearer ${value.slice(value.indexOf(':') + 1)}`;
  }
  try {
    const principal = await authenticate(db, authorization);
    await organizationLimit(db, principal.organizationId);
    await tenantTransaction(db, principal.organizationId, (tx) =>
      authorizeCurrent(tx, principal, 'crm:read'),
    );
    res.locals.principal = principal;
    next();
  } catch (error) {
    if (error instanceof WorkforceError && error.status === 401)
      res.setHeader('WWW-Authenticate', 'Basic realm="Steel Scale Workspace (member API key)"');
    next(error);
  }
};
