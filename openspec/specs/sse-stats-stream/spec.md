## ADDED Requirements

### Requirement: SSE stats endpoint
The system SHALL provide a `GET /stats/stream` endpoint that streams stats updates to connected clients using Server-Sent Events.

#### Scenario: Client connects to SSE endpoint
- **WHEN** a client sends `GET /stats/stream`
- **THEN** the server responds with `Content-Type: text/event-stream` and keeps the connection open

#### Scenario: Server broadcasts stats every 500ms
- **WHEN** a client is connected to `/stats/stream`
- **THEN** the server SHALL send a `data` event containing the full JSON stats payload every 500ms

#### Scenario: Multiple clients connected
- **WHEN** multiple clients are connected to `/stats/stream`
- **THEN** the server SHALL broadcast the same stats payload to all connected clients

#### Scenario: Client disconnects
- **WHEN** a client disconnects from `/stats/stream`
- **THEN** the server SHALL stop sending events to that client and release associated resources

### Requirement: Backward compatible stats endpoint
The system SHALL continue to serve `GET /stats` as a JSON endpoint returning the current stats snapshot.

#### Scenario: Legacy client requests stats
- **WHEN** a client sends `GET /stats`
- **THEN** the server responds with the current `globalStreamRegistry.stats` as JSON

### Requirement: Testing mode with random data
The system SHALL support a testing mode that emits random stats values instead of real data.

#### Scenario: Testing mode enabled
- **WHEN** `NODE_ENV` is set to `test`
- **THEN** the SSE endpoint SHALL broadcast randomly generated stats values instead of reading from `globalStreamRegistry`

#### Scenario: Production mode
- **WHEN** `NODE_ENV` is not `test`
- **THEN** the SSE endpoint SHALL broadcast real stats from `globalStreamRegistry.stats`

### Requirement: Client uses EventSource
The frontend SHALL use the native `EventSource` API to receive SSE updates from `/stats/stream`.

#### Scenario: Dashboard loads with SSE
- **WHEN** the stats dashboard page loads
- **THEN** the client creates an `EventSource` connection to `/stats/stream` and updates the UI on each `message` event

#### Scenario: Dashboard unloads
- **WHEN** the stats dashboard page unloads
- **THEN** the client closes the `EventSource` connection

#### Scenario: SSE connection drops
- **WHEN** the SSE connection is lost
- **THEN** the `EventSource` API SHALL automatically attempt to reconnect
