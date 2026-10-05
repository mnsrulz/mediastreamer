# MediaStreamer

A simple Node.js API capable of streaming content from URLs in an effective manner using in-memory cache to make it rewindable streams.

# Features
- Streams content from URLs with efficient caching for rewindable streams
- Supports range requests for partial content streaming
- Uses in-memory cache for fast access to cached content
- Configurable environment variables for customization
- Docker support for easy deployment

## Environment vars
Server supports the env file to load env vars. Simply create an .env file in the root directory. Following options are available
```
PORT=3000
NODE_TLS_REJECT_UNAUTHORIZED=0
MAX_BUFFER_SIZE_MB=200
MAX_CHUNK_SIZE_MB=8
READ_AHEAD_SIZE_MB=8
LINKS_REFRESH_INTERVAL_MS=30000
LINKS_API_URL=http://admin:admin@localhost:8000
ROOT_PATH=/
AUTO_CLEAR_BUFFERS_INTERVAL_MS=10000
AUTO_CLEAR_IDLE_STREAMS_INTERVAL_MS=10000
IDLE_STREAM_TIMEOUT_MS=3600000
```

# Sequence diagram

```mermaid
sequenceDiagram
    Client->>API: GET /stream/tt10991/S18mmki RANGE: bytes=0-4096
    break creates a new stream
        API->>LINKS_API: GET /api/links?imdbId=tt10991&size=42687122
        LINKS_API-->>API: JSON
        API->>ThirdPartyStream: GET /file RANGE: bytes=0-
        ThirdPartyStream-->>API: binary stream
    end
    API-->>Client: RETURN buffer content
    Client->>API: GET /stream/tt10991/S18mmki RANGE: bytes=1024-2048
    break stream is arleady in cache and requested bytes fully present in the cache
        API-->API: 
    end
    API-->>Client: RETURN buffer content
    Client->>API: GET /stream/tt10991/S18mmki RANGE: bytes=2160-8096
    break stream is partly present in the cache
        API-->API: read the partly bytes present from cache
        API->>ThirdPartyStream: advances the stream to read next set of bytes
        ThirdPartyStream-->>API: binary stream
    end
    API-->>Client: RETURN buffer content
```

# Serving a zip entry (byte window)

A season zip is served as one archive; its episodes are byte windows inside it. The window is carried as a path segment on a nested route:

```
GET|HEAD {ROOT_PATH}stream/{imdbId}/z{archiveSizeBase32}/entry/f{start}-{end}
```

- `f{start}-{end}` are inclusive decimal byte offsets **inside the archive** (`f1048576-2148485119`), no extension, no query string.
- The client's `Range` header is **entry-relative**: it is translated to absolute archive offsets before fetching, and the response reports `Content-Range: bytes relStart-relEnd/(end-start+1)` with the entry length as the total.
- Only `STORED` (uncompressed) windows are expected — the caller guarantees the offsets; the streamer never inspects zip structure or compression methods.
- No `Range` header returns the whole entry as `200` (`Content-Length: entryLen`, no `Content-Range`). With `Range` the response is `206`.
- Invalid `f{start}-{end}` or a `start > end` window answers `400`; a window outside the archive answers `416`.
- `Content-Type` is `application/octet-stream` (the URL carries no extension), matching the whole-archive route.
- Entry and whole-archive requests for the same `imdbid` + archive size share one registered stream and one byte cache.

# Tests
```
npm run test:tsx
```

# Docker
```
docker pull ghcr.io/mnsrulz/mediastreamer:latest
```