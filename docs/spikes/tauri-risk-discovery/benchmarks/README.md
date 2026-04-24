# Spike 0 Benchmark Data

Raw measurement outputs from Spike 0. Not human-authored — produced by
`../scripts/bench-*.ts` runners.

## Files

- `environment.json` — hardware/OS/tooling snapshot at spike start
- `s1-feature-matrix.csv` — S1 per-test pass/fail grid (macOS + Windows)
- `s2-roundtrip-latency.json` — S2 Prototype A vs B timing
- `s3-query-latency.json` — S3 3-option DB query benchmarks
- `screenshots/` — S1 manual test evidence (IME, HTML paste, resize)

## Schema

All JSON files use `schema_version: 1`:

```json
{
  "schema_version": 1,
  "spike": "sN-name",
  "benchmark": "benchmark-name",
  "timestamp": "ISO 8601",
  "environment": { /* see environment.json */ },
  "runs": [ /* per-test data */ ],
  "notes": "free text"
}
```

Schema changes produce a new version; old files remain readable.
