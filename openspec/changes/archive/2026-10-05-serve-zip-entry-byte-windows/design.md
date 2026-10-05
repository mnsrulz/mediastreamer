## Context

`GET /stream/:imdbid/:size` already does everything needed to serve arbitrary byte ranges of a file: `:size` is `z` + base-32 of the file size, the size resolves a set of upstream links via `GET api/links?imdbId=&size=`, and `MediaStreamRegistry` keys a `ResumableMediaStream` on `(imdbId, size)` holding a `VirtualBufferCollection` that read-ahead fills and rewinds from. `parseRangeRequest` turns a `Range` header into `{start, end}` clamped to the file, and the handler answers `206` + `Content-Range`.

A season zip is just one such file. Its episodes are contiguous windows inside it, and — because only `STORED` (compression method 0) entries are in scope — an episode's bytes are exactly `zip[start..end]`. So the only missing capability is translating a client Range, which is expressed against the *episode*, into a Range against the *archive*, and reporting a `Content-Range` total that matches what the client asked about.

Two facts found while reading the current implementation dominate the design:

1. **`createResumableStream` validates against the streamer's own `size`.** It rejects with `Content Length mismatch: Expected/Actual ${size}/${potentialContentLength}` when the upstream `Content-Range` total differs from `:size`, and with `Range Mismatch` when `rangeValues.start != initialPosition`. Passing the *episode* length as `:size` while streaming from an *archive* upstream fails the first check; offsetting the upstream Range while still asserting `initialPosition` fails the second. Any design that keeps `:size` equal to the archive length and sends absolute archive offsets needs **no change here at all** — that is the whole argument behind `/entry` (design D1/D2).
2. **The streamer has no database.** Upstream URLs, auth headers, `status` and `speedRank` come only from `getLinks`, which issues `GET {LINKS_API_URL}/api/links?imdbId=&size=&per_page=100`: once per `(imdbId, size)` on a registry miss, then again on the debounced 30 s refresh while a stream is active. A warm registry hit and a `HEAD` issue none. The cache app's `expand` defaults **on** for exactly that `imdbId`+`size` scope, so the query must be sent with `expand=false` or the response would carry derived episode rows alongside the archive rows it is asking for (see D2).

Constraints:

- Fastify 5, ESM, TypeScript with `erasableSyntaxOnly` and `.ts` import extensions; Node ≥ 24; no bundler.
- No validation library (`zod` is not a dependency here) — hand-rolled parsing is the house style (`parseRangeRequest` already does it).
- Tests are `node:test` + `tsx` over pure functions (`test/app.test.ts`), not HTTP-level tests; routes are registered inside `src/server.ts`, which also calls `app.listen`, so importing it in a test starts a server.
- The caller (the cache app) owns zip knowledge: it decides which windows are `STORED` and only emits those.

## Goals / Non-Goals

**Goals:**

- Serve an entry-relative byte window of an existing archive through a new `GET`/`HEAD` route.
- Express the window as a path segment `f{start}-{end}` on a nested `/stream/:imdbid/:size/entry/:file` route, so the URL carries no query string while archive identity and the `z`+base-32 size encoding stay identical to the existing route.
- Translate Range semantics correctly: client ranges are relative to the entry; `Content-Range`/`Content-Length` totals are the entry length, not the archive length.
- Reuse `MediaStreamRegistry` unchanged, so all episodes of one archive share a single stream object and one byte buffer.
- Keep the range-mapping logic pure and unit-tested, and fix the `bytes=0-0` defect that byte-precise windows expose.
- Resolve archive rows only, so a derived episode row can never become a stream source.

**Non-Goals:**

- Reading zip central directories, EOCD records, or any archive structure — the streamer never learns it is serving a zip.
- Knowing about compression methods; `DEFLATE` handling is the caller's responsibility.
- Carrying a `window` on a link row and re-basing the streaming core onto it (rejected alternative, D7).
- Changing `VirtualBufferCollection`, or its read-ahead/slow-stream/drain logic.
- Changing the behaviour or contract of `GET|HEAD /stream/:imdbid/:size`.
- Deriving a MIME type; `Content-Type` stays `application/octet-stream` exactly as the whole-zip route returns it.
- Per-entry stats, dashboard changes, or entry-aware `drain`/`cleanup` endpoints.
- Auth (unchanged: the route sits behind the same deployment-level controls it has today).

## Decisions

### D1: Nested route `/stream/:imdbid/:size/entry/:file`

```
GET|HEAD {ROOT_PATH}stream/:imdbid/:size/entry/f{start}-{end}
GET|HEAD /stream/tt123/z4000000/entry/f1048576-2148485119
```

- `f{start}-{end}` are exact decimal integers, inclusive, with no extension and no query string. They are parsed by a single regex (`^f(\d+)-(\d+)$`) and passed straight to `resolveEntryRange`.
- Keeps archive identity in the path exactly as today, so `imdbid`/`size` validation and logging are shared with the existing handler; `z{size}` keeps its existing base-32 form because it is already a public contract (`server.ts:142`).
- Only two routes are registered — `/stream/:imdbid/:size` and `/stream/:imdbid/:size/entry/:file` — and Fastify does not treat them as conflicting (different segment counts). A bare `.../entry` with no `:file` therefore does not match and answers `404`, while a malformed `f…` segment matches and answers `400`.
- A literal `entry` segment keeps the path visibly distinct from a plain archive path, and **this change is the source of truth for the play URL**: the cache app's own change must emit exactly this shape.
- **Cross-repo note (task 6.2):** `mediacatalogcache-netlify`'s change `serve-individual-episodes-from-season-zips` currently writes D8/spec as `.../entry?start={n}&end={n}&name={encoded}` — a query-parameter form this decision rejected. Its artifacts must be conformed to `.../entry/f{start}-{end}` when that change is picked up; no streamer-side change is required. Its D10 already states the derived row's `playableLink` is display-only, so no request is ever nested inside another.
- No extension means no MIME derivation, so `Content-Type` is `application/octet-stream` — what the whole-zip route already returns for real `.mkv` files (`server.ts:150`, `server.ts:177`), and what players that work today already accept.

*Alternative rejected — `?start=&end=&name=` query parameters*: functionally equivalent and easier to build, but leaves the window out of the path, so the URL is not file-shaped, `name` must be URL-encoded (and can contain `&`, `#`, spaces), and a bookmarked or logged URL carries an opaque query string. Decision: path-only.
*Alternative rejected — `/stream/:imdbid/:size/:start/:end`*: also path-only, but drops the `entry` discriminator that distinguishes an entry window from any other future sub-resource, and invites `size`/`start` confusion.
*Alternative rejected — an extension segment (`f{start}-{end}.mkv`)*: buys a MIME type at the cost of another parameter to encode and decode, and the whole-zip route already plays fine without one. Revisit only if a browser-resident player is found to need it.
*Alternative rejected — headers (`X-Zip-Start`) on the existing route*: no new route, but headers are not bookmarkable, are invisible to `curl` users, and fight the fact that `Range` already carries the client's intent.

### D2: Delegate to `globalStreamRegistry.serve()` with absolute archive offsets

The handler computes `absStart = entryStart + relStart`, `absEnd = entryStart + relEnd`, then calls the very same `serve({ imdbId, size, start, end, rawHttpMessage })` the whole-zip route calls, with `size` = the **archive** size.

- **Zero changes to the streaming core.** `createResumableStream`'s size and initial-position checks both pass, because `:size` is the archive length and `initialPosition` is an absolute archive offset — exactly what an upstream `Content-Range` reports. Read-ahead, buffer reuse, slow-stream bisection, drain, link refresh, and idle cleanup all keep working.
- **Consecutive episodes share cache.** `find(imdbId, size)` returns the same `ResumableMediaStream` for every episode of the archive, so episode 2 seeks into bytes episode 1 already downloaded. This is the main payoff of addressing entries as windows of the existing stream rather than as separate streams.
- Buffer, read-ahead, and slow-stream thresholds are expressed in absolute bytes and are therefore already correct for a windowed request.
- **Resolution cost is bounded and does not depend on the window.** The route never calls the cache app itself; `serve()` does, and only on a registry miss — `find()` returning an existing `ResumableMediaStream` for `(imdbId, archiveSize)` serves the request with no I/O. In practice that is 0 calls for every episode after the first, 1 call to warm a cold process, and 1 debounced call per 30 s while a stream is active. `HEAD` never calls it at all (D5). `start`/`end` are decoded from the path locally, so widening the window never triggers a lookup.
- The one call must be sent with `expand=false`: the cache app's expansion defaults on for an `imdbId`+`size` scope, and archive rows do have listings, so an unexpanded response would append derived episode rows for the same key — duplicate sources over one `playableLink`, and a synthetic `zip:` docId that `requestRefresh` could never resolve.

*Alternative rejected — a separate `ZipEntryStream` abstraction*: would duplicate buffer/read-ahead logic to solve a problem that is purely an offset translation.

### D3: Pure `resolveEntryRange()` helper

```ts
resolveEntryRange(fileSegment: string, rangeHeader, zipSize)
  → { ok: true,  start, end, relStart, relEnd, absStart, absEnd, entryLen, partial: boolean }
  | { ok: false, status: 400 | 416, error: string }
```

- Owns: parsing `f{start}-{end}` (rejecting anything not matching `^f(\d+)-(\d+)$` with 400), `start <= end`, `0 <= start`, `end < zipSize`, delegation to `parseRangeRequest` for the client's relative range, defaulting to the whole entry when no `Range` is present, and clamping the relative end to `entryLen - 1`.
- Taking the raw segment rather than two already-parsed integers keeps the whole path-parameter contract in one testable function, so `test/` covers parse failures and validation in the same table as the range arithmetic.
- Lives beside `parseRangeRequest` (either extended in `src/utils/utils.ts` or added as `src/utils/entryRange.ts`), keeping the route a thin adapter — the same split `linkQuery.ts` gave the cache app's routes, and the only way to test this logic under `node --test` without booting Fastify.

### D4: `Content-Type` stays `application/octet-stream`

The entry route sets `Content-Type: application/octet-stream` on both `GET` and `HEAD`, with no extension or `name` parameter anywhere in the URL.

- **There is nothing to derive from.** D1 deliberately carries only `start`/`end`, and the whole-zip route already returns `application/octet-stream` for real `.mkv` files (`server.ts:150`, `server.ts:177`) with playback working — so matching it is not a regression, it is consistency.
- Dropping `name` also removes a URL-encoding hazard: entry names routinely contain spaces, `&`, `#` and `+`.
- *Alternative rejected — an extension segment (`f{start}-{end}.mkv`)*: would allow a MIME map but adds an encode/decode round trip for a header players do not appear to need here.
- *Alternative rejected — `ct=` as a parameter*: passes the problem to the caller, and a caller-supplied arbitrary MIME type is a worse default than a fixed one.
- *Alternative rejected — inferring from magic bytes*: requires reading the body before answering, which defeats the streaming design.
- If a browser-resident player is ever found to need a real type, the fix is an extension segment on this same route; it does not reopen D1's path-only decision.

### D5: No `Range` header → `200` with the full entry

- The existing whole-zip route throws (`Only range request supported!`) when `Range` is absent. That is tolerable for an archive fetch, but the entry route is player-facing: browsers send `Range`, while `curl`, link checkers, and some players issue a plain `GET` first.
- Behaviour: no `Range` → `200`, `Content-Length: entryLen`, no `Content-Range`. With `Range` → `206` + `Content-Range: bytes relStart-relEnd/entryLen`.
- `HEAD` mirrors the same headers without opening a stream — matching how the existing `HEAD /stream/:imdbid/:size` already behaves (headers only, no `serve()` call).

### D6: Fix `parseRangeRequest`'s falsy-zero clamp

`Math.min(Number.parseInt(kis[1]), size - 1) || (size - 1)` returns `size - 1` whenever the parsed end is `0`, so `bytes=0-0` yields the entire file instead of one byte. For an entry window this means a client asking for byte 0 receives `entryLen` bytes and a mismatched `Content-Range`.

- Fix: clamp without the `||` fallback (`Number.isFinite(x) ? Math.min(x, size - 1) : size - 1`).
- Covered by a regression test; behaviour for every other input is unchanged, and the whole-zip route becomes *more* correct as a side effect.

### D7: Rejected alternative — a `window` on the link row

The other carrier for the same datum puts it in the data instead of the path: `GET /api/links?imdbId=&size=<episodeLength>` returns a derived row whose `playableLink` is the archive's upstream URL and whose `window: { start, end }` locates the episode inside it, and the streamer would serve `window.start + relStart` … `window.end + relEnd` while reporting totals of `window.end - window.start + 1`. **Not adopted** — D1 carries the window in the path instead.

- Both carriers would run through the *same* arithmetic as `resolveEntryRange`, differing only in where `entryStart` comes from; that is why this was one decision rather than two features, and why rejecting it here closes the question rather than leaving it open.
- **This alternative reaches the streaming core**, which is exactly why it was rejected. The cost it would have carried, recorded so it is not silently rediscovered:
  - `createResumableStream`'s `size !== potentialContentLength` would have to compare against `window.end - window.start + 1` instead of `:size`, because the upstream `Content-Range` total is the archive length.
  - Its `rangeValues.start != initialPosition` assertion would have to compare against `window.start + initialPosition`.
  - Read-ahead would have to be clamped to `window.end` (`_forceEndPosition` already exists for exactly this) or an episode would download the rest of the archive.
  - `ensureBufferCoverage` calls `requestRefresh(source.docId)` when a source fails, feeding `docId` straight into `api/links/{docId}/refresh`. A synthetic id (`zip:…:3`) is not a Mongo ObjectId, so that call could never succeed — it would be caught and logged, and a failed derived source would never recover. Suppression would have to be added.
  - `getLinks` would need a documented tie-break: with expansion on, a stored row and a derived row can share the same `size`, and `acquireStreams` would otherwise mix archive URLs with windowed ones for the same `(imdbId, size)`.
- Under D1 none of that happens: the streamer queries by archive size with `expand=false`, no derived row reaches a source, and no source it sees carries a window.

*Alternative rejected — deriving the window from `Range` alone*: the streamer would have no way to know where the episode ends, so read-ahead and `Content-Range` totals would be wrong.

## Risks / Trade-offs

- [**Large archives: every episode pulls on the same buffer** — a 40 GB season zip shared across episodes can accumulate buffer across playback] → Already governed by `MAX_BUFFER_SIZE_MB` + `AUTO_CLEAR_BUFFERS_INTERVAL` + idle-stream cleanup, and unchanged by this feature (the whole-zip route has the same exposure today). Shared buffering is a feature, not a regression: it is one buffer instead of N.
- [**Read-ahead is absolute-position based** — seeking to episode 8 read-ahead-fills from that absolute offset, not from the entry start] → Correct and desirable: it warms the bytes that are actually next, including the start of the following episode.
- [**Over-fetch past the entry** — `serve()` is given `absEnd`, but `ResumableStream`'s read-ahead limit is what actually stops it] → Harmless: the bytes lie inside the archive this stream already owns, and the next episode benefits. Bandwidth, not correctness.
- [**No verification that the window is actually `STORED`** — a caller could pass `DEFLATE` offsets and get garbage] → Accepted and documented: the streamer is a dumb window server by design; the cache app is the gatekeeper. Trusting the caller is what keeps zip knowledge out of this repo.
- [**`416`/`400` are new response codes for this route family** (existing handlers `throw`, which surfaces as `500`)] → The entry route returns proper codes; the whole-zip route's `throw` behaviour is deliberately left alone to avoid changing an existing contract.
- [**Route registration lives in `src/server.ts`, which also listens**, so HTTP-level tests would start a server] → Mitigation: the mapping logic is covered by pure unit tests; optionally extract `registerRoutes(app)` as a follow-up task so `app.inject()` becomes possible. Not required for this change.
- [**`application/octet-stream` may not suit every player** — some clients decide inline-play vs download from the header] → Accepted (D4): it is byte-for-byte what the whole-zip route already returns for the same files, and those play today. The URL carries no extension, so there is nothing to derive from without adding one back. Mitigation path documented in D4; not a blocker.
- [**A cache app without `expand` support ignores it** — an older deployment would still return derived rows if it had any] → Harmless in both directions: today's cache has no derived rows at all, so `expand` is a no-op; a future one honours it. The belt-and-braces `isDerived` filter in `getLinks` covers a version skew where expansion landed but the parameter was mis-wired.
- [**Derived episode rows leaking in as sources** — duplicate `streamUrl`s over one archive, and a synthetic `zip:` docId handed to `requestRefresh` which can never resolve to a Mongo id] → Guarded by two layers: `expand=false` on the query (so synthesis never runs) and an `isDerived` drop in `getLinks` (so a skew cannot pass them through). Verified by task 5.1–5.3.

## Migration Plan

Additive route, one additive query parameter on an existing call, and a bug fix in an existing helper. No configuration, no dependencies, no schema, no deploy ordering: the new route is inert until a caller emits it, and nothing in `MediaStreamRegistry` or `ResumableStream` changes beyond the `parseRangeRequest` fix. **This change ships the URL contract first**; the cache app's own change is written against it afterwards, so the streamer may be deployed alone and simply sit unused. Rollback = revert the commit; the whole-zip route is untouched, and removing `expand=false` from `getLinks` reverts to today's behaviour on its own.

## Open Questions

### 1. Should `resolveEntryRange` reject a window whose `entryLen` is absurdly large relative to the archive (e.g. a caller passing `f0-{zipSize-1}`, i.e. the whole file)? Today that is legal and indistinguishable from the existing route.

### 2. Should the response expose the window explicitly (e.g. `X-Zip-Entry-Start`/`-End` response headers) for debugging, or is `Content-Range`'s total already sufficient?

### 3. Is extracting `registerRoutes()` worth doing now to enable `app.inject()` route tests, or as a separate change?
