// Builds the Express app. Kept separate from server.js so tests can run it without opening a port.

import { fileURLToPath } from 'node:url';
import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { createV1Router } from './http/routes.js';
import { errorHandler, notFoundHandler } from './http/errors.js';

// Swagger UI page options: our shared nav bar on top, Swagger's own top bar hidden, endpoints listed open.
const DOCS_OPTIONS = {
  customSiteTitle: 'Urja Meter Ops API docs',
  customCssUrl: '/nav.css',
  customJs: '/nav.js',
  customCss: '.swagger-ui .topbar { display: none } body { margin: 0 } .swagger-ui .info { margin: 32px 0 16px }',
  swaggerOptions: {
    docExpansion: 'list',
    defaultModelsExpandDepth: 0,
    displayRequestDuration: true,
    filter: true,
    tryItOutEnabled: true,
  },
};

export function createApp({ service, openapi }) {
  const app = express();
  app.disable('x-powered-by'); // do not advertise the framework in every response

  // Operations endpoint: bare body, read by monitoring tools (D8); never calls the portal.
  app.get('/health', (_req, res) => res.json(service.health()));

  // The contract, as JSON and as Swagger UI. For "Try it out", Swagger UI sends requests to this same
  // server (a relative URL), whatever host and port it runs on; openapi.json itself keeps localhost:3000.
  app.get('/openapi.json', (_req, res) => res.json(openapi));
  const docsSpec = { ...openapi, servers: [{ url: '/', description: 'This server' }] };
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(docsSpec, DOCS_OPTIONS));

  app.use('/v1', createV1Router(service));

  // A small web client (public/index.html) that only uses the endpoints above.
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));

  // Order matters: anything that reached here matched no route; errors from anywhere end in errorHandler.
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
