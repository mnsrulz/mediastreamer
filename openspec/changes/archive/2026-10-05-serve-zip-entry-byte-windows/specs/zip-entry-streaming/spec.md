## ADDED Requirements

### Requirement: Entry range endpoint
The system SHALL provide `GET {ROOT_PATH}stream/:imdbid/:size/entry/:file`, where `:file` matches `f{start}-{end}` and describes an inclusive byte window of exact decimal offsets inside the archive identified by `:imdbid` and `:size`. `:size` SHALL retain its existing form (`z` followed by the base-32 encoding of the archive size). The request SHALL carry no query parameters and no file extension.

#### Scenario: Serve a window of the archive
- **WHEN** `GET /stream/tt123/z1mkv/entry/f1048576-2148485119` is requested with `Range: bytes=0-1023`
- **THEN** the response contains the first 1024 bytes of the window, served from absolute archive offsets 1048576–1049599

#### Scenario: Window is not a separate stream
- **WHEN** two different `start`/`end` windows of the same `imdbid` and `size` are requested
- **THEN** both are served through the same underlying stream object and byte buffer for that `imdbid`+`size`

#### Scenario: Archive identity is resolved from archive-sized rows only
- **WHEN** an entry window is requested for `:size` identifying the archive
- **THEN** the link sources used are the stored rows returned for that `imdbid` and archive size, so the size checked against the upstream `Content-Range` total is the archive length

### Requirement: HEAD support for entry windows
The system SHALL provide `HEAD {ROOT_PATH}stream/:imdbid/:size/entry/:file` returning the same status code and headers as the corresponding `GET` (status, `Content-Type`, `Accept-Ranges`, `Content-Length`, and `Content-Range` when a `Range` was supplied) without transferring a body and without opening an upstream stream.

#### Scenario: Player probes with HEAD
- **WHEN** `HEAD /stream/tt123/z1mkv/entry/f1048576-2148485119` is requested with `Range: bytes=0-0`
- **THEN** the response is HTTP 206 with `Content-Range: bytes 0-0/2147436544` and `Content-Length: 1`, and no upstream connection is opened

### Requirement: Entry-relative Range semantics
The system SHALL interpret the client's `Range` header relative to the entry, not the archive. When a `Range` is present and valid it SHALL respond `206` with `Content-Range: bytes relStart-relEnd/entryLength` where `entryLength = end - start + 1`, and `Content-Length: relEnd - relStart + 1`. It SHALL set `Accept-Ranges: bytes`. The absolute archive offsets requested from the stream SHALL be `start + relStart` through `start + relEnd`, both clamped to the entry window. Open-ended (`bytes=N-`) and suffix (`bytes=-N`) forms SHALL be supported and clamped to the entry length.

#### Scenario: Range inside the entry
- **WHEN** the entry window is `f1000-1999` (`entryLength` 1000) and the request has `Range: bytes=100-199`
- **THEN** the response is HTTP 206 with `Content-Range: bytes 100-199/1000`, `Content-Length: 100`, and the bytes at absolute archive offsets 1100–1199

#### Scenario: Open-ended range
- **WHEN** the window is `f1000-1999` and the request has `Range: bytes=500-`
- **THEN** the response is HTTP 206 with `Content-Range: bytes 500-999/1000`

#### Scenario: Suffix range
- **WHEN** the window is `f1000-1999` and the request has `Range: bytes=-100`
- **THEN** the response is HTTP 206 with `Content-Range: bytes 900-999/1000`

#### Scenario: Range end beyond the entry is clamped
- **WHEN** the window is `f1000-1999` and the request has `Range: bytes=900-5000`
- **THEN** the response is HTTP 206 with `Content-Range: bytes 900-999/1000`

#### Scenario: Single-byte range at the window start
- **WHEN** the window is `f1000-1999` and the request has `Range: bytes=0-0`
- **THEN** the response is HTTP 206 with `Content-Range: bytes 0-0/1000` and `Content-Length: 1` — not the whole entry

### Requirement: Whole-entry response without a Range header
When no `Range` header is present on `GET .../entry`, the system SHALL respond HTTP 200 with `Content-Length: entryLength`, `Accept-Ranges: bytes`, no `Content-Range` header, and the full entry body.

#### Scenario: Plain GET returns the whole entry
- **WHEN** `GET /stream/tt123/z1mkv/entry/f1000-1999` is requested with no `Range` header
- **THEN** the response is HTTP 200 with `Content-Length: 1000` and the complete entry body

### Requirement: Entry parameter validation
The system SHALL validate the `:file` segment and respond with HTTP 400 when it does not match `f` followed by two non-negative decimal integers separated by a single `-`, or when `start > end`. It SHALL respond HTTP 416 when `end` is greater than or equal to the archive size implied by `:size`, or when `start` is outside the archive. A `:size` that does not begin with `z` SHALL produce HTTP 400. A request to `.../entry` with no `:file` segment SHALL not match the route and SHALL answer HTTP 404. Validation failures SHALL not open an upstream stream.

#### Scenario: Malformed window segment
- **WHEN** `GET /stream/tt123/z1mkv/entry/fabc` is requested
- **THEN** the response is HTTP 400 with an error body

#### Scenario: No window segment
- **WHEN** `GET /stream/tt123/z1mkv/entry` is requested
- **THEN** the request does not match the entry route and the response is HTTP 404

#### Scenario: Inverted window
- **WHEN** `GET /stream/tt123/z1mkv/entry/f5000-1000` is requested
- **THEN** the response is HTTP 400

#### Scenario: Window beyond the archive
- **WHEN** `:size` implies an archive of 1000 bytes and `f0-1500` is requested
- **THEN** the response is HTTP 416

#### Scenario: Malformed size parameter
- **WHEN** `:size` does not start with `z`
- **THEN** the response is HTTP 400

### Requirement: Content type
The system SHALL set `Content-Type: application/octet-stream` on both `GET` and `HEAD` entry responses. The entry URL SHALL carry no file extension and no name parameter, so no MIME type is derived from the request.

#### Scenario: Entry response content type
- **WHEN** `GET /stream/tt123/z1mkv/entry/f1048576-2148485119` is requested with `Range: bytes=0-1023`
- **THEN** the response `Content-Type` is `application/octet-stream`, the same value the whole-archive route returns for this file

### Requirement: Reuse of the buffered streaming pipeline
Entry requests SHALL be served by the existing stream registry using the absolute archive offsets, so that read-ahead buffering, rewind, slow-stream compensation, link refresh, draining, and idle cleanup behave exactly as they do for whole-archive requests. The streamer SHALL NOT read archive structure or inspect compression methods.

#### Scenario: Sequential episodes reuse downloaded bytes
- **WHEN** a client plays one entry of an archive and then requests a later entry of the same archive
- **THEN** both are served by the single stream object registered for that `imdbid`+`size`, and bytes already buffered remain available

#### Scenario: One buffer for the archive and its episodes
- **WHEN** an entry request and a whole-archive request are made for the same `imdbid` and `size`
- **THEN** they resolve to the same registered stream object rather than to two competing objects over the same bytes

#### Scenario: Streaming core untouched
- **WHEN** an entry request is being served
- **THEN** `MediaStreamRegistry`, `ResumableStream`, and `VirtualBufferCollection` receive only absolute byte positions, with no entry- or zip-specific parameters, and no validation inside `ResumableStream` required modification to accept them

### Requirement: Whole-archive endpoint unchanged
`GET|HEAD {ROOT_PATH}stream/:imdbid/:size` SHALL continue to behave exactly as before this change, including its `Content-Type: application/octet-stream`, its requirement that `GET` carries a `Range` header, and its `Content-Range` total of the full archive size.

#### Scenario: Existing archive request
- **WHEN** `GET /stream/tt123/z1mkv` is requested with `Range: bytes=0-1023`
- **THEN** the response is HTTP 206 with `Content-Range: bytes 0-1023/<archive size>` and `Content-Type: application/octet-stream`

### Requirement: Correct range parsing for zero-length boundaries
`parseRangeRequest(size, 'bytes=0-0')` SHALL resolve to `{ start: 0, end: 0 }` rather than `{ start: 0, end: size - 1 }`. All other existing forms (`bytes=a-b`, `bytes=a-`, `bytes=-n`, clamping past the end) SHALL keep their current results.

#### Scenario: Zero-length range regression
- **WHEN** `parseRangeRequest(1000, 'bytes=0-0')` is called
- **THEN** it returns `{ start: 0, end: 0 }`

#### Scenario: Existing forms unchanged
- **WHEN** `parseRangeRequest(1000, 'bytes=900-1050')` is called
- **THEN** it returns `{ start: 900, end: 999 }`

### Requirement: Archive-sized link queries exclude derived rows
When resolving the upstream sources for an entry or whole-archive request, the streamer SHALL query `GET /api/links` with `imdbId`, the archive `size`, a `per_page` of 100 and `expand=false`, and SHALL discard any returned item whose `isDerived` is true. Derived episode rows SHALL never be used as a stream source, so a single stream object serves the archive and all of its episodes.

#### Scenario: Expansion is disabled on the query
- **WHEN** a registry miss for `imdbId` `tt123` and archive size 4294967296 triggers a link query
- **THEN** the outgoing query includes `imdbId=tt123`, `size=4294967296`, `per_page=100` and `expand=false`

#### Scenario: A derived row is never a source
- **WHEN** a link query response nonetheless contains an item whose `isDerived` is true
- **THEN** that item is discarded and no stream is opened from its `playableLink`

#### Scenario: One archive-sized request serves every episode
- **WHEN** an entry request for `f1048576-2148485119` and a whole-archive request share the same `imdbId` and archive size
- **THEN** both are served by the single `ResumableMediaStream` registered for that pair, because only stored archive rows ever became its sources
