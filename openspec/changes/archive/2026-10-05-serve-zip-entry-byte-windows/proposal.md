## Why

Season zips are single archives whose episodes only exist as byte windows inside the file, and the streaming proxy already serves that file with full Range + read-ahead support. Without an endpoint that maps a client Range onto a sub-window of the archive, no client can play an individual episode — the cache app has the offsets but the streamer can only hand back the whole zip.

## What Changes

- Add `GET` and `HEAD {ROOT_PATH}stream/{imdbId}/z{zipSize}/entry/f{start}-{end}` where `start` and `end` are exact decimal byte offsets, inclusive: the incoming `Range` is interpreted **relative to the entry** and translated to absolute offsets inside the zip before being served. The window travels as a path segment, so the URL carries no query string.
- Reuse the existing streaming machinery unchanged: the translated absolute range is passed to `globalStreamRegistry.serve()`, so the entry request lands in the same `ResumableMediaStream` / `VirtualBufferCollection` keyed by `imdbId`+`size` (the **archive** size). Consequence: the archive row and every episode of that archive share a single upstream connection pool and one byte cache instead of re-downloading, and because `_size` equals the archive length, `createResumableStream`'s existing `size !== potentialContentLength` and `rangeValues.start != initialPosition` checks pass with no modification.
- Response contract is entry-relative: `206`, `Content-Range: bytes a-b/(end-start+1)`, `Content-Length` of the served slice, `Accept-Ranges: bytes`, and `Content-Type: application/octet-stream` — the same type the whole-zip route already returns, since the URL carries no file extension to derive one from.
- A request with no `Range` header returns the whole entry as `200` (players probe this way). Validation failures return `400`, an out-of-bounds window returns `416`.
- Fix an existing range-parsing defect surfaced by byte-precise windows: `parseRangeRequest` uses `Math.min(end, size-1) || (size-1)`, so `bytes=0-0` resolves to `end = size-1` (the whole file) because `0` is falsy.
- **No zip knowledge enters the streamer**: it never reads a central directory and never inspects compression methods. It trusts the caller's `start`/`end`, which the cache app guarantees are `STORED` windows.
- **No link source ever describes a window.** The window lives only in the URL, so `MediaStreamRegistry`, `ResumableStream` and `VirtualBufferCollection` receive absolute archive positions and no entry-specific parameters.
- **Archive-sized link queries are un-expanded.** `getLinks` sends `expand=false` and drops any `isDerived` item, so the sources resolved for `:size` are stored archive rows only. Without this the cache app's default-on expansion would append derived episode rows for the same archive size, giving the streamer duplicate sources over one `playableLink` and a synthetic `docId` that no refresh can ever resolve.

## Capabilities

### New Capabilities
- `zip-entry-streaming`: Serving an entry-relative byte window of an already-supported archive file — path-segment parameter validation, Range translation semantics, response headers, and reuse of the existing buffered streaming pipeline.

### Modified Capabilities
<!-- none: the existing sse-stats-stream spec is untouched; /stream/{imdbid}/{size} keeps its current behaviour -->

## Impact

| Area | Change |
|---|---|
| `src/server.ts` | New `GET`/`HEAD /stream/:imdbid/:size/entry/:file` route inside the existing `config.rootPath` prefix block |
| `src/utils/utils.ts` (or new `src/utils/entryRange.ts`) | Pure `resolveEntryRange()` helper (parses the `f{start}-{end}` segment) + the `parseRangeRequest` zero-clamp fix |
| `src/apiClient.ts` | `getLinks` sends `expand=false` and drops any `isDerived` item; `linksResponse.items` gains an optional `isDerived` field |
| `test/*.test.ts` | Unit tests: `f{start}-{end}` parsing, window→absolute mapping, clamping, suffix/open/no-Range forms, `bytes=0-0` regression, invalid input |
| `api.http` | Sample entry requests for manual probing |
| `README.md` | Document the entry route alongside the existing sequence diagram |
| Dependencies | None added (no validation library; hand-rolled parsing is the house style) |
| Consumers | **This change defines the play URL contract**; the cache app emits it once its own change lands. No other caller changes |
| Out of scope | Zip parsing, compression/DEFLATE handling, per-entry stats, changes to `VirtualBufferCollection`, changes to the whole-zip route, and any change to `MediaStreamRegistry`/`ResumableStream` beyond the `parseRangeRequest` fix |
