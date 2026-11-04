# Decisions log

A running record of every design decision for the Urja Meter Ops API, with the reason and the trade-off. One line to remember per decision is in **bold**.

---

## D1. Meter data source: the signed export

**Remember: all meters come from the portal's own Export feature, 2 requests instead of 400+.**

- **Chosen:** `GET /portal/keys` (signing secret) then one HMAC-signed `GET /portal/export`, which returns all 403 meters.
- **Energy** still comes from `GET /portal/meters/{id}/energy` (the only source).
- **Why:**
  - It's the same call the portal's UI makes (Export button on /transformers), so it's normal logged-in-user behaviour.
  - 2 requests instead of about 21 search pages plus 403 detail pages, under a rate limit (about 120-request burst observed).
  - The data arrives structured: hierarchy as `{name, code}`, numeric geo, plus `installType` and `build`. No parsing of display strings or the two nameplate formats.
- **Rejected:** search pages plus `__data.json` detail pages (devalue decoding, two nameplate shapes, `"Name (CODE)"` parsing that breaks on blank codes, many more requests).
- **Trade-off / risk:** single point of failure if the signing scheme changes. Mitigation: all portal access lives in one portal-client module; the detail pages are noted as a possible fallback (README, "with more time").
- **Interview line:** "The portal's own UI uses it. It gives me all meters in 2 requests instead of over 400 under a strict rate limit, and returns structured data instead of display strings."
- **Extension covered:** "The full dataset" (using a bulk path well).

---

## D2. Caching: in-memory cache with reasoned freshness rules

**Remember: keep data in memory; meters refresh every 15 min, past energy readings never change, serve stale while refreshing.**

- **Chosen:** in-memory cache (a JavaScript `Map` with timestamps), no database.
  - **Meters + DTs:** export + `/portal/dts` (about 4 portal calls), cached with a **15-minute TTL** (they can change: status, new meters).
  - **Energy:** fetched per meter on demand, cached by meter + date range. **Past days are cached long**, since a recorded reading does not change.
  - **Stale-while-revalidate:** when an entry expires, serve the old copy and refresh in the background, so users never wait on the portal.
  - **Single flight:** if many requests arrive during a refresh, they all wait on the same portal call (no duplicate calls).
  - **Fallback:** if the portal is down or rate limiting, answer from the last good cache and mark the response as stale.
- **Why:** the data changes rarely, the portal rate limits (observed burst of about 120 requests across /portal/* before a 429; refill window unverified), and the session lasts 1 hour. Caching fixes speed and rate-limit problems with the least machinery.
- **Rejected:**
  - Live proxy (every request hits the portal): slow, burns the rate limit, our API would leak the portal's 429s.
  - Background sync into a database (SQLite): survives restarts and allows rich queries, but sync scheduling + schema is too much for the time box. Kept as the "larger scale" answer.
- **Trade-offs:** data up to 15 min stale; cache lost on restart (it refills); several service instances would each keep their own cache.
- **Scale note (for the query layer):** in-memory filtering and a haversine "near me" scan are fine up to roughly 100k meters; beyond that, move to SQLite/Postgres with a spatial index (PostGIS).
- **Later, optional:** a background job that slowly warms the energy cache for all meters (about 3.5 min under the rate limit), needed only for anomaly summaries / charts in a web client.
- **Interview line:** "The data changes rarely and the portal is rate limited, so I cache in memory with a TTL and stale-while-revalidate. A database sync would survive restarts and allow richer queries, but it was too much machinery for the scope."
- **Extensions covered:** "Freshness / caching", enables "Local index / query layer", supports "Robustness".
- **Search topics:** cache aside pattern, TTL cache explained, cache stampede, stale while revalidate, haversine formula.

---

## D3. Data cleaning: normalise, repair, and flag every repair

**Remember: clean what we safely can, never hide it; every repair is recorded in a `dataQuality` note.**

- **Chosen rules:**
  1. Numbers sent as strings become real numbers.
  2. `DD/MM/YYYY HH:mm` becomes ISO 8601 with IST, e.g. `2026-06-23T23:30:00+05:30` (timezone is an assumption, documented).
  3. Blank strings (`""`) become `null`.
  4. Blank hierarchy code/name: filled from other meters on the same DT and flagged `filled_from_dt_siblings`; if nothing can fill it, `null` and flagged `missing`.
  5. Conflicting DT name (DT-007 "Old Malviya Nagar Xfmr"): `/portal/dts` name is official, the other kept as an alias, flagged.
  6. Incomplete duplicate energy row (same timestamp, empty kWh): dropped, complete row kept, flagged in the energy response.
  7. One consistent camelCase field vocabulary across our API.
- **Deliberately not "fixed":** decommissioned meters with readings (a real fact, reported as is); serial prefix not matching make (not an error, nothing inferred); 30 min vs daily intervals (handled in D4).
- **Principle:** every rule is generic (e.g. "drop an incomplete row that duplicates a complete one"); no meter IDs are hard-coded.
- **Flag shape:** `"dataQuality": [{ "field": "hierarchy.circle.code", "issue": "blank_in_source", "action": "filled_from_dt_siblings" }]`
- **Rejected:** pass-through (not a clean API); format-only normalisation (leaves content problems to every consumer).
- **Trade-off:** inferred fills could be wrong if a meter genuinely sits on a different chain than its DT siblings; the flag makes that visible instead of silent.
- **Interview line:** "I normalise types and dates, repair what can be safely inferred, and record every repair in the response. Consumers get clean data without me hiding that the source was messy."
- **Extension covered:** "Network hierarchy" (watch out for messy data), supports "Robustness".
- **Search topics:** data normalization ETL, ISO 8601 timezone offsets, data quality flags.

---

## D4. Consumption: C-lite (register readings + per-interval usage + interval metadata)

**Remember: the portal's `kwh` is an odometer, not consumption; we return the odometer, the usage per interval, and say what the interval is.**

- **Chosen (core):**
  - Cleaned register readings (`kwh`, `kvah`, `voltageR`) as numbers with ISO timestamps (from D3).
  - `intervalMinutes` on every energy response (30 or 1440), **detected from the data** (most common gap between timestamps), never from meter ID ranges.
  - `kwhDelta` / `kvahDelta` on each reading = usage **during the interval ending at that timestamp**. `voltageR` is never differenced (point-in-time value).
  - `units` block: kWh, kVAh, V.
- **Delta rules:**
  1. First row in the window: delta `null` (no earlier reading in the window).
  2. Gap larger than the interval: delta spans the gap, flagged `gap_before`.
  3. Negative delta (reset or replaced meter): delta `null`, flagged. Not seen in the data; a cheap generic guard.
- **Moved out of core:** `?granularity=daily` roll-up goes to build stage 4 (query layer). Power factor (kWhDelta / kVAhDelta) is a README idea only.
- **Why:** the brief needs "sensible" consumption data. Returning only the cumulative `kwh` invites reading 42594 kWh as consumption; the delta is about 10 lines and removes that risk. `intervalMinutes` removes the 30 min vs daily ambiguity.
- **Rejected:** registers only (every consumer redoes the maths); deltas only (loses the values field teams check against the physical meter display); full C with roll-up + power factor in core (over-sized for the brief).
- **Trade-off:** first row's delta is null; fetching one extra earlier reading would fill it (README, "more time").
- **Interview line:** "The source field is cumulative and mislabelled as `kwh`. Returning only that would invite a wrong reading of consumption, so I add per-interval usage and state the interval explicitly. It's about 10 lines and removes the biggest misinterpretation risk in the data."
- **Search topics:** cumulative vs interval meter data, smart meter interval data, kWh vs kVAh power factor.

---

## D5. Hierarchy: path-based nodes, exposed on meters + a /network tree + /transformers

**Remember: codes repeat under different parents, so a node is identified by its full path (e.g. `Z-02/C-05/D-01`), never by code alone.**

- **Node identity:** full path of codes from zone down. Assumption (documented): codes may only be unique within their parent.
  - If codes are parent-scoped, the path is correct. If codes were meant to be global, the reviewer sees e.g. "Division 1" under three circles, visible instead of silently merged.
  - Keying by code alone would give one node with several parents (no longer a tree). 61 codes appear under more than one parent; the response reports this count.
- **Exposure (option C):**
  - Each meter keeps its `hierarchy` path (free, from the export).
  - `GET /network`: nested tree; each node has `level`, `code`, `name`, `path`, counts (meters total, installed, faulty, decommissioned), `children`. Built by grouping meters by path (about 30 lines).
  - `GET /transformers`: the 40 DTs from `/portal/dts` (name, feeder, capacity kVA) plus meter count.
  - Filtering meters by level (e.g. `?feeder=F-001`) moves to build stage 4 (query layer).
- **Rejected:** path on meters only (no way to browse the network); tree only (meters lose context); code-keyed nodes (merges possibly different nodes, breaks the tree).
- **Trade-off:** if codes really are global, our tree shows duplicates instead of one merged node; chosen because visible duplication is safer than an unproven merge.
- **Interview line:** "Codes repeat under different parents, so I can't treat them as global IDs. I identify nodes by their full path, which is correct if codes are scoped to their parent and visibly flags the problem if they're not, and I report how many codes conflict."
- **Extension covered:** "Network hierarchy" (reconstruct the structure, expose it usefully, handle messy data).
- **Search topics:** materialized path tree, building a tree from flat data, hierarchical data modeling.

---

## D6. Validation and errors: strict input, one error shape, honest status codes

**Remember: reject bad input loudly with a 400, answer every error in one JSON shape, and use 502/503/504 when the portal is at fault.**

- **Chosen:**
  1. **Strict validation with zod:** bad formats, unknown query params, `from` after `to`, and ranges over 31 days all return 400 `validation_error` with a `details` list (`param` + `issue`).
  2. **One error shape everywhere:** `{ "error": { "code", "message", "details" } }`, also for unknown routes (404 `not_found`) and crashes (500 `internal_error`, no stack traces).
  3. **Gateway status codes for portal failures,** used only when no cached copy can answer (the D2 fallback comes first): 502 `upstream_error` (portal sent something unexpected), 503 `upstream_unavailable` (rate limited or login failing; sends `Retry-After`), 504 `upstream_timeout`.
  4. **31-day cap** on energy ranges.
- **Why:** the portal fails silently. Bad dates and unknown params return the default window with 200, reversed ranges return an empty 200, a failed login is a 200 with "failure" in the body, and "not found" comes in three shapes. A client cannot tell a typo from "no data". A strict 400 makes mistakes visible, and gateway codes tell the client whose fault it is and whether retrying makes sense.
- **Why 31 days:** one month covers the whole dataset and bounds a response to at most 31 x 48 = 1488 readings.
- **Rejected:**
  - Lenient parsing like the portal: hides client bugs.
  - Passing portal errors straight through: a portal 401 (our session expired) would look like the client is unauthorised, when the client did nothing wrong.
  - RFC 7807 `application/problem+json`: a real standard, but more fields than this API needs; noted as an improvement.
- **Trade-off:** a client sending a harmless extra param (e.g. a cache buster `_=123`) gets a 400; documented. Longer ranges need several calls.
- **Interview line:** "The portal fails silently, so a typo looks the same as no data. My API rejects bad input with a clear 400, uses one error shape everywhere, and uses 502, 503 and 504 so clients know the problem is upstream and whether to retry."
- **Search topics:** zod validation tutorial, HTTP status codes 4xx vs 5xx, HTTP 502 vs 503 vs 504 explained, Retry-After header, RFC 7807 problem details, express error handling middleware.

---

## D7. Stack: JavaScript + Express, minimal dependencies

**Remember: plain JavaScript on Node 20+ with Express; Node's built-ins cover HTTP, signing and tests, so only 3 runtime dependencies.**

- **Why Express / JS:** the brief says framework choice isn't evaluated; my strongest stack keeps time on problem solving and docs, which are graded higher.
- **Sub-choices:**
  1. **Node 20+:** built-in `fetch` (no axios), `Headers.getSetCookie()` to read the portal session cookie, built-in test runner.
  2. **ES modules** (`import` / `export`).
  3. **HMAC signing with `node:crypto`:** `createHmac('sha256', secret).update(message).digest('hex')`.
  4. **Validation with `zod`:** one schema per endpoint, turned into clean 400 errors.
  5. **openapi.json written by hand**, served at `/docs` with `swagger-ui-express`. Drift risk mitigated by a test that checks real responses against the spec.
  6. **Tests:** `node:test` + `supertest`, against a fake portal client fed with data shaped like what we captured (never hits the real portal or its rate limit).
- **Dependencies:** runtime `express`, `zod`, `swagger-ui-express`; dev `supertest`.
- **Rejected:** TypeScript (would allow generated specs, but adds a build step for little gain here); FastAPI (auto-generates OpenAPI, but not my strongest language).
- **Interview line:** "I kept dependencies minimal. Node's built-in fetch, crypto and test runner cover HTTP, signing and tests, so every dependency in package.json is there for a reason I can explain."
- **Search topics:** Node.js fetch API, HMAC SHA256 explained, zod validation tutorial, OpenAPI 3 tutorial, supertest express testing.

---

## D8. Endpoints and response shapes

**Remember: resource endpoints live under /v1, every success is `{ data, meta }`, every error is `{ error }`, and energy needs explicit `from` and `to`.**

- **Endpoints:**

  | Stage | Endpoint | Purpose |
  |---|---|---|
  | 1 | `GET /v1/meters?limit=&offset=` | All meters, cleaned, paginated |
  | 1 | `GET /v1/meters/{meterId}` | One meter |
  | 1 | `GET /v1/meters/{meterId}/energy?from=&to=` | Readings + deltas (D4) |
  | 1 | `GET /v1/transformers` | 40 DTs + meterCount, no paging |
  | 1 | `GET /health` | Process + cache status, never calls the portal |
  | 1 | `GET /docs`, `GET /openapi.json` | Swagger UI + spec |
  | 3 | `GET /v1/network` | Hierarchy tree (D5) |
  | 4 | Filters and `near` on `/v1/meters`, `granularity=daily` on energy | Query layer |

- **Chosen:**
  1. **Envelope:** every success is `{ data, meta }`. `meta` always has `fetchedAt` and `stale`; lists add `total`, `limit`, `offset`. `/health` is the one exception (bare body), because it is an operations endpoint read by monitoring tools, not data.
  2. **Energy dates:** `from` and `to` are both required (`YYYY-MM-DD`, inclusive, IST); otherwise 400. We always send both to the portal, which sidesteps its default-window quirk.
  3. **Paging:** `limit`/`offset` on `/v1/meters`, default 100, max 500.
  4. **Enum values:** lowercase snake case (`installed`, `ct_operated`, `whole_current`); the mapping from portal values is documented in PROTOCOL.md.
- **Defaults agreed:**
  - `/v1` prefix.
  - List returns full meter objects (no N+1 calls for clients).
  - meterId is case-insensitive and normalised to uppercase; an unknown id returns 404 from the cache, with no portal call.
  - Range over 31 days or `from` after `to`: 400.
  - Empty window: 200 with `readings: []` and `intervalMinutes: null`.
  - Reading-level flags (`gap_before`, `negative_delta`, dropped duplicate) go in one `dataQuality` list with a `timestamp`.
  - `dtCode` dropped from meters (duplicates `hierarchy.dt.code`).
  - A hierarchy code that cannot be repaired appears as `unknown` in the path and is flagged.
  - openapi.json covers only what is built and grows with each stage.
  - The signing secret and session cookie never appear in any response or log.
- **Rejected:**
  - Bare bodies with freshness in headers: headers are easy to miss and hard to see in Swagger UI.
  - Optional dates copying the portal default: inherits a documented quirk. Defaulting to the last 7 days before today: always empty for this dataset.
  - No paging (does not scale) and cursor paging (overkill for an in-memory list).
  - Portal enum values (`"CT Operated"`): mixed case and spaces in future filter values.
- **Trade-offs:** clients read `.data`; the simplest energy request is slightly longer; enum values differ from what operators see in the portal UI.
- **Interview line:** "Every response has the same shape, so freshness and paging always live in `meta`. I made dates required because the portal's hidden default is a quirk, not a feature, and I normalised enum values so the later filters are clean."
- **Search topics:** REST API pagination limit offset vs cursor, API response envelope design, REST API versioning, health check endpoint best practices.

---

## D9. Cleaning details settled while coding (refines D3 and D4)

**Remember: flag content repairs, not format conversions; official names beat sibling guesses; keep the more complete duplicate; round deltas to 3 decimals.**

- **Chosen:**
  1. **What gets a `dataQuality` flag:** content repairs only (blank filled, conflict resolved, row dropped, unreadable value, gap, negative delta). Routine conversions (numeric strings to numbers, DD/MM/YYYY to ISO) are documented once in PROTOCOL.md, not flagged per value.
  2. **`sourceValue` on a flag:** when a value is replaced or dropped, the original portal value is kept in the flag (e.g. "Old Malviya Nagar Xfmr").
  3. **Repair order:** official DT name from `/portal/dts` first, then DT-sibling fill. A sibling fill uses the most common value among meters on the same DT; ties go to the first meter by meterId, so results are deterministic.
  4. **Blank DT code:** filled from the record's top-level `dtCode`, since the DT is the anchor for every other repair.
  5. **Duplicate timestamps:** keep the row with more values; on a tie keep the first and flag `duplicate_row`. Covers the known corrupt row without hard-coding it.
  6. **Unreadable timestamps:** row dropped and flagged with `sourceValue`, since a reading that cannot be placed in time cannot be differenced. Impossible dates (31/02) count as unreadable.
  7. **Delta rounding:** 3 decimals (watt-hour precision), to remove floating point noise like 0.48999999999796.
- **Why:** flagging every type conversion would put about 1500 flags on a month of half-hourly data and bury the real repairs. Official data beats inference. Determinism makes tests and caching reliable.
- **Rejected:**
  - Flagging every conversion: noise.
  - Sibling fill before the official name: a guess would override an authoritative source.
  - Keeping the last duplicate: the PDF shows the first row of the pair is the valid one.
  - Leaving float noise: confusing to consumers.
- **Trade-off:** rounding loses precision below 1 Wh (far below the source's own precision). The tie-break rule is arbitrary but documented.
- **Interview line:** "I flag repairs, not conversions, so the quality list stays readable. Authoritative data beats inference, and every rule is generic and deterministic, so nothing depends on a specific meter ID."
- **Search topics:** floating point precision JavaScript, deterministic algorithms, data deduplication strategies, mode statistics.

---

## Build order (agreed)

1. Core API + PROTOCOL.md + openapi.json + README + reflection (required, fully done)
2. Robustness + freshness (part of the portal client)
3. Hierarchy endpoint
4. Query layer (filters + "near me")
5. Web client, only if time is left (map of meters + consumption chart)

Each step leaves a complete submission, so work can stop at any point.
