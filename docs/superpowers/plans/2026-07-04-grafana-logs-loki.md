# Grafana Logs via Loki Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every error a user hits in the desktop app (and every sync-server error) becomes a searchable log line in Grafana, alongside the existing AE metrics.

**Architecture:** Loki runs as a container next to Grafana on the VPS (root@178.105.205.174). The sync-server (Cloudflare Worker) pushes error log lines to Loki's push API through Caddy (bearer-token guarded, path `/loki/api/v1/push` on the existing `grafana.memrynote.com` domain — no new DNS). Grafana queries Loki privately over the docker network. Desktop redacted stacks (currently dropped) and server error message+stack (currently `wrangler tail`-only) both become visible.

**Tech Stack:** grafana/loki:3 (single binary, filesystem storage, 30d retention), Caddy, Hono on Cloudflare Workers, vitest, Grafana HTTP API.

**Spec:** `docs/superpowers/specs/2026-07-04-grafana-logs-loki-design.md`

## Global Constraints

- Prettier: single quotes, no semicolons, 100 char width, no trailing commas.
- Logging: `createLogger('Scope')` from `../lib/logger`, never raw `console.*`.
- Loki push must NEVER affect request handling: no-op without env vars, never throws, failures are `logger.warn`.
- Privacy: desktop error lines contain stack frames only (never a message field from desktop events — `TelemetryErrorDetailSchema` has no message, keep it that way). Server lines reuse the already-redacted `detail` from `captureServerError`.
- Loki labels are ONLY `app`, `env`, `level` (low cardinality). Everything else goes inside the JSON log line.
- Git: no Co-Authored-By lines in commits.
- VPS access: `ssh root@178.105.205.174`. All repo commands from `/Users/h4yfans/workspace/memry`.
- After sync-server changes, before push: `pnpm docs:impact --base <base_commit> --strict` must pass (Task 6 handles docs).

---

### Task 1: Loki container on the VPS

**Files (on VPS via ssh, not in repo):**
- Create: `/opt/grafana/loki-config.yaml`
- Modify: `/opt/grafana/docker-compose.yml`

**Interfaces:**
- Produces: Loki reachable at `127.0.0.1:3100` on the host and `http://loki:3100` from the Grafana container. Push API `POST /loki/api/v1/push`, healthy `GET /ready`.

- [ ] **Step 1: Write the Loki config on the VPS**

```bash
ssh root@178.105.205.174 'cat > /opt/grafana/loki-config.yaml' <<'EOF'
auth_enabled: false

server:
  http_listen_port: 3100

common:
  path_prefix: /loki
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory
  storage:
    filesystem:
      chunks_directory: /loki/chunks
      rules_directory: /loki/rules

schema_config:
  configs:
    - from: "2024-01-01"
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

limits_config:
  retention_period: 720h

compactor:
  working_directory: /loki/compactor
  retention_enabled: true
  retention_delete_delay: 2h
  delete_request_store: filesystem
EOF
```

- [ ] **Step 2: Add the loki service to docker-compose.yml**

Current file is `/opt/grafana/docker-compose.yml` (services: grafana only, volume `grafana-data`). Append the `loki` service under `services:` and `loki-data` under `volumes:` so the full file becomes:

```yaml
services:
  grafana:
    image: grafana/grafana-oss:latest
    container_name: grafana
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"
    environment:
      - GF_INSTALL_PLUGINS=yesoreyeram-infinity-datasource
      - GF_SERVER_ROOT_URL=https://grafana.memrynote.com
      - GF_SERVER_DOMAIN=grafana.memrynote.com
      - GF_SECURITY_ADMIN_PASSWORD=${GF_SECURITY_ADMIN_PASSWORD}
      - GF_ANALYTICS_REPORTING_ENABLED=false
      - GF_ANALYTICS_CHECK_FOR_UPDATES=false
      - GF_USERS_ALLOW_SIGN_UP=false
    volumes:
      - grafana-data:/var/lib/grafana
    mem_limit: 512m

  loki:
    image: grafana/loki:3
    container_name: loki
    restart: unless-stopped
    ports:
      - "127.0.0.1:3100:3100"
    command: -config.file=/etc/loki/loki-config.yaml
    volumes:
      - ./loki-config.yaml:/etc/loki/loki-config.yaml:ro
      - loki-data:/loki
    mem_limit: 384m

volumes:
  grafana-data:
  loki-data:
```

Use `ssh root@178.105.205.174 'cat > /opt/grafana/docker-compose.yml' <<'EOF' ... EOF` with the exact content above.

- [ ] **Step 3: Start Loki and verify ready**

```bash
ssh root@178.105.205.174 'cd /opt/grafana && docker compose up -d && sleep 15 && curl -s http://127.0.0.1:3100/ready && docker ps --format "{{.Names}} {{.Status}}" | grep -E "loki|grafana"'
```

Expected: `ready` (may need one retry — Loki reports "Ingester not ready" for ~15s after boot), both containers `Up`. Grafana must still be `Up` (untouched restart is fine).

- [ ] **Step 4: Smoke-test a local push**

```bash
ssh root@178.105.205.174 'curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:3100/loki/api/v1/push -H "Content-Type: application/json" -d "{\"streams\":[{\"stream\":{\"app\":\"test\",\"env\":\"dev\",\"level\":\"error\"},\"values\":[[\"$(date +%s)000000000\",\"smoke test line\"]]}]}"'
```

Expected: `204`

---

### Task 2: Caddy push route with bearer token

**Files (on VPS):**
- Modify: `/etc/caddy/Caddyfile`
- Create: `/opt/grafana/loki-push-token` (token kept for Task 7)

**Interfaces:**
- Produces: `POST https://grafana.memrynote.com/loki/api/v1/push` with header `Authorization: Bearer <token>` → Loki (204). Wrong/missing token or any other `/loki/*` path → 401. The token value lives in `/opt/grafana/loki-push-token`.

- [ ] **Step 1: Generate the push token**

```bash
ssh root@178.105.205.174 'openssl rand -hex 32 | tee /opt/grafana/loki-push-token && chmod 600 /opt/grafana/loki-push-token'
```

Save the printed token — Task 7 sets it as the `LOKI_TOKEN` wrangler secret.

- [ ] **Step 2: Update the Caddyfile**

Replace the existing `grafana.memrynote.com` block (currently just the header + `reverse_proxy 127.0.0.1:3000`) with the block below, substituting `<TOKEN>` with the value from Step 1. Leave the `postiz.memrynote.com` block untouched.

```
grafana.memrynote.com {
	header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet"

	@lokipush {
		path /loki/api/v1/push
		header Authorization "Bearer <TOKEN>"
	}
	handle @lokipush {
		reverse_proxy 127.0.0.1:3100
	}
	handle /loki/* {
		respond 401
	}
	handle {
		reverse_proxy 127.0.0.1:3000
	}
}
```

- [ ] **Step 3: Validate and reload Caddy**

```bash
ssh root@178.105.205.174 'caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy && systemctl is-active caddy'
```

Expected: `Valid configuration` + `active`

- [ ] **Step 4: Verify auth gate from local machine**

```bash
TOKEN=$(ssh root@178.105.205.174 'cat /opt/grafana/loki-push-token')
# no token → 401
rtk curl -s -o /dev/null -w "%{http_code}\n" -X POST https://grafana.memrynote.com/loki/api/v1/push
# query endpoint → 401 even with token
rtk curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" "https://grafana.memrynote.com/loki/api/v1/query?query=%7Bapp%3D%22test%22%7D"
# valid push → 204
rtk curl -s -o /dev/null -w "%{http_code}\n" -X POST https://grafana.memrynote.com/loki/api/v1/push -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "{\"streams\":[{\"stream\":{\"app\":\"test\",\"env\":\"dev\",\"level\":\"error\"},\"values\":[[\"$(date +%s)000000000\",\"caddy auth smoke test\"]]}]}"
```

Expected: `401`, `401`, `204`. Grafana UI at https://grafana.memrynote.com must still load (200).

---

### Task 3: `services/loki.ts` push client (TDD)

**Files:**
- Create: `apps/sync-server/src/services/loki.ts`
- Test: `apps/sync-server/src/services/loki.test.ts`

**Interfaces:**
- Consumes: nothing new (uses `createLogger` from `../lib/logger`).
- Produces:
  - `interface LokiEnv { LOKI_URL?: string; LOKI_TOKEN?: string; ENVIRONMENT?: string }`
  - `interface LokiEntry { level: 'warn' | 'error'; app: 'desktop' | 'server'; line: Record<string, unknown> }`
  - `pushLokiEntries(env: LokiEnv, entries: LokiEntry[]): Promise<void>` — no-op without env vars or empty entries; never throws.
  - `desktopErrorEntry(batch: TelemetryBatch, event: TelemetryEvent, installHash: string): LokiEntry` — pure mapper used by the route in Task 4.

- [ ] **Step 1: Write the failing tests**

Create `apps/sync-server/src/services/loki.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TelemetryBatch, TelemetryEvent } from '@memry/contracts/telemetry-api'

import { desktopErrorEntry, pushLokiEntries } from './loki'

const env = {
  LOKI_URL: 'https://grafana.example.com',
  LOKI_TOKEN: 'tok',
  ENVIRONMENT: 'test'
}

const entry = {
  level: 'error' as const,
  app: 'server' as const,
  line: { error_code: 'BOOM', message: 'it broke' }
}

const batch: TelemetryBatch = {
  schemaVersion: 1,
  installId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  appVersion: '1.2.3',
  buildChannel: 'stable',
  platform: 'darwin',
  arch: 'arm64',
  locale: 'en-US',
  timezoneOffsetMinutes: 180,
  authState: 'signed_in',
  syncState: 'enabled',
  events: []
}

const event: TelemetryEvent = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'app_error_seen',
  occurredAt: '2026-07-04T00:00:00.000Z',
  surface: 'app',
  action: 'render',
  errorCode: 'RangeError',
  source: 'renderer',
  error: { stack: 'at doThing (app://bundle.js:1:2)', componentStack: 'at NoteEditor' }
}

describe('pushLokiEntries', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('no-ops when LOKI_URL or LOKI_TOKEN is unset', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await pushLokiEntries({ ENVIRONMENT: 'test' }, [entry])
    await pushLokiEntries({ ...env, LOKI_TOKEN: undefined }, [entry])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('no-ops on empty entries', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await pushLokiEntries(env, [])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('POSTs streams with app/env/level labels and JSON line', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    await pushLokiEntries(env, [entry])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://grafana.example.com/loki/api/v1/push')
    expect(init.headers.authorization).toBe('Bearer tok')
    const body = JSON.parse(init.body)
    expect(body.streams).toHaveLength(1)
    expect(body.streams[0].stream).toEqual({ app: 'server', env: 'test', level: 'error' })
    const [ts, line] = body.streams[0].values[0]
    expect(ts).toMatch(/^\d+$/)
    expect(JSON.parse(line)).toEqual({ error_code: 'BOOM', message: 'it broke' })
  })

  it('never throws on fetch rejection or non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    await expect(pushLokiEntries(env, [entry])).resolves.toBeUndefined()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })))
    await expect(pushLokiEntries(env, [entry])).resolves.toBeUndefined()
  })
})

describe('desktopErrorEntry', () => {
  it('maps batch + event to a desktop error line with stack, never a message', () => {
    const result = desktopErrorEntry(batch, event, 'hash123')
    expect(result.level).toBe('error')
    expect(result.app).toBe('desktop')
    expect(result.line).toEqual({
      name: 'app_error_seen',
      error_code: 'RangeError',
      surface: 'app',
      action: 'render',
      source: 'renderer',
      app_version: '1.2.3',
      build_channel: 'stable',
      platform: 'darwin',
      stack: 'at doThing (app://bundle.js:1:2)',
      component_stack: 'at NoteEditor',
      install_hash: 'hash123'
    })
    expect(Object.keys(result.line)).not.toContain('message')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @memry/sync-server test -- run src/services/loki.test.ts`
Expected: FAIL — cannot resolve `./loki`.

(If the filter name differs, use `pnpm test:sync-server -- run src/services/loki.test.ts` from repo root; check `apps/sync-server/package.json` `name` field.)

- [ ] **Step 3: Implement `apps/sync-server/src/services/loki.ts`**

```ts
import type { TelemetryBatch, TelemetryEvent } from '@memry/contracts/telemetry-api'

import { createLogger } from '../lib/logger'

// Error log lines → Loki on the Grafana VPS, pushed through Caddy with a
// bearer token. Fire-and-forget: absent config or a failed push must never
// affect request handling. Labels stay low-cardinality (app/env/level);
// everything else lives inside the JSON log line.

const logger = createLogger('Loki')

export interface LokiEnv {
  LOKI_URL?: string
  LOKI_TOKEN?: string
  ENVIRONMENT?: string
}

export interface LokiEntry {
  level: 'warn' | 'error'
  app: 'desktop' | 'server'
  line: Record<string, unknown>
}

export const pushLokiEntries = async (env: LokiEnv, entries: LokiEntry[]): Promise<void> => {
  if (!env.LOKI_URL || !env.LOKI_TOKEN || entries.length === 0) return
  try {
    const ts = `${Date.now()}000000`
    const streams = entries.map((entry) => ({
      stream: { app: entry.app, env: env.ENVIRONMENT ?? 'unknown', level: entry.level },
      values: [[ts, JSON.stringify(entry.line)]]
    }))
    const response = await fetch(`${env.LOKI_URL}/loki/api/v1/push`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.LOKI_TOKEN}`
      },
      body: JSON.stringify({ streams })
    })
    if (!response.ok) logger.warn('Loki push failed', { status: response.status })
  } catch (error) {
    logger.warn('Loki push failed', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

// Desktop events carry stack frames only (TelemetryErrorDetailSchema has no
// message field by design — messages can embed note content).
export const desktopErrorEntry = (
  batch: TelemetryBatch,
  event: TelemetryEvent,
  installHash: string
): LokiEntry => ({
  level: 'error',
  app: 'desktop',
  line: {
    name: event.name,
    error_code: event.errorCode ?? '',
    surface: event.surface,
    action: event.action,
    source: event.source ?? '',
    app_version: batch.appVersion,
    build_channel: batch.buildChannel,
    platform: batch.platform,
    stack: event.error?.stack ?? '',
    component_stack: event.error?.componentStack ?? '',
    install_hash: installHash
  }
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @memry/sync-server test -- run src/services/loki.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
rtk git add apps/sync-server/src/services/loki.ts apps/sync-server/src/services/loki.test.ts
rtk git commit -m "feat(sync-server): Loki push client for error logs"
```

---

### Task 4: Wire server + desktop errors into Loki

**Files:**
- Modify: `apps/sync-server/src/services/analytics.ts` (captureServerError, ~line 284-346)
- Modify: `apps/sync-server/src/routes/telemetry.ts` (`POST /batch` handler, ~line 20-37)
- Modify: `apps/sync-server/src/types.ts` (Bindings)
- Modify: `apps/sync-server/wrangler.toml` (`[env.staging.vars]`, `[env.production.vars]`)
- Test: extend `apps/sync-server/src/services/loki.test.ts`

**Interfaces:**
- Consumes: `pushLokiEntries`, `desktopErrorEntry` from `./loki` (Task 3); `hashTelemetryId` from `../services/telemetry`; `safeWaitUntil` from `../services/analytics`.
- Produces: `Bindings.LOKI_URL?: string`, `Bindings.LOKI_TOKEN?: string`. `AnalyticsEnv` gains the same two optional fields.

- [ ] **Step 1: Write the failing test (captureServerError → Loki)**

Append to `apps/sync-server/src/services/loki.test.ts`:

```ts
import { captureServerError } from './analytics'

describe('captureServerError → Loki', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('pushes the redacted server detail with app=server', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const analyticsEnv = {
      PRODUCT_TELEMETRY: { writeDataPoint: vi.fn() },
      TELEMETRY_HMAC_KEY: 'secret',
      ENVIRONMENT: 'test',
      LOKI_URL: 'https://grafana.example.com',
      LOKI_TOKEN: 'tok'
    }
    await captureServerError(analyticsEnv, {
      error: new Error('record decode failed'),
      method: 'POST',
      path: '/sync/items/push',
      source: 'sync',
      action: 'push_items',
      handled: false
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.streams[0].stream).toEqual({ app: 'server', env: 'test', level: 'error' })
    const line = JSON.parse(body.streams[0].values[0][1])
    expect(line.message).toBe('record decode failed')
    expect(line.error_code).toBe('UNHANDLED_ERROR')
    expect(line.source).toBe('sync')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/sync-server test -- run src/services/loki.test.ts`
Expected: FAIL — fetch not called (captureServerError doesn't push yet).

- [ ] **Step 3: Wire captureServerError**

In `apps/sync-server/src/services/analytics.ts`:

Add import at top:

```ts
import { pushLokiEntries } from './loki'
```

Extend `AnalyticsEnv`:

```ts
export interface AnalyticsEnv {
  PRODUCT_TELEMETRY: Bindings['PRODUCT_TELEMETRY']
  TELEMETRY_HMAC_KEY: Bindings['TELEMETRY_HMAC_KEY']
  ENVIRONMENT?: Bindings['ENVIRONMENT']
  LOKI_URL?: Bindings['LOKI_URL']
  LOKI_TOKEN?: Bindings['LOKI_TOKEN']
}
```

In `captureServerError`, immediately after the existing `logger.error`/`logger.warn` if/else block, add:

```ts
  await pushLokiEntries(env, [
    {
      level: status >= 500 || !input.handled ? 'error' : 'warn',
      app: 'server',
      line: detail
    }
  ])
```

Also update the file-top comment (lines 10-11) — server error message/stack now goes to Workers logs AND Loki.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/sync-server test -- run src/services/loki.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the telemetry batch route**

In `apps/sync-server/src/routes/telemetry.ts`, add imports:

```ts
import { safeWaitUntil } from '../services/analytics'
import { desktopErrorEntry, pushLokiEntries } from '../services/loki'
import { hashTelemetryId } from '../services/telemetry'
```

(merge with the existing `writeTelemetryBatch` import line for `../services/telemetry`).

In the `/batch` handler, after `const result = await writeTelemetryBatch(c.env, parsed.data)` and before `return`:

```ts
  const batch = parsed.data
  const errorEvents = batch.events.filter((event) => event.errorCode || event.error)
  if (errorEvents.length > 0) {
    safeWaitUntil(
      c,
      hashTelemetryId(c.env.TELEMETRY_HMAC_KEY, batch.installId).then((installHash) =>
        pushLokiEntries(
          c.env,
          errorEvents.map((event) => desktopErrorEntry(batch, event, installHash))
        )
      )
    )
  }
```

- [ ] **Step 6: Add bindings and vars**

`apps/sync-server/src/types.ts` — in `Bindings`, next to `TELEMETRY_HMAC_KEY`:

```ts
  LOKI_URL?: string
  LOKI_TOKEN?: string
```

`apps/sync-server/wrangler.toml` — add to BOTH `[env.staging.vars]` and `[env.production.vars]` (NOT the top-level dev `[vars]` — dev stays a no-op):

```toml
LOKI_URL = "https://grafana.memrynote.com"
```

(`LOKI_TOKEN` is a secret, set via wrangler in Task 7.)

- [ ] **Step 7: Full sync-server test suite + typecheck + lint**

Run: `pnpm test:sync-server` then `pnpm --filter @memry/sync-server typecheck` then `pnpm lint`
Expected: all green (~647+ tests; the 4 known `schema/d1.test.ts` parallel flakes may need a re-run — see memory, not caused by this change). If `typecheck` filter name differs, run `pnpm typecheck` at root.

- [ ] **Step 8: Commit**

```bash
rtk git add apps/sync-server/src/services/analytics.ts apps/sync-server/src/services/loki.test.ts apps/sync-server/src/routes/telemetry.ts apps/sync-server/src/types.ts apps/sync-server/wrangler.toml
rtk git commit -m "feat(sync-server): ship desktop + server error logs to Loki"
```

---

### Task 5: Grafana Loki datasource + memry-logs dashboard

**Files:** none in repo (Grafana API over ssh; admin creds in `/opt/grafana/.env` as `GF_SECURITY_ADMIN_PASSWORD`).

**Interfaces:**
- Consumes: Loki at `http://loki:3100` (Task 1).
- Produces: Grafana datasource named `Loki`, dashboard uid `memry-logs` at https://grafana.memrynote.com/d/memry-logs.

- [ ] **Step 1: Create the Loki datasource**

```bash
ssh root@178.105.205.174 'set -a; . /opt/grafana/.env; set +a; curl -s -u "admin:$GF_SECURITY_ADMIN_PASSWORD" -H "Content-Type: application/json" -X POST http://127.0.0.1:3000/api/datasources -d "{\"name\":\"Loki\",\"type\":\"loki\",\"access\":\"proxy\",\"url\":\"http://loki:3100\"}"'
```

Expected: JSON with `"id"` and `"uid"` — note the `uid` for Step 2. If 401: the admin password was changed in the UI — ask Kaan. If `"name already exists"`: GET `/api/datasources/name/Loki` for the uid instead.

- [ ] **Step 2: Create the dashboard**

Write the JSON locally then POST it. Replace `LOKI_UID` (3 occurrences per panel) with the uid from Step 1:

```bash
cat > /tmp/memry-logs-dashboard.json <<'EOF'
{
  "dashboard": {
    "uid": "memry-logs",
    "title": "Memry — Logs",
    "timezone": "browser",
    "time": { "from": "now-24h", "to": "now" },
    "refresh": "1m",
    "templating": {
      "list": [
        {
          "name": "env",
          "type": "custom",
          "query": "production,staging",
          "current": { "text": "production", "value": "production" },
          "options": [
            { "text": "production", "value": "production", "selected": true },
            { "text": "staging", "value": "staging", "selected": false }
          ]
        }
      ]
    },
    "panels": [
      {
        "id": 1,
        "type": "timeseries",
        "title": "Desktop errors by code",
        "gridPos": { "h": 8, "w": 12, "x": 0, "y": 0 },
        "datasource": { "type": "loki", "uid": "LOKI_UID" },
        "targets": [
          {
            "expr": "sum by (error_code) (count_over_time({app=\"desktop\", env=\"$env\"} | json [$__auto]))",
            "refId": "A"
          }
        ]
      },
      {
        "id": 2,
        "type": "timeseries",
        "title": "Server errors by level",
        "gridPos": { "h": 8, "w": 12, "x": 12, "y": 0 },
        "targets": [
          {
            "expr": "sum by (level) (count_over_time({app=\"server\", env=\"$env\"} [$__auto]))",
            "refId": "A"
          }
        ],
        "datasource": { "type": "loki", "uid": "LOKI_UID" }
      },
      {
        "id": 3,
        "type": "logs",
        "title": "Desktop error logs",
        "gridPos": { "h": 12, "w": 24, "x": 0, "y": 8 },
        "options": { "showTime": true, "wrapLogMessage": true, "sortOrder": "Descending" },
        "targets": [
          { "expr": "{app=\"desktop\", env=\"$env\"} | json", "refId": "A" }
        ],
        "datasource": { "type": "loki", "uid": "LOKI_UID" }
      },
      {
        "id": 4,
        "type": "logs",
        "title": "Server error logs",
        "gridPos": { "h": 12, "w": 24, "x": 0, "y": 20 },
        "options": { "showTime": true, "wrapLogMessage": true, "sortOrder": "Descending" },
        "targets": [
          { "expr": "{app=\"server\", env=\"$env\"} | json", "refId": "A" }
        ],
        "datasource": { "type": "loki", "uid": "LOKI_UID" }
      }
    ]
  },
  "overwrite": true
}
EOF
sed -i '' "s/LOKI_UID/<uid-from-step-1>/g" /tmp/memry-logs-dashboard.json
scp /tmp/memry-logs-dashboard.json root@178.105.205.174:/tmp/
ssh root@178.105.205.174 'set -a; . /opt/grafana/.env; set +a; curl -s -u "admin:$GF_SECURITY_ADMIN_PASSWORD" -H "Content-Type: application/json" -X POST http://127.0.0.1:3000/api/dashboards/db -d @/tmp/memry-logs-dashboard.json'
```

Expected: `{"status":"success","uid":"memry-logs",...}`

- [ ] **Step 3: Verify the datasource can query the smoke-test lines**

```bash
ssh root@178.105.205.174 'set -a; . /opt/grafana/.env; set +a; curl -s -u "admin:$GF_SECURITY_ADMIN_PASSWORD" "http://127.0.0.1:3000/api/datasources/proxy/uid/<uid-from-step-1>/loki/api/v1/query_range?query=%7Bapp%3D%22test%22%7D&limit=5" | head -c 500'
```

Expected: JSON containing `"smoke test line"` / `"caddy auth smoke test"` (from Tasks 1-2). If the proxy path 404s, use Grafana's `/api/ds/query` POST form instead (same pattern the AE dashboards used).

---

### Task 6: Docs + gates

**Files:**
- Modify: `apps/docs/src/architecture/observability.md`
- Modify (if impact demands more): whatever `pnpm docs:impact` lists

**Interfaces:** none.

- [ ] **Step 1: Update observability docs**

Read `apps/docs/src/architecture/observability.md` first. Add/adjust a "Logs (Loki)" section describing: sync-server pushes error log lines to Loki on the Grafana VPS through `https://grafana.memrynote.com/loki/api/v1/push` (bearer token `LOKI_TOKEN`, base URL `LOKI_URL`); desktop error events (`errorCode`/`error` detail) forwarded from `/telemetry/batch` with stack-frames-only privacy; server errors pushed from `captureServerError` with redacted message+stack; labels `app`/`env`/`level`; 30-day retention; dashboard `/d/memry-logs`; dev is a no-op (vars unset).

- [ ] **Step 2: Run docs gates**

```bash
base=$(rtk git merge-base origin/main HEAD)
pnpm docs:impact --base "$base" --strict
pnpm docs:build
```

Expected: both green. If `missing-docs` lists more files, update those docs pages too (real content only, under `apps/docs/src/**`).

- [ ] **Step 3: Commit**

```bash
rtk git add apps/docs/src
rtk git commit -m "docs(observability): document Loki error-log pipeline"
```

---

### Task 7: Secrets, deploy, end-to-end verify

**Files:** none (wrangler secrets + GitHub Actions + curl).

**Interfaces:**
- Consumes: token from `/opt/grafana/loki-push-token` (Task 2).

- [ ] **Step 1: Set the LOKI_TOKEN secret for staging and production**

```bash
cd apps/sync-server
TOKEN=$(ssh root@178.105.205.174 'cat /opt/grafana/loki-push-token')
printf '%s' "$TOKEN" | npx wrangler secret put LOKI_TOKEN --env staging
printf '%s' "$TOKEN" | npx wrangler secret put LOKI_TOKEN --env production
```

Expected: "Success! Uploaded secret LOKI_TOKEN" twice. If wrangler auth is missing, ask Kaan to run these two commands (paste them for him).

- [ ] **Step 2: Push to main → staging auto-deploys**

```bash
rtk git push origin main
gh run watch $(gh run list --workflow deploy-sync-server.yml --limit 1 --json databaseId --jq '.[0].databaseId')
```

Expected: staging deploy green. (Check the actual workflow filename with `gh workflow list` if that name 404s.)

- [ ] **Step 3: Force a desktop-shaped error through staging**

```bash
rtk curl -s -o /dev/null -w "%{http_code}\n" -X POST https://sync-staging.memrynote.com/telemetry/batch -H "Content-Type: application/json" -d '{
  "schemaVersion": 1,
  "installId": "44444444-4444-4444-8444-444444444444",
  "sessionId": "55555555-5555-4555-8555-555555555555",
  "appVersion": "0.0.0-loki-e2e",
  "buildChannel": "dev",
  "platform": "darwin",
  "arch": "arm64",
  "locale": "en-US",
  "timezoneOffsetMinutes": 180,
  "authState": "signed_out",
  "syncState": "disabled",
  "events": [{
    "id": "66666666-6666-4666-8666-666666666666",
    "name": "app_error_seen",
    "occurredAt": "2026-07-04T12:00:00.000Z",
    "surface": "app",
    "action": "loki_e2e",
    "errorCode": "E2E_TEST",
    "error": { "stack": "at lokiE2e (test.js:1:1)" }
  }]
}'
```

Expected: `202`. (If the schema rejects a field with 400, fix the payload against `TelemetryBatchSchema` — never loosen the schema.)

- [ ] **Step 4: Confirm the line landed in Loki**

```bash
ssh root@178.105.205.174 'curl -s -G http://127.0.0.1:3100/loki/api/v1/query_range --data-urlencode "query={app=\"desktop\", env=\"staging\"}" --data-urlencode "limit=5"' | rtk grep -o "E2E_TEST"
```

Expected: `E2E_TEST`. Also open https://grafana.memrynote.com/d/memry-logs (env=staging) and confirm the line renders in "Desktop error logs".

- [ ] **Step 5: Approve production deploy**

Approve the pending production deployment (GitHub Actions environment approval):

```bash
gh run list --workflow deploy-sync-server.yml --limit 3
# then approve via: gh api -X POST repos/{owner}/{repo}/actions/runs/<run-id>/pending_deployments -f "environment_ids[]=<env-id>" -f state=approved -f comment="loki logs"
```

(Exact env-id flow as used on 2026-07-04 for the telemetry deploy; if the api call shape fights back, approve in the Actions UI.)

- [ ] **Step 6: Production smoke**

Trigger any handled server error on prod (e.g. `rtk curl -s -o /dev/null -w "%{http_code}\n" https://sync.memrynote.com/telemetry/batch -X POST -H "Content-Type: application/json" -d '{}'` → 400 VALIDATION_ERROR is a handled 4xx and will NOT push; instead confirm passively) — production error lines will appear organically; verify with:

```bash
ssh root@178.105.205.174 'curl -s -G http://127.0.0.1:3100/loki/api/v1/query_range --data-urlencode "query={app=~\"desktop|server\", env=\"production\"}" --data-urlencode "limit=5"'
```

Expected within a day of real traffic: log lines present. Immediate positive check: repeat Step 3 against `https://sync.memrynote.com` with a fresh event id/install id → line appears with `env="production"`.

---

## Self-Review Notes

- Spec coverage: infra (T1-T2), shipper (T3), wire-in both paths + bindings (T4), Grafana (T5), docs (T6), verify/deploy (T7). Out-of-scope items (alerting contact points, info-level logs, Logpush) intentionally absent.
- Desktop privacy invariant is tested (T3 asserts no `message` key in desktop lines).
- `desktopErrorEntry` name/signature consistent across T3 (definition) and T4 (route usage). `pushLokiEntries(env, entries)` consistent everywhere.
- Loki `/ready` can lag ~15s post-boot (T1 Step 3 notes retry).
