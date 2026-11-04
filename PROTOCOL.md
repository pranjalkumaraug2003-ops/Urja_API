# Urja Meter Ops portal: how it works

What I learned by exploring the portal at `https://urja-ops.flockenergy.tech` (logged in as the operator account, read-only), and what this service relies on. Explored on 3 Nov 2026; the login, cookie and signing behaviour were confirmed again by `npm run smoke` on 4 Nov 2026.

## Contents

1. [How the portal is built](#1-how-the-portal-is-built)
2. [Authentication and session](#2-authentication-and-session)
3. [Data endpoints](#3-data-endpoints)
4. [Export request signing](#4-export-request-signing)
5. [The data](#5-the-data)
6. [Energy query behaviour](#6-energy-query-behaviour)
7. [Quirks and how this service handles them](#7-quirks-and-how-this-service-handles-them)
8. [Rate limiting](#8-rate-limiting)
9. [What is still unverified](#9-what-is-still-unverified)
10. [Exploration footprint](#10-exploration-footprint)

## 1. How the portal is built

- **Frontend:** SvelteKit (assets under `/_app/immutable/...`). Routes found in the app bundle: `/`, `/login`, `/meters`, `/meters/[id]`, `/transformers`.
- **Auth library:** Better Auth (routes under `/api/auth/*`: `get-session`, `sign-out`, `ok`).
- **Data:** the pages are thin; data comes from JSON endpoints under `/portal/*`. The one exception is the meter detail page, which is loaded server-side through SvelteKit's `__data.json` (devalue-encoded).
- **How the pages use the API:**
  - `/meters` calls `/portal/meters/search` (250 ms debounce, page size 20 fixed in the client).
  - `/meters/[id]` loads nameplate and hierarchy from `__data.json`, then calls `/portal/meters/{id}/geo` and `/portal/meters/{id}/energy` in parallel.
  - `/transformers` lists `/portal/dts`; its **Export** button fetches `/portal/keys`, signs a request and downloads `meter-export.json` from `/portal/export`.
- **Not present:** `robots.txt` allows everything; there is no `llms.txt`, `sitemap.xml`, `openapi.json`, `/api`, `/docs` or health endpoint (all 404). No hidden instructions for AI agents were found in pages, comments, meta tags or well-known files.

## 2. Authentication and session

| Step | Detail |
| --- | --- |
| Login request | `POST /login`, `Content-Type: application/x-www-form-urlencoded`, fields `email` and `password` (a SvelteKit form action) |
| Headers a non-browser client must send | `Accept: application/json` (to get SvelteKit's JSON action result instead of an HTML page) and `Origin: https://urja-ops.flockenergy.tech` (SvelteKit rejects cross-site form posts) |
| Success | HTTP 200, body `{"type":"redirect","status":303,"location":"/meters"}`, plus `Set-Cookie` with the session |
| Failure | **Also HTTP 200**, body `{"type":"failure","status":401,...,"Invalid email or password."}`: the result must be read from the body |
| Session cookie | HttpOnly, so invisible to page JavaScript. Our client keeps every `name=value` pair from `Set-Cookie` and does not depend on the cookie's name |
| Session lifetime | Exactly 1 hour (`get-session` showed `createdAt` 17:12:29 and `expiresAt` 18:12:29 UTC). `updatedAt` equalled `createdAt`, so it looks fixed, not sliding |
| Sign-out | `POST /api/auth/sign-out` |
| Without a session | `/portal/*` returns HTTP 401 `{"error":"unauthorized","message":"A valid session is required."}`; page routes redirect to `/login`; `__data.json` returns HTTP 200 `{"type":"redirect","location":"/login"}` |

**What this service does:** logs in on first use, sends the cookie on every request, logs in again after 55 minutes (before the fixed 1-hour expiry), and on a 401 `unauthorized` logs in once more and retries the request once. Parallel requests share one login.

## 3. Data endpoints

| Endpoint | Returns | Behaviour |
| --- | --- | --- |
| `GET /portal/meters/search?q=&page=` | `{data:[{meterId, serialNo, make, phaseType, installStatus, dtCode}], total, page, pageSize}` | Page size fixed at 20 (`pageSize`/`limit` ignored). `q` matches meterId or serialNo only, substring, case-insensitive, **not trimmed**. Other filters ignored. `page` 0, -1 or `abc` fall back to 1 |
| `GET /meters/{id}/__data.json` | SvelteKit devalue payload: `{meterId, detail, hierarchy}` | Not rate limited. Unknown id: HTTP 200 with an error node inside (`status: 404`) |
| `GET /portal/meters/{id}/geo` | `{data:{latitude, longitude}}` as strings | Unknown id: 404 `{error:"not_found"}`. Path ids are case-sensitive |
| `GET /portal/meters/{id}/energy?from=&to=` | `{data:[{timestamp, kwh, kvah, voltR}]}`, all strings | See section 6 |
| `GET /portal/dts?page=` | `{data:[{code, name, feederCode, capacityKva}], total:40, page, pageSize:20}` | 2 pages. `capacityKva` is a number (63, 100, 160, 250, 400) |
| `GET /portal/keys` | `{data:{signingSecret}}` (32 characters) | Same secret every call, available to any logged-in user |
| `GET /portal/export?page=1` | `{data:[403 full meter records], total:403}` | Needs HMAC headers (section 4). `page` is ignored: always all 403 meters |

**What this service uses:** `/portal/dts` (2 requests), `/portal/keys` + `/portal/export` (2 requests) for all meters, and `/portal/meters/{id}/energy` per meter and window. About 4 requests load the whole network; the search and detail pages are not needed (D1 in DECISIONS.md).

**An export record:**

```json
{ "meterId": "J100000", "serialNo": "SE33962", "make": "HPL", "phaseType": "single",
  "installStatus": "Decommissioned", "installType": "Whole Current", "build": "legacy",
  "dtCode": "DT-001",
  "hierarchy": { "zone": {"name": "Jaipur Zone 1", "code": "Z-01"}, "circle": {"...": "..."},
                 "division": {}, "subdivision": {}, "substation": {},
                 "feeder": {"name": "Feeder 1", "code": "F-001"},
                 "dt": {"name": "Malviya Nagar DT 1", "code": "DT-001"} },
  "geo": { "lat": 26.938961002479868, "lng": 75.83095696146852 } }
```

The export's coordinates matched `/geo` exactly for every meter checked (the export uses numbers, `/geo` strings).

## 4. Export request signing

```
secret    = GET /portal/keys -> data.signingSecret
timestamp = current unix time in seconds, as a string
message   = "GET" + "\n" + "/portal/export" + "\n" + "<query string, e.g. page=1>" + "\n" + timestamp
signature = lowercase hex( HMAC-SHA256(key = secret, message) )
headers   = x-timestamp: <timestamp>, x-signature: <signature>
```

| Test | Result |
| --- | --- |
| No headers, or a wrong signature | 401 `{error:"signature_invalid"}` |
| Timestamp 60 s old, or 120 s in the future | 200 |
| Timestamp 300 s old or more | 401 (the window is under 5 minutes) |
| Signed for `page=1`, sent `page=2` | 401 (the query string is part of the message) |
| Same signature sent twice | 200 both times (no replay protection) |
| `page=2`, or no query (signed correctly) | 200 with all 403 meters |

Any logged-in user can read the secret, so the signature is friction rather than security. This service fetches the secret right before each export, never caches or logs it, and never exposes it.

## 5. The data

**Meters (403):** ids `J100000` to `J100402`, no duplicate ids or serials.

| Field | Values |
| --- | --- |
| `installStatus` | Installed 238, Faulty 90, Decommissioned 75 |
| `phaseType` | single 277, three 126 |
| `installType` | Whole Current 205, CT Operated 198 |
| `build` | legacy 238, v2 165 |
| `make` | HPL 90, Genus 88, Secure 85, Allied 76, L&T 64 |

Serial prefixes (SE, GE, AL, HP, L&, GN) do not match the make (an SE serial on an HPL meter); only the 3 newest meters use GN.

**Network hierarchy:** Zone (3) > Circle (7) > Division (10) > Subdivision (14) > Substation (19) > Feeder (29) > DT (40), all in Jaipur. Each DT has 10 to 13 meters. `/portal/dts` feeder codes match the export for every DT.

- **Codes are not unique:** D-01 appears under C-01, C-03 and C-05; SS-01 under SD-01, SD-05 and SD-09; F-001 under SS-01 and SS-11. 61 codes have more than one parent, so a tree keyed by code alone is wrong. This service identifies a node by its path of codes (`Z-01/C-01/D-01`).
- **The DT is a reliable anchor:** all meters on one DT share the same upward chain, apart from blank fields.

**Energy readings:**

- Fields `timestamp` (`DD/MM/YYYY HH:mm`, no timezone), `kwh`, `kvah`, `voltR`, all strings.
- `kwh` and `kvah` are **cumulative registers** (like an odometer: they never decrease in clean data). Consumption is the difference between two readings.
- Data exists only for 1 to 30 June 2026.
- Half-hourly (48 a day) for J100000 to J100039 (40 meters); daily at 00:00 for the other 363. No field says which.
- `voltR` ranged 220 to 240 V. Three-phase meters still report only `voltR`.

**Value mapping in this API** (lowercase snake case, D8):

| Portal | API |
| --- | --- |
| `Installed`, `Faulty`, `Decommissioned` | `installed`, `faulty`, `decommissioned` |
| `Whole Current`, `CT Operated` | `whole_current`, `ct_operated` |
| `single`, `three`; `legacy`, `v2` | unchanged |
| `geo.lat`, `geo.lng` | `location.lat`, `location.lng` |
| `voltR` | `voltageR` |
| `23/06/2026 23:30` | `2026-06-23T23:30:00+05:30` (IST assumed) |

## 6. Energy query behaviour

Measured on half-hourly meter J100001:

| Query | Result |
| --- | --- |
| No params | Last 7 days **of the data** (not of today): 23/06 23:30 to 30/06 23:30, 337 rows |
| `from=2026-06-01` | 7 days from that date: 01/06 00:00 to 08/06 00:00, 337 rows |
| `to=2026-06-10` | 7 days ending that day: 04/06 00:00 to 10/06 23:30, 336 rows (off by one vs from-only) |
| `from=2026-06-01&to=2026-06-03` | 01/06 00:00 to 03/06 23:30, 144 rows (`to` covers the whole day) |
| `from=2026-06-01&to=2026-06-01` | 48 rows (confirmed by the smoke test) |
| `from=2026-05-01&to=2026-06-30` | 1440 rows; no maximum range found |
| Dates outside June 2026, or `from` after `to` | 200 with empty data |
| `from=01/06/2026`, `from=garbage`, `from=2026-06-01T12:00:00` | Silently ignored: the default window is returned |
| `start`, `startDate`, `fromDate`, `since`, `days`, `window`, `limit`, `page` | Silently ignored |

**What this service does:** always sends both `from` and `to`, so the hidden default window never applies, and validates dates itself (bad dates, unknown params, reversed or over-31-day ranges are a 400 here instead of a silent default).

## 7. Quirks and how this service handles them

| # | Quirk | Handling |
| --- | --- | --- |
| 1 | Two nameplate formats on detail pages (legacy array of `{parameterName, parameterValue}`; v2 JSON string inside JSON) | Avoided: the export returns one structured shape for both |
| 2 | Mixed intervals (30 min and daily) with no field saying which | `intervalMinutes` detected from the data (most common gap) on every energy response |
| 3 | Corrupt duplicate row on 5 legacy meters (J100089, J100134, J100195, J100211, J100330): a second `30/06/2026 00:00` row with blank `kwh` and `voltR` | Generic rule: one row per timestamp, the more complete row wins; the drop is listed in `dataQuality` |
| 4 | Energy query parsing is silent (unknown params and bad dates ignored, reversed ranges empty) | Strict validation, 400 with every problem listed |
| 5 | Default window is the last 7 days of the data; from-only and to-only differ by a row | Both dates required here; always sent to the portal |
| 6 | Timestamps without timezone | Converted to ISO 8601 with `+05:30` (assumption: the utility is in Jaipur) |
| 7 | Numbers as strings in `/geo` and `/energy` | Converted to numbers; a blank becomes `null` (never `0`) |
| 8 | Non-unique hierarchy codes | Nodes identified by path; `/v1/network` reports `codesUnderMultipleParents` |
| 9 | Blank hierarchy fields on 22 meters (codes: circle 11, feeder 8, substation 3; plus some blank names) | Filled from other meters on the same DT and flagged `filled_from_dt_siblings`; if nothing can fill it, `null` and `left_null` |
| 10 | Renamed DT: J100400 to J100402 call DT-007 "Old Malviya Nagar Xfmr"; `/portal/dts` and the other meters say "Sanganer DT 7" | `/portal/dts` name is official; the other name is kept as an alias on the transformer and flagged on the meter |
| 11 | Decommissioned meters still report readings | Reported as they are; not "fixed" |
| 12 | Three kinds of "not found" (JSON 404, HTTP 200 with a 404 inside, HTML 404) | The client checks `content-type` and treats HTML as a bad response; our API has one error shape |
| 13 | Login failure is HTTP 200 | Login result read from the body |
| 14 | Search is case-insensitive, path ids are case-sensitive | Our meter ids are case-insensitive (normalised to uppercase) |
| 15 | Page size fixed at 20 | DT list paged through until `total` is reached |
| 16 | Signing secret handed to every user, replays accepted, export pagination fake | Noted; secret kept server-side and never exposed |

## 8. Rate limiting

- **Observed:** a burst of about 120 rapid requests across `/portal/*` before HTTP 429 `{"error":"rate_limited","message":"Rate limit exceeded; slow down."}`. The 119th rapid request (about 5.5 s into a burst) was the first 429. **The refill window is unverified** (it could be a fixed or sliding window; it is not necessarily "120 per minute").
- The limit is shared across `/portal/*`; `/meters/{id}/__data.json` was not limited.
- No `Retry-After` or rate-limit headers. Recovery took about 10 to 25 s in tests.
- Responses carry no caching headers or ETags.

**What this service does:**

- Loads all meters and DTs in about 4 requests and caches them for 15 minutes; past energy windows are cached for good (D1, D2).
- Spaces its own requests at least 500 ms apart (`PORTAL_MIN_INTERVAL_MS`), so it cannot burst.
- After a 429 it stops calling the portal for 30 s and tells its own clients when to retry (`Retry-After`).
- When a refresh fails, it keeps serving the last good copy, marked `stale: true`.

## 9. What is still unverified

- Whether the Origin header is strictly required (it is sent, as a browser would, and login works with it).
- Whether the 1-hour session ever extends on activity (it looked fixed; the client logs in again after 55 minutes regardless).
- The exact rate-limit window shape.
- The session cookie's exact name, which the client does not need.

## 10. Exploration footprint

- All requests were GETs except login form posts (isolated requests without cookies) used to test the login action.
- About 900 read-only requests in total, including one full June energy sweep of all 403 meters and one deliberate rate-limit measurement; the limit was triggered twice. Nothing was modified.
