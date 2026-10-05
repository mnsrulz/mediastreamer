## 1. Range translation helper

- [x] 1.1 Fix the falsy-zero clamp in `parseRangeRequest` (`src/utils/utils.ts`): replace `Math.min(end, size - 1) || (size - 1)` with a `Number.isFinite` guard so `bytes=0-0` yields `{ start: 0, end: 0 }`
- [x] 1.2 Add a regression test for `parseRangeRequest(1000, 'bytes=0-0') === { start: 0, end: 0 }` alongside the existing range tests in `test/app.test.ts`, and confirm `bytes=900-1050` still clamps to 999
- [x] 1.3 Add `resolveEntryRange(fileSegment: string, rangeHeader, zipSize)` (in `src/utils/utils.ts` or a new `src/utils/entryRange.ts`) returning `{ ok: true, start, end, relStart, relEnd, absStart, absEnd, entryLen, partial }` or `{ ok: false, status: 400 | 416, error }`
- [x] 1.4 In `resolveEntryRange`: parse `fileSegment` against `^f(\d+)-(\d+)$` and return 400 when it does not match; then validate `start <= end` (else 400), `end < zipSize` and `start < zipSize` (else 416), and compute `entryLen = end - start + 1`
- [x] 1.5 In `resolveEntryRange`: delegate the client's `Range` to `parseRangeRequest(entryLen, rangeHeader)`, default to `{ start: 0, end: entryLen - 1 }` when absent, clamp the relative end to `entryLen - 1`, and derive `absStart = start + relStart`, `absEnd = start + relEnd`, `partial = rangeHeader present`
- [x] 1.6 Unit-test `resolveEntryRange` in `test/`: in-window range, open-ended `bytes=N-`, suffix `bytes=-N`, clamped-past-end, no `Range` → whole entry, `bytes=0-0` → one byte, `end >= zipSize` → 416, `start > end` → 400, malformed or missing `f` segment → 400
- [x] 1.7 Run `npm run test:tsx` and make it pass

## 2. Route

- [x] 2.1 Add a `GET` handler for `/stream/:imdbid/:size/entry/:file` inside the existing `config.rootPath` prefix block in `src/server.ts`
- [x] 2.2 Validate `:size` starts with `z` and return HTTP 400 with an error body otherwise (do not `throw`), then decode `documentSize` as today
- [x] 2.3 Read the `:file` path parameter, call `resolveEntryRange`, and reply with its `status`/`error` on failure
- [x] 2.4 On success call `globalStreamRegistry.serve({ imdbId: imdbid.toLowerCase(), size: documentSize, start: absStart, end: absEnd, rawHttpMessage: request.raw })` — the same call the whole-zip route makes, with no entry-specific fields
- [x] 2.5 Set headers: `Accept-Ranges: bytes`; when `partial` → code 206 with `Content-Range: bytes ${relStart}-${relEnd}/${entryLen}` and `Content-Length: relEnd - relStart + 1`; otherwise code 200 with `Content-Length: entryLen` and no `Content-Range`
- [x] 2.6 Set `Content-Type: application/octet-stream` on both `GET` and `HEAD`, matching the whole-zip route — the path carries no extension, so there is nothing to derive a type from
- [x] 2.7 Log the request as `{imdbid} entry {start}-{end} Range {bytes} from {relStart}` so windowed requests are distinguishable in pino output
- [x] 2.8 Add a `HEAD` handler for the same path computing and returning identical status and headers without calling `serve()` (mirroring the existing `HEAD /stream/:imdbid/:size`)
- [x] 2.9 Confirm the size passed to `serve()` is the archive size decoded from `:size`, so `ResumableStream`'s existing `size !== potentialContentLength` and `rangeValues.start != initialPosition` checks pass unmodified

## 3. Docs and manual probes

- [x] 3.1 Add sample requests to `api.http`: a windowed `GET` with `Range`, the same with no `Range`, a `HEAD` probe, and a `416` case
- [x] 3.2 Document the route in `README.md` beside the existing sequence diagram, noting the `f{start}-{end}` path segment, that `start`/`end` are inclusive decimal offsets, `Range` is entry-relative, only `STORED` windows are expected, and no `Range` returns the whole entry

## 4. Verification

- [x] 4.1 Run `npm run lint` — no new errors
- [x] 4.2 Run `npm run test:tsx` — full suite green
- [x] 4.3 Run `npm run build:tsc` — compiles clean (no new type errors from the path-param typing)
- [x] 4.4 Manual smoke against a running server: `HEAD` a window, `GET` with `bytes=0-0` and confirm a single byte, `GET` with no `Range` and confirm `Content-Length: entryLen`, confirm `GET /stream/:imdbid/:size` still behaves as before
- [x] 4.5 Confirm no edit was made to `VirtualBufferCollection`

## 5. Archive-sized link resolution (design D2)

- [x] 5.1 In `getLinks` (`src/apiClient.ts`), send `expand=false` on the `GET {LINKS_API_URL}/api/links` query so archive-sized requests are never expanded
- [x] 5.2 In the same function, add `isDerived?: boolean` to `linksResponse.items` and discard any item whose `isDerived` is true before it can become a stream source
- [x] 5.3 Add a test asserting the built query carries `expand=false` and that an `isDerived` item is filtered out

## 6. Cross-repo confirmation (`/entry` is primary — design D1/D2)

- [x] 6.1 Confirm no change was made to `MediaStreamRegistry.ts` or `ResumableStream.ts` — blocks 1–5 are the whole streamer side of this change
- [x] 6.2 Record `{ROOT_PATH}stream/{imdbId}/z{archiveSizeBase32}/entry/f{start}-{end}` as the play URL contract **this change defines**, then verify it against `mediacatalogcache-netlify`'s `serve-individual-episodes-from-season-zips` once that change's design D8 and spec are written to match; also confirm the derived row's `playableLink` is never used as a stream source, so no request is ever nested inside another
- [x] 6.3 Confirm `specs/zip-entry-streaming/spec.md` contains no `Link sources with a byte window` requirement — no link source ever carries a window the streamer acts on
- [x] 6.4 Smoke: play an episode end to end and confirm there is exactly one `ResumableMediaStream` registered for that `imdbid`+archive size, serving both the archive row and its episodes
