## 1. Dependencies

- [x] 1.1 Install `@fastify/sse` package

## 2. Backend SSE Endpoint

- [x] 2.1 Register `@fastify/sse` plugin in `src/server.ts`
- [x] 2.2 Create `GET /stats/stream` route with `{ sse: true }` option
- [x] 2.3 Implement client tracking (store connected SSE clients)
- [x] 2.4 Implement `setInterval` broadcast loop at 500ms that reads `globalStreamRegistry.stats` and sends to all clients via `reply.sse.send()`
- [x] 2.5 Add `reply.sse.onClose` handler to remove disconnected clients
- [x] 2.6 Add testing mode: when `NODE_ENV=test`, generate and broadcast random stats instead of real data

## 3. Frontend SSE Client

- [x] 3.1 Remove `setInterval` + `fetch('/stats')` polling from `public/js/app.js`
- [x] 3.2 Create `EventSource('/stats/stream')` on Vue component mount
- [x] 3.3 Add `message` event listener that parses JSON and assigns to `this.items`
- [x] 3.4 Close `EventSource` on Vue component unmount

## 4. Verification

- [x] 4.1 Start server and verify SSE endpoint responds with correct headers
- [x] 4.2 Verify stats dashboard receives updates every 500ms
- [x] 4.3 Verify `GET /stats` still works for backward compatibility
- [x] 4.4 Verify testing mode emits random data when `NODE_ENV=test`
