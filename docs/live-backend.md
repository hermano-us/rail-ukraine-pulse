# Live backend

```text
public UZ collectors
  -> normalized immutable events
  -> authenticated ingest with retries
  -> D1 event ledger + KV snapshot
  -> GET /api/v1/snapshot
  -> GET /api/v1/stream
  -> map refresh on stream signal
  -> 60-second polling fallback
```

The stream is a lightweight SSE version signal. It reconnects every 10 seconds and asks the browser to load a new snapshot only when `generatedAt` changes. It does not claim GPS telemetry and cannot make an upstream source update faster.

Freshness thresholds:

- up to 20 minutes: `ok`;
- 20–60 minutes: `degraded`;
- over 60 minutes or no snapshot: `unavailable`.

The collector retries failed cycles three times. The persistent Docker collector exposes `/health` and `/ready`; GitHub Actions opens one deduplicated incident issue when the scheduled collector fails and closes it after recovery.
