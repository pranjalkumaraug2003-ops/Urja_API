// The /v1 endpoints (D8). Each handler: validate input, ask the service, send { data, meta }.
// Express 5 forwards errors thrown in async handlers to the error middleware, so no try/catch is needed.

import { Router } from 'express';
import { ApiError } from './errors.js';
import { parse, schemas } from './validate.js';

function meterNotFound(meterId) {
  return new ApiError(404, 'not_found', `Meter ${meterId} not found.`);
}

export function createV1Router(service) {
  const router = Router();

  router.get('/meters', async (req, res) => {
    const query = parse(schemas.meterListQuery, req.query);
    res.json(await service.listMeters(query));
  });

  router.get('/meters/:meterId', async (req, res) => {
    parse(schemas.noQuery, req.query);
    const meterId = parse(schemas.meterId, req.params.meterId, 'meterId');
    const result = await service.getMeter(meterId);
    if (!result) throw meterNotFound(meterId);
    res.json(result);
  });

  router.get('/meters/:meterId/energy', async (req, res) => {
    const meterId = parse(schemas.meterId, req.params.meterId, 'meterId');
    const query = parse(schemas.energyQuery, req.query);
    const result = await service.getEnergy(meterId, query);
    if (!result) throw meterNotFound(meterId);
    res.json(result);
  });

  router.get('/transformers', async (req, res) => {
    parse(schemas.noQuery, req.query);
    res.json(await service.listTransformers());
  });

  return router;
}
