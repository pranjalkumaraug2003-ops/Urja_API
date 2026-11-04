// The meter service: portal client + cache + cleaning, behind a few plain methods the routes call.
// Freshness rules (D2): meters and DTs 15 minutes; energy for past days never expires.

import { createCache } from './cache.js';
import { buildDataset } from './domain/normalise.js';
import { buildEnergy } from './domain/energy.js';

const DATASET_TTL_MS = 15 * 60 * 1000;
const RECENT_ENERGY_TTL_MS = 15 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function createMeterService({ portal, now = () => Date.now(), cache } = {}) {
  const portalStatus = { lastSuccessAt: null, lastError: null };
  const store =
    cache ??
    createCache({
      now,
      onRefreshError: (key, err) => console.warn(`Background refresh of "${key}" failed: [${err.kind ?? err.name}] ${err.message}`),
    });

  // Wraps every portal-backed load to record the last success and the last error for /health.
  async function track(load) {
    try {
      const value = await load();
      portalStatus.lastSuccessAt = new Date(now()).toISOString();
      portalStatus.lastError = null;
      return value;
    } catch (err) {
      portalStatus.lastError = err.kind ?? 'internal_error';
      throw err;
    }
  }

  // All meters and DTs, cleaned, plus an index by meterId. About 4 portal calls per refresh.
  function getDataset() {
    return store.get(
      'dataset',
      () =>
        track(async () => {
          const rawDts = await portal.getDts(); // sequential, not parallel: gentler on the rate limit
          const rawMeters = await portal.getMeterExport();
          const { meters, transformers } = buildDataset(rawMeters, rawDts);
          return { meters, transformers, byId: new Map(meters.map((m) => [m.meterId, m])) };
        }),
      { ttlMs: DATASET_TTL_MS },
    );
  }

  // Today's date in IST as YYYY-MM-DD: a window ending before today is in the past and cannot change.
  function todayInIst() {
    return new Date(now() + IST_OFFSET_MS).toISOString().slice(0, 10);
  }

  return {
    warmUp: getDataset,

    async listMeters({ limit, offset }) {
      const { value, fetchedAt, stale } = await getDataset();
      return {
        data: value.meters.slice(offset, offset + limit),
        meta: { fetchedAt, stale, total: value.meters.length, limit, offset },
      };
    },

    // Returns null for an unknown meter.
    async getMeter(meterId) {
      const { value, fetchedAt, stale } = await getDataset();
      const meter = value.byId.get(meterId);
      return meter ? { data: meter, meta: { fetchedAt, stale } } : null;
    },

    // Returns null for an unknown meter, checked against the cache first so a typo costs no portal call.
    async getEnergy(meterId, { from, to }) {
      const { value } = await getDataset();
      if (!value.byId.has(meterId)) return null;

      const ttlMs = to < todayInIst() ? Infinity : RECENT_ENERGY_TTL_MS;
      const entry = await store.get(
        `energy:${meterId}:${from}:${to}`,
        () => track(async () => buildEnergy({ meterId, from, to, rawReadings: await portal.getEnergy(meterId, { from, to }) })),
        { ttlMs },
      );
      return { data: entry.value, meta: { fetchedAt: entry.fetchedAt, stale: entry.stale } };
    },

    async listTransformers() {
      const { value, fetchedAt, stale } = await getDataset();
      return { data: value.transformers, meta: { fetchedAt, stale } };
    },

    // Never calls the portal (D8).
    health() {
      const dataset = store.peek('dataset');
      const degraded = dataset === null || dataset.stale || portalStatus.lastError !== null;
      return {
        status: degraded ? 'degraded' : 'ok',
        cache: {
          meters: {
            count: dataset?.value.meters.length ?? 0,
            fetchedAt: dataset?.fetchedAt ?? null,
            stale: dataset?.stale ?? false,
          },
          energyEntries: store.size() - (dataset ? 1 : 0),
        },
        portal: { ...portalStatus },
      };
    },
  };
}
