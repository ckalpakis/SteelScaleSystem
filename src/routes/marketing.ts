import path from 'node:path';

import { Router } from 'express';

export const marketingRouter = Router();
const siteRoot = path.resolve(process.cwd(), 'public/site');

marketingRouter.get('/', (_request, response) => {
  response.sendFile(path.join(siteRoot, 'index.html'));
});

marketingRouter.get('/seo-reviews', (_request, response) => {
  response.sendFile(path.join(siteRoot, 'seo-reviews.html'));
});
