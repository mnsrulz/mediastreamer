## Why

When a stream source returns 403/404 during initial connection, `ensureBufferCoverage()` only tries the fastest source, fails, and returns immediately. The consumer loop then waits 30 seconds (`waitForNewData(30000)`) before trying the next source. With multiple failing sources, this compounds — 3 sources × 30s = 90 seconds of dead time before giving up, even though the403 rejection happens in <1 second.

## What Changes

- Add a retry loop inside `ensureBufferCoverage()` that iterates through available stream sources in speed order, trying each one immediately on failure instead of returning to the consumer loop
- On403/404 failure: remove the failed source, request a refresh (fire-and-forget), and immediately try the next source
- If all sources are exhausted, return and let the consumer timeout as a last resort
- Eliminates the 30-second gap between source attempts for fast-failing errors like403/404

## Capabilities

### New Capabilities
- `stream-source-retry`: Retry through available stream sources on connection failure (403/404/etc) without waiting between attempts

### Modified Capabilities

## Impact

- `src/MediaStreamRegistry.ts`: `ensureBufferCoverage()` method — replace single-attempt logic with a retry loop
- No changes to `ResumableStream.ts`, `apiClient.ts`, or other files — `got` already handles 403 rejection correctly
- No API or dependency changes
