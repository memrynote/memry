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
  uniq(index1) AS active_installs
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
  uniq(index1) AS reached
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
  uniq(index1) AS active_installs,
  CASE WHEN uniq(index1) > 0
       THEN 100.0 * SUM(_sample_interval * double7) / uniq(index1)
       ELSE 0
  END AS errors_per_100
FROM memry_product_telemetry_production
WHERE timestamp > NOW() - INTERVAL '14' DAY
GROUP BY t
ORDER BY t
```

## Anonymous vs Signed-In Split

```sql
SELECT
  blob9 AS auth_state,
  uniq(index1) AS installs
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
  blob15 AS result,
  SUM(_sample_interval * double1) AS occurrences
FROM memry_product_telemetry_production
WHERE timestamp > NOW() - INTERVAL '7' DAY
  AND blob1 IN ('sync_run_completed', 'sync_error')
GROUP BY event_name, result
ORDER BY event_name, result
```

## Surface Adoption (weekly)

```sql
SELECT
  intDiv(toUInt32(timestamp), 7 * 86400) * 7 * 86400 AS week,
  blob11 AS surface,
  uniq(index1) AS installs
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
- For unique counts, `uniq(index1)` is already sample-aware and does not need
  the `_sample_interval` multiplier.
- The Workers Analytics Engine table is append-only; do not rely on `UPDATE`/
  `DELETE`.
