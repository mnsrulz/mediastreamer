## ADDED Requirements

### Requirement: Retry through available stream sources on connection failure
When `ensureBufferCoverage()` fails to create a stream from a source (due to 403, 404, or other connection errors), the system SHALL immediately try the next available stream source sorted by speed rank, without waiting between attempts.

#### Scenario: First source returns 403, second source succeeds
- **WHEN** `ensureBufferCoverage()` attempts to create a stream from the fastest source and receives a 403 response
- **THEN** the system removes the failed source, requests a refresh in the background, and immediately attempts to create a stream from the next fastest source

#### Scenario: All sources return 403 (not compensating slow stream)
- **WHEN** `ensureBufferCoverage()` tries all available stream sources and every one fails with 403 or 404, and the request is NOT compensating a slow stream
- **THEN** the system requests a refresh for each failed source and throws an error to fail the consumer immediately, instead of waiting 30s for data that will never arrive

#### Scenario: All sources return 403 (compensating slow stream)
- **WHEN** `ensureBufferCoverage()` tries all available stream sources and every one fails, and the request IS compensating a slow stream
- **THEN** the system requests a refresh for each failed source and returns silently (the existing slow stream continues serving data)

#### Scenario: No sources available
- **WHEN** `ensureBufferCoverage()` is called and `_streamSources` is empty
- **THEN** the system throws an error via `throwIfNoStreamUrlPresent()` to fail the consumer immediately

### Request refresh for each failed source
When a stream source fails during `ensureBufferCoverage()`, the system SHALL call `requestRefresh(source.docId)` for that source without awaiting the result.

#### Scenario: Refresh requested on failure
- **WHEN** a stream source fails with 403 during `ensureBufferCoverage()`
- **THEN** the system calls `requestRefresh()` for that source's docId and continues to the next source without waiting for the refresh to complete
