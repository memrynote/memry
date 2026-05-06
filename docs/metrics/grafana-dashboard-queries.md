# Grafana Dashboard Queries

Sampled-safe SQL recipes for Workers Analytics Engine via the Altinity ClickHouse
datasource. Always multiply the count or sum metric by `_sample_interval`,
otherwise dashboards will undercount as soon as Cloudflare starts sampling.

> **Reminder:** Workers Analytics Engine retains data for ~3 months. Build
> rollups for anything that needs longer retention.

## Datasets

- Production: `memry_product_telemetry_production`
- Staging: `memry_product_telemetry_staging`
- Development: `memry_product_telemetry_dev`

Replace the table name in each example with the appropriate dataset.

## Daily Active Installs

```sql
SELECT
  intDiv(toUInt32(timestamp), 86400) * 86400 AS t,
  count(DISTINCT index1) AS active_installs
FROM memry_product_telemetry_production
WHERE timestamp > NOW() - INTERVAL '30' DAY
  AND blob1 IN ('app_started', 'app_active_heartbeat', 'page_viewed')
GROUP BY t
ORDER BY t
```

## Events Per Day (sampled-safe count)

```sql
SELECT
  intDiv(toUInt32(timestamp), 86400) * 86400 AS t,
  SUM(_sample_interval * double1) AS events
FROM memry_product_telemetry_production
WHERE timestamp > NOW() - INTERVAL '30' DAY
GROUP BY t
ORDER BY t
```

## Activation Funnel

```sql
SELECT
  blob1 AS event_name,
  count(DISTINCT index1) AS reached
FROM memry_product_telemetry_production
WHERE timestamp > NOW() - INTERVAL '30' DAY
  AND blob1 IN (
    'app_started',
    'onboarding_started',
    'onboarding_completed',
    'vault_opened',
    'note_created'
  )
GROUP BY event_name
```

## Median Duration (sampled-safe weighted average)

For event types that emit `metrics.durationMs` (sync runs, search queries):

```sql
SELECT
  intDiv(toUInt32(timestamp), 86400) * 86400 AS t,
  SUM(_sample_interval * double2) / SUM(_sample_interval) AS avg_duration_ms
FROM memry_product_telemetry_production
WHERE timestamp > NOW() - INTERVAL '7' DAY
  AND blob1 = 'sync_run_completed'
GROUP BY t
ORDER BY t
```

## Error Rate per 100 Active Installs

```sql
SELECT
  intDiv(toUInt32(timestamp), 86400) * 86400 AS t,
  SUM(_sample_interval * double7) AS errors,
  count(DISTINCT index1) AS active_installs,
  100.0 * SUM(_sample_interval * double7) / count(DISTINCT index1) AS errors_per_100
FROM memry_product_telemetry_production
WHERE timestamp > NOW() - INTERVAL '14' DAY
  AND index1 != ''
GROUP BY t
ORDER BY t
```

## Anonymous vs Signed-In Split

```sql
SELECT
  blob9 AS auth_state,
  count(DISTINCT index1) AS installs
FROM memry_product_telemetry_production
WHERE timestamp > NOW() - INTERVAL '30' DAY
  AND blob1 = 'app_started'
GROUP BY auth_state
```

## Capture Type Distribution

```sql
SELECT
  blob17 AS dimension_key,
  blob18 AS dimension_value,
  SUM(_sample_interval * double1) AS captures
FROM memry_product_telemetry_production
WHERE timestamp > NOW() - INTERVAL '30' DAY
  AND blob1 = 'inbox_captured'
GROUP BY dimension_key, dimension_value
ORDER BY captures DESC
```

## Sync Success Rate

```sql
SELECT
  blob1 AS event_name,
  blob14 AS operation,
  blob18 AS transport,
  blob15 AS result,
  SUM(_sample_interval * double1) AS occurrences
FROM memry_product_telemetry_production
WHERE timestamp > NOW() - INTERVAL '7' DAY
  AND blob1 IN ('sync_enabled', 'sync_run_completed', 'sync_error')
GROUP BY event_name, operation, transport, result
ORDER BY occurrences DESC
```

## Sync Runs Over Time

```sql
SELECT
  intDiv(toUInt32(timestamp), 300) * 300 AS t,
  blob14 AS operation,
  SUM(_sample_interval * double1) AS sync_runs
FROM memry_product_telemetry_production
WHERE timestamp > NOW() - INTERVAL '7' DAY
  AND blob1 = 'sync_run_completed'
GROUP BY t, operation
ORDER BY t
```

## Sync Errors Over Time

```sql
SELECT
  intDiv(toUInt32(timestamp), 300) * 300 AS t,
  blob14 AS operation,
  blob16 AS error_code,
  SUM(_sample_interval * double1) AS sync_errors
FROM memry_product_telemetry_production
WHERE timestamp > NOW() - INTERVAL '7' DAY
  AND blob1 = 'sync_error'
GROUP BY t, operation, error_code
ORDER BY t
```

## Sync Duration by Operation

```sql
SELECT
  blob14 AS operation,
  blob18 AS transport,
  SUM(_sample_interval * double2) / SUM(_sample_interval) AS avg_duration_ms,
  SUM(_sample_interval * double1) AS runs
FROM memry_product_telemetry_production
WHERE timestamp > NOW() - INTERVAL '7' DAY
  AND blob1 = 'sync_run_completed'
  AND double2 > 0
GROUP BY operation, transport
ORDER BY avg_duration_ms DESC
```

## Sync Queue and Items

```sql
SELECT
  blob14 AS operation,
  blob18 AS transport,
  SUM(_sample_interval * double5) AS queue_count,
  SUM(_sample_interval * double3) AS item_count,
  SUM(_sample_interval * double1) AS runs
FROM memry_product_telemetry_production
WHERE timestamp > NOW() - INTERVAL '7' DAY
  AND blob1 = 'sync_run_completed'
GROUP BY operation, transport
ORDER BY runs DESC
```

## Surface Adoption (weekly)

```sql
SELECT
  intDiv(toUInt32(timestamp), 7 * 86400) * 7 * 86400 AS week,
  blob11 AS surface,
  count(DISTINCT index1) AS installs
FROM memry_product_telemetry_production
WHERE timestamp > NOW() - INTERVAL '90' DAY
  AND blob1 = 'page_viewed'
GROUP BY week, surface
ORDER BY week, surface
```

## Sampling Notes

- Always multiply counts by `_sample_interval` — never use raw `count()` or
  `count(*)`.
- For averages, weight numerator and denominator: `SUM(_sample_interval * X) /
  SUM(_sample_interval)`.
- For unique counts, `count(DISTINCT index1)` is already sample-aware and does not need
  the `_sample_interval` multiplier.
- The Workers Analytics Engine table is append-only; do not rely on `UPDATE`/
  `DELETE`.
