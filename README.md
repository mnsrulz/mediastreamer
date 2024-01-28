# mediastreamer

A simple nodejs api capable of streaming content from url(s) in effective manner using in memory cache to make it rewindable streams.

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