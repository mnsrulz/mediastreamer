## Context

The mediastreamer stats dashboard (`views/stats.htm`) currently polls `GET /stats` every 1 second using `fetch()` in `public/js/app.js`. The backend (`src/server.ts:36-39`) returns `globalStreamRegistry.stats` as a JSON object on each request. The stats are computed lazily via getters on `MediaStreamRegistry` and `ResumableStream`.

This polling approach opens a new HTTP connection every second per client, regardless of whether data has changed. For a local development tool with typically one user, this is acceptable overhead—but it can be improved with a single persistent connection that pushes updates.

The codebase uses Fastify 5.x with ESM (`"type": "module"`), TypeScript targeting ES2022, and no bundler for the frontend (Vue 3 loaded from CDN).

## Goals / Non-Goals

**Goals:**
- Replace client-side polling with SSE for real-time stats delivery
- Broadcast stats every 500ms from the server to all connected clients
- Maintain backward compatibility with existing `GET /stats` endpoint
- Add testing mode that emits random stats values for development
- Keep the change isolated to two files (`src/server.ts`, `public/js/app.js`)

**Non-Goals:**
- Delta/diff-based updates (send full payload every time)
- Multiple concurrent client optimization (single-user dev tool)
- Modifying `MediaStreamRegistry` or `ResumableStream` classes
- WebSocket support
- Message replay or reconnection state recovery

## Decisions

### Use `@fastify/sse` instead of raw SSE handling
**Choice:** `@fastify/sse` plugin  
**Alternatives considered:**
- Raw SSE with manual `res.writeHead()` + `res.write()`: Requires storing raw `ServerResponse` references, manually setting headers, and handling cleanup. More code, more error-prone.
- `fastify-sse-v2`: Older, less maintained. `@fastify/sse` is the official Fastify org package.

**Rationale:** `@fastify/sse` provides `reply.sse.send()` API, built-in header management, `onClose` lifecycle hooks, and heartbeat support. Eliminates manual response reference storage and header boilerplate.

### Broadcast interval: 500ms fixed
**Choice:** `setInterval` at 500ms  
**Alternatives considered:**
- Event-driven (emit on stats change): Would require modifying `MediaStreamRegistry`/`ResumableStream` to emit events at mutation points. Invasive.
- Configurable interval via env var: Adds complexity for a dev tool.

**Rationale:** 500ms is frequent enough for real-time feel without excessive CPU usage. Fixed interval keeps implementation simple. The full stats payload is small (JSON object with ~15 fields per stream).

### Testing mode via `NODE_ENV=test`
**Choice:** Check `process.env.NODE_ENV` at broadcast time  
**Alternatives considered:**
- Separate env var `SSE_TEST_MODE=true`: More explicit but adds config surface.
- Always emit random in test, real in production: Same as `NODE_ENV` approach.

**Rationale:** `NODE_ENV` is a standard convention. When set, the broadcast loop generates random stats instead of reading from `globalStreamRegistry`. Useful for testing the SSE pipeline without active streams.

### Client: `EventSource` with auto-reconnect
**Choice:** Native browser `EventSource` API  
**Alternatives considered:**
- `EventSource` polyfill: Not needed—native support is universal in modern browsers.
- WebSocket: Overkill for one-way server-to-client push.

**Rationale:** `EventSource` is purpose-built for SSE, handles reconnection automatically, and requires zero dependencies on the frontend.

## Risks / Trade-offs

- **[Risk] Memory leak if clients disconnect without triggering `onClose`** → Mitigation: `@fastify/sse` handles lifecycle; additionally, check `res.writableEnded` before writing.
- **[Risk] Broadcast interval wastes CPU when no clients connected** → Mitigation: Guard interval callback with client set length check; skip work if empty.
- **[Trade-off] Full payload every 500ms vs delta updates** → Accepted: Stats object is small, and simplicity outweighs bandwidth savings for a local dev tool.
- **[Trade-off] Fixed 500ms vs configurable interval** → Accepted: Config adds complexity; 500ms is reasonable default.
