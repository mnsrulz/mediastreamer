## Context

The `ensureBufferCoverage()` method in `MediaStreamRegistry.ts` is responsible for creating a new `ResumableStream` when the buffer doesn't have data at the requested position. It picks the fastest stream source from `_streamSources`, attempts to create a stream, and on failure removes the source and requests a refresh.

Currently, on failure (e.g., 403/404), the method returns immediately. The consumer loop in `requestRange()` then calls `waitForNewData(30000)` — a 30-second wait — before retrying. This means each failed source costs 30 seconds of dead time, even though the failure itself resolves in <1 second.

The `got` library already rejects non-2xx HTTP responses in stream mode, so no explicit status code check is needed. The only change is in the retry behavior within `ensureBufferCoverage()`.

## Goals / Non-Goals

**Goals:**
- Eliminate the 30-second delay between source attempts when sources fail with fast errors (403/404)
- Try all available stream sources in rapid succession before falling back to the consumer timeout
- Still request a refresh for each failed source (for future availability)

**Non-Goals:**
- Changing how `got` handles HTTP errors (already works correctly)
- Modifying `startStreaming()` or mid-stream error handling (already correct)
- Adding new retry configuration options (keep it simple)
- Changing the `performRefresh()` background refresh logic

## Decisions

### Decision: Iterate inside `ensureBufferCoverage()` instead of relying on consumer loop

**Choice:** Add a `for` loop inside `ensureBufferCoverage()` that iterates through `_streamSources` sorted by speed.

**Rationale:** The consumer loop's 30s `waitForNewData()` is designed for "no data yet" scenarios, not for fast-failing source errors. Moving the retry inside `ensureBufferCoverage()` lets us try the next source immediately (~250ms per attempt) instead of waiting 30s.

**Alternative considered:** Reduce `waitForNewData` timeout — rejected because it would cause excessive polling when data is legitimately slow to arrive.

### Decision: Fire-and-forget refresh on each failed source

**Choice:** Call `requestRefresh(source.docId)` without awaiting it for each failed source.

**Rationale:** The refresh is for future availability — we don't need to wait for it. Multiple calls for the same docId are idempotent (the API handles deduplication). This keeps the retry loop fast.

### Decision: Sort sources by speed rank for retry order

**Choice:** Use `_streamSources` sorted by `speedRank` (descending) for the iteration order.

**Rationale:** Consistent with existing behavior — `fastest()` already sorts this way. Faster sources are tried first, maximizing the chance of a quick success.

### Decision: Throw when all sources exhausted

**Choice:** After the retry loop fails all sources, throw an error from `ensureBufferCoverage()` instead of returning silently. However, when compensating a slow stream, do NOT throw — the existing slow stream continues serving data.

**Rationale:** If no stream is downloading, no data will ever arrive. The consumer's `waitForNewData(30000)` would wait 30 seconds for nothing. Throwing immediately fails the request with a clear error message. For slow stream compensation, we're just adding an additional stream — failure here is non-fatal.

**Also:** Moved `throwIfNoStreamUrlPresent()` from the consumer loop into `ensureBufferCoverage()` to consolidate the empty-sources check.

**Alternative considered:** Keep the 30s consumer timeout — rejected because it's wasted time with no possibility of recovery.

## Risks / Trade-offs

- **[Risk]** Rapid retries could flood a failing CDN with requests → **Mitigation**: Each attempt is a single HTTP request that fails in <1s. With typical source counts (3-5), this is negligible.
- **[Risk]** Multiple `requestRefresh()` calls for same docId → **Mitigation**: The upstream API is idempotent for refresh calls. Worst case: redundant work, no harm.
- **[Trade-off]** Slightly more complex `ensureBufferCoverage()` → Worth it for 30s+ latency improvement per failing source.
