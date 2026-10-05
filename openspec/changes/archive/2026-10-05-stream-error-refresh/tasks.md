## 1. Implement retry loop in ensureBufferCoverage

- [x] 1.1 Modify `ensureBufferCoverage()` in `src/MediaStreamRegistry.ts` to iterate through `_streamSources` sorted by speed rank instead of picking only the fastest
- [x] 1.2 On stream creation failure: remove the failed source, call `requestRefresh(docId)` without awaiting, then `continue` to the next source
- [x] 1.3 On stream creation success: add stream to `_resumableStreams`, call `startStreaming()`, and `return` immediately
- [x] 1.4 After loop exhausts all sources: throw an error to fail the consumer immediately instead of waiting 30s for data that will never arrive

## 2. Verify edge cases

- [x] 2.1 Verify that when `_streamSources` is empty, the method returns immediately with error log (existing behavior)
- [x] 2.2 Verify that `requestRefresh()` is called for each failed source without blocking the retry loop
- [x] 2.3 Verify that successful stream from any source in the iteration stops the loop and returns

## 3. Test the change

- [x] 3.1 Test with a single source returning 403 — verify refresh is requested and consumer times out gracefully
- [x] 3.2 Test with multiple sources where first N fail and (N+1) succeeds — verify no 30s delay between attempts
- [x] 3.3 Test with all sources failing — verify all are tried, refresh requested for each, then consumer fails immediately (no 30s wait)
- [x] 3.4 Test happy path — verify single successful source works without regression
