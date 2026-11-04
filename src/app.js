// Builds the Express app. Kept separate from server.js so tests can run it without opening a port.

import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { createV1Router } from './http/routes.js';
import { errorHandler, notFoundHandler } from './http/errors.js';

export function createApp({ service, openapi }) {
  const app = express();
  app.disable('x-powered-by'); // do not advertise the framework in every response

  // Operations endpoint: bare body, read by monitoring tools (D8); never calls the portal.
  app.get('/health', (_req, res) => res.json(service.health()));

  // The contract, as JSON and as Swagger UI.
  app.get('/openapi.json', (_req, res) => res.json(openapi));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi));

  app.use('/v1', createV1Router(service));

  // Order matters: anything that reached here matched no route; errors from anywhere end in errorHandler.
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
