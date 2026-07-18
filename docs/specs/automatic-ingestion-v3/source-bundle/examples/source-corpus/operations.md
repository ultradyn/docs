# Operations

## Retry policy

A failed delivery is retried with exponential backoff for up to eight attempts.

HTTP 400, 401, 403, and 404 responses are treated as permanent failures and are not retried. HTTP 408, 429, and 5xx responses are retryable.

After the final failed attempt, the event is moved to the dead-letter store for operator review.
