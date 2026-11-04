// The meter service: portal client + cache + cleaning, behind a few plain methods the routes call.
// Freshness rules (D2): meters and DTs 15 minutes; energy for past days never expires.

import { createCache } from './cache.js';
import { buildDataset } from './domain/normalise.js';
import { buildEnergy, rollUpDaily } from './domain/energy.js';
import { buildNetwork } from './domain/network.js';
import { queryMeters } from './domain/query.js';

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
      // A portal 404 for one meter says nothing about the portal's health.
      if (err.kind !== 'not_found') portalStatus.lastError = err.kind ?? 'internal_error';
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
          // Derived views are built once per refresh, not per request.
          return { meters, transformers, network: buildNetwork(meters), byId: new Map(meters.map((m) => [m.meterId, m])) };
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

    // Filters first, then paging, so total counts the filtered meters.
    async listMeters({ limit, offset, ...filters }) {
      const { value, fetchedAt, stale } = await getDataset();
      const matching = queryMeters(value.meters, filters);
      return {
        data: matching.slice(offset, offset + limit),
        meta: { fetchedAt, stale, total: matching.length, limit, offset },
      };
    },

    // Returns null for an unknown meter.
    async getMeter(meterId) {
      const { value, fetchedAt, stale } = await getDataset();
      const meter = value.byId.get(meterId);
      return meter ? { data: meter, meta: { fetchedAt, stale } } : null;
    },

    // Returns null for an unknown meter, checked against the cache first so a typo costs no portal call.
    async getEnergy(meterId, { from, to, granularity = 'raw' }) {
      const { value } = await getDataset();
      if (!value.byId.has(meterId)) return null;

      const ttlMs = to < todayInIst() ? Infinity : RECENT_ENERGY_TTL_MS;
      const entry = await store.get(
        `energy:${meterId}:${from}:${to}`,
        () => track(async () => buildEnergy({ meterId, from, to, rawReadings: await portal.getEnergy(meterId, { from, to }) })),
        { ttlMs },
      );
      // The raw window is cached; the daily roll-up is computed from it on the way out (cheap).
      const data = granularity === 'daily' ? rollUpDaily(entry.value) : entry.value;
      return { data, meta: { fetchedAt: entry.fetchedAt, stale: entry.stale } };
    },

    async getNetwork() {
      const { value, fetchedAt, stale } = await getDataset();
      return { data: value.network, meta: { fetchedAt, stale } };
    },

    async listTransformers() {
      const { value, fetchedAt, stale } = await getDataset();
      return { data: value.transformers, meta: { fetchedAt, stale } };
    },

    // Never calls the portal (D8). Degraded = no data loaded yet, or the last portal call failed.
    // Data that expired only because nobody asked for it is reported as stale but is not degraded.
    health() {
      const dataset = store.peek('dataset');
      const degraded = dataset === null || portalStatus.lastError !== null;
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
