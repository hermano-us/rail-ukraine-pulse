# Live event backend

The dynamic layer keeps GitHub Pages as a safe static fallback while moving operational data to a Cloudflare Worker.

## Data flow

```text
public UZ collectors
  -> POST /api/v1/ingest
  -> immutable events + current run projection (D1)
  -> cached compatible snapshot (KV)
  -> GET /api/v1/snapshot
  -> browser refresh every 30 seconds
```

The collector sends the existing `live.json` contract. The backend expands every source update into immutable domain events and also keeps a current projection for backwards compatibility.

## API

- `GET /api/health` — database and source health;
- `GET /api/v1/snapshot` — current public passenger snapshot;
- `GET /api/v1/events?since=<ISO>&runId=<id>` — traceable event history;
- `POST /api/v1/ingest` — authenticated collector input.

All public responses are CORS-scoped and marked `no-store`. Ingestion requires a bearer token of at least 24 characters.

## Cloudflare resources

1. Copy `backend/wrangler.example.jsonc` to `backend/wrangler.jsonc`.
2. Create a D1 database and put its id in the configuration.
3. Create a KV namespace and put its id in the configuration.
4. Apply `backend/migrations/0001_initial.sql`.
5. Store `INGEST_TOKEN` as a Worker secret.
6. Deploy the Worker.
7. Add `RAIL_API_URL` and `RAIL_INGEST_TOKEN` as GitHub Actions secrets.
8. Put the Worker origin into `data/runtime-config.json`.

Until step 8, the browser continues to use `data/live.json`. If the live API later fails, the client automatically falls back to that published snapshot.

## Position model

`rail-posterior-v1` represents a train as a probability distribution over distance along its rail route. It exposes nested 50% and 90% corridors, confidence, error radius, source age and the last station confirmation. It never creates a position without route evidence, and freezes after 90 minutes without a new anchor.

The existing `rail-corridor-v5` remains as a conservative fallback for runs that have an arrival forecast but no station anchor. This preserves coverage during the migration without upgrading weak evidence to a confirmed position.

