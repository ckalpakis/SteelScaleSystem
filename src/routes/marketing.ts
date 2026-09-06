import path from 'node:path';

import { Router } from 'express';

import { env } from '../config/env.js';

export const marketingRouter = Router();
const siteRoot = path.resolve(process.cwd(), 'public/site');

marketingRouter.get('/site-chatbot.js', (_request, response) => {
  response.type('application/javascript').send(`(function(){
    var script=document.createElement('script');
    script.src='/widget/chatbot-widget.js';
    script.dataset.clientId=${JSON.stringify(env.WEBSITE_CHATBOT_CLIENT_ID)};
    script.dataset.assistantName='Steel Scale assistant';
    document.body.appendChild(script);
  })();`);
});

marketingRouter.get('/', (_request, response) => {
  response.sendFile(path.join(siteRoot, 'index.html'));
});

marketingRouter.get('/seo-reviews', (_request, response) => {
  response.sendFile(path.join(siteRoot, 'seo-reviews.html'));
});

marketingRouter.get('/thank-you', (_request, response) => {
  response.sendFile(path.join(siteRoot, 'thank-you.html'));
});
