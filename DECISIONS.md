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

## D10. First reading in an energy window: delta stays null (documented)

**Remember: a window's first reading has no earlier reading inside the window, so its delta is null; we document it instead of fetching an extra day.**

- **Chosen (option a):** keep D4 rule 1 as is. The first reading of every window has `kwhDelta: null` and `kvahDelta: null`. The API docs and README say: to get usage for the first interval, start the window one interval (one day for daily meters) earlier.
- **Why:** zero extra logic and nothing invented; `null` is honest. The rule is easy to explain and to test.
- **Rejected (option b):** ask the portal for one extra day before `from` and use that reading only as the baseline. Fills every delta at no extra request cost, but adds hidden behaviour (a reading used but not returned) and about 10 lines plus tests.
- **Trade-offs (known and accepted):**
  - A one-day query on a daily meter (363 of 403 meters) returns 1 reading and no usage.
  - Windows do not add up: two back-to-back windows lose the interval at their boundary.
  - Clients wanting complete usage must widen the window themselves.
- **Interview line:** "The first reading in a window has nothing to subtract from, so I return null and document how to get it, rather than silently fetching data outside the requested range. Fetching one extra day is a 10-line change if consumers need it."
- **Search topics:** cumulative vs interval meter data, fencepost error, API design least surprise.

---

## D11. HTTP layer details settled while coding (refines D2, D6, D8)

**Remember: back off after a 429 instead of retrying, keep serving stale data while the portal is down, and warm the cache at startup.**

- **Chosen:**
  1. **429 cooldown in the portal client:** after a 429, no portal call is made for 30 s (the portal sends no Retry-After; recovery took 10 to 25 s in tests). Calls in that window fail at once as `rate_limited` with the seconds left, which becomes our `Retry-After`.
  2. **Refresh backoff in the cache:** a failed background refresh keeps the stale copy and waits 30 s before the next attempt, so a down portal is not hit on every request.
  3. **Cache bound:** at most 1000 entries; the least recently loaded is evicted first (a `Map` keeps insertion order).
  4. **Dataset load is sequential** (DTs, then keys, then export), not parallel: about 4 requests, gentler on the shared rate limit.
  5. **Warm-up at startup:** the server loads meters and DTs once on boot; a failure is logged, not fatal.
  6. **Status mapping:** `unreachable` and `bad_response` give 502, `timeout` 504, `rate_limited` and `auth_failed` 503 with `Retry-After`, portal `not_found` 404.
  7. **`/health` does not validate query params** and reports `degraded` until the first load succeeds or when the last portal call failed (a portal 404 for one meter does not count). Data that expired only because nobody asked for it shows `stale: true` but is not degraded.
  8. **Validation order:** an impossible date (31 February) skips the range checks, so the client sees one clear error, not two.
- **Why:** each rule protects the portal's rate limit or gives the client one clear answer.
- **Rejected:**
  - Retrying immediately after a 429: burns the limit and extends the block.
  - Parallel loads: faster by a fraction of a second but doubles the burst.
  - No cache bound: memory could grow with many different energy windows.
- **Trade-off:** fixed 30 s pauses are a guess at the portal's window. A proper throttle (request spacing) is the robustness step.
- **Interview line:** "The portal rate limits and sends no Retry-After, so after a 429 I stop calling it for 30 seconds and tell my clients exactly how long to wait. If a refresh fails, they keep getting the last good data, marked stale."
- **Search topics:** exponential backoff, circuit breaker pattern, LRU cache, Retry-After header, graceful shutdown Node.js.

---

## D12. Network endpoint: one tree, counts per node, computed once per refresh (refines D5)

**Remember: `/v1/network` is built from the cached meters when they load, so it costs no portal calls and no work per request.**

- **Chosen:** `GET /v1/network` returns `{ summary, tree }`. Each node has `level`, `code`, `name`, `path`, `counts` (`meters` and `byStatus`) and `children`; DT nodes also list `meterIds`. `summary` gives node counts per level and `codesUnderMultipleParents` (61 in the real data). A node's name is the most common name among its meters. Children are sorted by code, then path.
- **Why:** browsing the network needs the whole shape at once (about 120 nodes, small). Building it during the dataset refresh means every request is a lookup.
- **Rejected:** a node-by-node endpoint (`/v1/network/{path}`): more endpoints for a tree this small; meter filtering by `path` already covers drilling down.
- **Trade-off:** the full tree is always returned; for a much larger network a `depth` or subtree parameter would be needed.
- **Interview line:** "The tree is derived data, so I build it once per refresh and serve it from memory. Nodes are keyed by path, and the response says how many codes would have collided if I had keyed by code."
- **Search topics:** building a tree from flat data, materialized path tree.

---

## D13. Query layer: in-memory filters, path prefix, near me, daily roll-up

**Remember: filters run on the cached meters, paths match a node and everything under it, near me uses haversine, and daily usage counts each interval on the day it started.**

- **Chosen:**
  1. **Filters on `/v1/meters`:** `installStatus`, `phaseType`, `installType`, `build` (comma-separated lists), `make` (case-insensitive), `dt`, `path`, `q` (meterId or serial substring). Filter first, then page; `meta.total` counts the filtered meters.
  2. **`path` prefix match:** `Z-01/C-01` matches that node and everything under it, case-insensitive; `Z-01/C-0` matches nothing (a partial code is not a parent). Paths, not single codes, because codes repeat (D5).
  3. **Near me:** `near=lat,lng` plus `radiusKm` (default 2, max 50); results sorted by distance with `distanceKm`; meters without coordinates left out; `radiusKm` without `near` is a 400.
  4. **Daily roll-up:** `granularity=daily` on the energy endpoint returns `days` instead of `readings`. Each interval's usage counts for the IST day the interval started on (for daily meters the 02/06 reading is 1 June usage). A day is `complete` only if all its intervals had a delta inside the window, so the last day of a window is marked incomplete. Computed from the cached raw window, so it costs no extra portal call.
- **Why:** the brief's query extension (filters, near me) with the least machinery; the cache already holds everything.
- **Scale note:** a linear scan plus haversine is fine to roughly 100k meters; beyond that, a database with indexes and a spatial index (PostGIS).
- **Rejected:** a geo index or database now (overkill for 403 meters); attributing usage to the day the interval ends (wrong for daily meters: the 02/06 00:00 reading would count as 2 June usage).
- **Trade-off:** the last day of a daily window is partial unless the window is extended by a day (consistent with D10).
- **Interview line:** "I filter in memory because 403 meters fit trivially; I state where that stops working and what I would use instead. For daily usage, each interval belongs to the day it started, which is the only rule that is right for both half-hourly and daily meters."
- **Search topics:** haversine formula, geospatial queries PostGIS, time series aggregation.

---

## D14. Robustness and testing: throttle, fake portal end to end, contract test

**Remember: our own traffic is spaced 500 ms apart, the whole chain is tested against a fake portal over real HTTP, and real responses are checked against openapi.json.**

- **Chosen:**
  1. **Throttle in the portal client:** requests start at least `PORTAL_MIN_INTERVAL_MS` (500 ms) apart; each caller books the next slot synchronously, so parallel callers cannot start together. About 120 requests a minute at most.
  2. **Fake portal server (`test/support/fake-portal.js`):** follows the real protocol (form login with Origin check and body-only failure, session cookie, HMAC export signature with its 5-minute window, 20-row pages, JSON 401/404/429 and HTML 404). End-to-end tests run the real app and real client against it over HTTP.
  3. **Contract test:** every path in `openapi.json` has a case whose real response is validated with ajv (`ajv-formats` for dates); a test fails if a path is added without a case.
  4. **Offline demo:** `npm run demo` runs the API and web client against the fake portal with synthetic data.
- **Why:** the live portal is rate limited and must not be hit by tests; a fake that speaks the real protocol tests the client, signing and error mapping end to end. The contract test delivers the drift check promised in D7.
- **Rejected:** mocking `fetch` only (does not exercise real HTTP, headers and cookies); recorded HTTP fixtures (would need many live requests to record); generating the spec from code (D7).
- **Trade-off:** the fake portal encodes my understanding of the real one, so a shared misunderstanding would pass; the live smoke check guards against that. The throttle adds up to 500 ms per queued request under load.
- **Interview line:** "I wrote a small fake of the portal that follows its real protocol, quirks included, so the end-to-end tests cover login, signing and error handling over real HTTP without touching the rate-limited portal. A contract test then checks every response against my OpenAPI spec."
- **Search topics:** contract testing APIs, test doubles fake vs mock, token bucket rate limiting, ajv JSON schema validation.

---

## D15. Web client: one static page, no build step

**Remember: `public/index.html` is plain JavaScript that only uses the public API; it shows a map, filters, meter details with repairs, and a daily usage chart.**

- **Chosen:** a single HTML file served at `/` by `express.static`. Meter list with search, status and make filters; an SVG map of meter locations (equirectangular, positions to scale, no base map, colour by status); meter details with `dataQuality` flags; daily usage bar chart from `granularity=daily` (partial days lighter). All values are written with `textContent`, never `innerHTML`, so portal data cannot inject markup.
- **Why:** shows the API being consumed end to end with no framework, bundler or CDN to install or explain.
- **Rejected:** React or Vite (a build step and dependencies for one page); a tiled map library (external tiles and a CDN dependency).
- **Trade-off:** no base map or street context; basic styling.
- **Interview line:** "The client is deliberately tiny: one file, no build, and it only uses the public API, which is also a good test that the API is usable."
- **Search topics:** vanilla JavaScript fetch API, SVG charts from scratch, XSS textContent vs innerHTML.

---

## D16. Dashboard polish and reviewer-friendly API docs (refines D15)

**Remember: one shared nav on the dashboard and the Swagger page, docs that "Try it out" against whatever server they run on, and a dashboard that shows the API call behind every panel.**

- **Chosen:**
  1. **Shared navigation (`public/nav.js`, `public/nav.css`):** Dashboard, API docs, OpenAPI JSON, Health, GitHub, plus a live status from `/health`. The dashboard loads it with a script tag; the Swagger page gets it through swagger-ui-express's `customJs` and `customCssUrl` options. Swagger's own top bar is hidden.
  2. **Swagger UI options:** endpoints listed open, a filter box, request durations shown, "Try it out" enabled. The docs page uses a copy of the spec whose `servers` is `/`, so requests go to the same host and port; the served `openapi.json` is unchanged.
  3. **Dashboard:**
      - A summary strip from `/v1/network`.
      - An "Explore the API" card with links to the docs and live example calls.
      - A meters / network tab: clicking a tree node filters by `path`.
      - A map click runs a "near me" query (with a radius picker and a drawn circle); filtered-out meters stay grey for context.
      - Meter details with repairs.
      - A daily or per-interval chart.
      - Each panel's footer shows the request it made.
  4. **Still one file, no build step, no CDN;** values from the API are written with `textContent`, never `innerHTML`.
- **Why:** reviewers should find the docs in one click and get back just as easily, and the dashboard should demonstrate the API's features (hierarchy, query layer, daily roll-up) rather than only list data.
- **Rejected:** a React or Vite rebuild (a build step and dependencies for the lowest-weighted, optional part); a custom docs page instead of Swagger UI (more code, less familiar to reviewers).
- **Trade-off:** more front-end code to maintain in one file; the map still has no base layer.
- **Interview line:** "I kept the client tiny but made it show the API at work: every panel prints the request behind it, and the docs and dashboard share one nav. Swagger's Try it out points at the same server, so it works wherever the service runs."
- **Search topics:** Swagger UI configuration, OpenAPI servers relative URL, SVG maps from scratch, accessible navigation landmarks.

---

## Build order (agreed)

1. Core API + PROTOCOL.md + openapi.json + README + reflection (required, fully done)
2. Robustness + freshness (part of the portal client)
3. Hierarchy endpoint
4. Query layer (filters + "near me")
5. Web client, only if time is left (map of meters + consumption chart)

Each step leaves a complete submission, so work can stop at any point.

**Status (4 Nov 2026):** all five steps are built. Steps 1 and 2: D1 to D11. Step 3: D12. Step 4: D13. Step 5: D15, polished in D16. Testing and robustness: D14.
