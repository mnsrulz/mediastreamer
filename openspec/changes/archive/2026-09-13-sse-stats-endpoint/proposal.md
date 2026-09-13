## Why

The stats dashboard (`views/stats.htm`) polls `GET /stats` every 1 second using `fetch()` in `public/js/app.js`. This creates unnecessary network overhead—each client opens a new HTTP connection every second regardless of whether stats have changed. SSE (Server-Sent Events) is a better fit: the server pushes updates on a 500ms interval via a single persistent connection, reducing idle HTTP churn and providing more frequent updates.

## What Changes

- Add a new `GET /stats/stream` SSE endpoint using `@fastify/sse` that broadcasts stats every 500ms
- The existing `GET /stats` JSON endpoint remains for backward compatibility and initial load
- Client (`public/js/app.js`) switches from `setInterval` + `fetch` to `EventSource` for live updates
- Server tracks connected SSE clients and broadcasts stats to all of them on each interval
- Testing mode: when `NODE_ENV=test`, emit random stats values instead of real data from `globalStreamRegistry`

## Capabilities

### New Capabilities
- `sse-stats-stream`: Server-Sent Events endpoint that pushes real-time stream statistics to connected clients every 500ms, including connection lifecycle management and broadcast delivery

### Modified Capabilities
<!-- No existing specs in this repo -->

## Impact

- **Backend**: New SSE route in `src/server.ts` using `@fastify/sse`; broadcast interval pushes stats every 500ms
- **Frontend**: `public/js/app.js` replaces `setInterval` + `fetch` polling with `EventSource` listener
- **API**: New endpoint `GET /stats/stream` (SSE); existing `GET /stats` unchanged
- **Dependencies**: +1 new dependency (`@fastify/sse`)
- **Performance**: Single persistent connection per client replaces per-second HTTP requests; updates every 500ms instead of 1s
