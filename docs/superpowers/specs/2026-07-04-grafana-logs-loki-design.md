# Logs in Grafana via Loki — Design

Date: 2026-07-04
Status: Approved (Kaan)

## Problem

Errors users hit in the Electron app are invisible as logs. Current state:

- Desktop errors → Analytics Engine has counts + `error_code` only. The redacted
  stack (`error{stack,componentStack}` on `TelemetryEvent`) that the desktop
  already sends is **dropped** by sync-server since the PostHog removal
  (`toDataPoint` ignores it, nothing else consumes it).
- Server errors → full redacted message+stack exist only in Cloudflare Workers
  logs (`wrangler tail`), not queryable from Grafana.

Goal: any error a user sees in the desktop app is visible in Grafana as
dashboard + metrics (already exists via AE) **+ logs** (this design).

## Decision

Run Grafana Loki on the existing VPS (root@178.105.205.174) next to Grafana.
Sync-server pushes error log lines to Loki over HTTPS. Grafana reads Loki over
the docker network.

Rejected alternatives:
- **AE-only** (stack in a spare blob + table panel): no search/tail, ~5KB blob
  budget, server stacks still invisible.
- **Workers Logpush → Loki**: still needs Loki anyway, plus CF-side job config,
  batching delay, less label control.

## Architecture

```
Desktop app ──/telemetry/batch──▶ sync-server (CF Worker)
                                    │
                    ┌───────────────┼────────────────┐
                    ▼               ▼                ▼
              AE (metrics)    Loki push API    Workers logs
                    │        (Caddy + bearer)    (unchanged)
                    ▼               ▼
              Grafana ◀──── Loki datasource (http://loki:3100)
```

## Components

### 1. VPS infra (`/opt/grafana/docker-compose.yml`)

- New `loki` service: `grafana/loki:3`, single-binary mode, filesystem storage,
  named volume `loki-data`, `mem_limit: 384m`, port `127.0.0.1:3100:3100`,
  same compose network as Grafana.
- Retention: 30 days (compactor with `retention_enabled: true`).
- Caddy (`/etc/caddy/Caddyfile`): under the existing `grafana.memrynote.com`
  site, route `path /loki/api/v1/push` → `reverse_proxy 127.0.0.1:3100`,
  requiring `Authorization: Bearer <LOKI_TOKEN>`; 401 otherwise. No new DNS.
  Query endpoints are NOT exposed publicly — Grafana queries Loki via the
  docker network.

### 2. Sync-server (`apps/sync-server`)

- New `src/services/loki.ts`:
  - `pushLokiLine(env, { level, app, line })` — POST
    `{LOKI_URL}/loki/api/v1/push` with
    `{streams:[{stream:{app,env,level}, values:[[<ns-ts>, JSON.stringify(line)]]}]}`,
    `Authorization: Bearer ${LOKI_TOKEN}`.
  - No-op when `LOKI_URL`/`LOKI_TOKEN` unset (dev/tests). Never throws; failures
    log a warn. Callers fire it via `waitUntil`/`safeWaitUntil`.
  - Labels stay low-cardinality: `app` (`desktop`|`server`), `env`, `level`.
    Everything else goes inside the JSON line.
- Wire-in points (2):
  - `captureServerError` (`services/analytics.ts`): push the existing `detail`
    object (redacted message+stack) — level `error` for 5xx/unhandled, `warn`
    for handled 4xx.
  - Desktop telemetry ingest (`services/telemetry.ts` write path): for each
    event with `errorCode` or `error` detail, push
    `{name, error_code, source, action, app_version, platform, stack,
    component_stack, id_hash}` with `app=desktop`, level `error`.
- Bindings: `LOKI_URL` var + `LOKI_TOKEN` secret in `types.ts` +
  `wrangler.toml` (staging + production). Absent in dev by default.

### 3. Grafana

- Loki datasource → `http://loki:3100`.
- New dashboard `memry-logs` (`/d/memry-logs`): desktop error logs panel,
  server error logs panel, error volume by `error_code` timeseries derived
  from Loki. Existing AE dashboards untouched.
- Ad-hoc digging + live tail via Explore.

## Privacy

Unchanged model (see PR #665): desktop never sends error messages — stack
frames only, redacted client-side (`buildErrorDetail` + `redactSensitive`).
Server messages are operational-only (server is E2E-blind) and pass
`redactSensitive`. Loki receives nothing that AE/Workers-logs don't already
see.

## Error handling

- Loki push failures never affect request handling: fire-and-forget in
  `waitUntil`, catch-all → `logger.warn`.
- Loki down → logs lost for that window (no client buffering; AE metrics are
  the durable signal). Acceptable: logs are diagnostic, metrics are canonical.

## Testing / verification

1. Vitest (`loki.test.ts`): no-op without env; correct push payload/labels;
   never throws on fetch failure.
2. Existing analytics/telemetry suites stay green.
3. Manual: `curl` push through Caddy with token → 204; without token → 401.
4. Staging deploy → forced server error + desktop telemetry error event →
   both visible in Grafana Explore (`{app="server"}`, `{app="desktop"}`).

## Out of scope (follow-ups)

- Alert notification channels (Grafana SMTP/Telegram contact point not
  configured).
- Shipping non-error (info-level) logs.
- Cloudflare Logpush of full Workers logs.
