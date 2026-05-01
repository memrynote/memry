# Application Metrics Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add comprehensive privacy-preserving product telemetry for anonymous and signed-in Memry desktop users, ingested through Cloudflare Workers Analytics Engine and queryable from Grafana.

**Architecture:** Define a shared telemetry contract in `packages/contracts`, add a public `/telemetry/batch` route to `apps/sync-server` that validates and writes events to Workers Analytics Engine, add a non-blocking Electron main-process telemetry queue, expose a small renderer IPC API, and instrument app lifecycle plus core product surfaces. Raw events never go to D1; D1 is used only for existing-style rate limiting and optional future rollups.

**Tech Stack:** Electron 39, React 19, TypeScript, Hono, Cloudflare Workers, Workers Analytics Engine, Zod, Vitest, Grafana with Analytics Engine SQL API.

**Spec:** `docs/superpowers/specs/2026-05-01-application-metrics-design.md`

---

## File Structure

**Contracts and RPC**

- Create: `packages/contracts/src/telemetry-api.ts` - event names, enums, Zod schemas, exported types
- Create: `packages/contracts/src/telemetry-api.test.ts` - schema allowlist/denylist tests
- Modify: `packages/contracts/src/index.ts` - export telemetry contract
- Modify: `packages/contracts/package.json` - add `./telemetry-api` package export
- Modify: `packages/contracts/src/ipc-channels.ts` - add `TelemetryChannels`
- Modify: `packages/contracts/src/ipc-channels.test.ts` - assert telemetry channel prefix
- Create: `packages/rpc/src/telemetry.ts` - generated RPC domain for renderer API
- Modify: `packages/rpc/src/index.ts` - include telemetry RPC domain
- Create: `packages/rpc/src/telemetry.test.ts` - RPC shape tests
- Generated: `apps/desktop/src/preload/generated-rpc.ts`
- Generated: `apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts`

**Sync-server**

- Modify: `apps/sync-server/wrangler.toml` - add `PRODUCT_TELEMETRY` Analytics Engine datasets
- Modify: `apps/sync-server/wrangler.test.ts` - assert telemetry binding
- Modify: `apps/sync-server/src/types.ts` - add `PRODUCT_TELEMETRY` and `TELEMETRY_HMAC_KEY`
- Create: `apps/sync-server/src/services/telemetry.ts` - validation-to-WAE mapping and hashing
- Create: `apps/sync-server/src/services/telemetry.test.ts` - hashing/mapping/denylist tests
- Create: `apps/sync-server/src/routes/telemetry.ts` - public batch endpoint
- Create: `apps/sync-server/src/routes/telemetry.test.ts` - route behavior tests
- Modify: `apps/sync-server/src/index.ts` - route `/telemetry`
- Modify: `apps/sync-server/src/index.test.ts` - route body limit/health coverage if needed

**Desktop main process**

- Create: `apps/desktop/src/main/telemetry/install-id.ts` - userData install ID storage
- Create: `apps/desktop/src/main/telemetry/install-id.test.ts`
- Create: `apps/desktop/src/main/telemetry/client.ts` - queue, batching, flush, opt-out behavior
- Create: `apps/desktop/src/main/telemetry/client.test.ts`
- Create: `apps/desktop/src/main/telemetry/runtime.ts` - app/session context and lifecycle helpers
- Create: `apps/desktop/src/main/telemetry/runtime.test.ts`
- Create: `apps/desktop/src/main/ipc/telemetry-handlers.ts` - renderer-facing track/flush/settings handlers
- Create: `apps/desktop/src/main/ipc/telemetry-handlers.test.ts`
- Modify: `apps/desktop/src/main/ipc/index.ts` - register telemetry handlers
- Modify: `apps/desktop/src/main/index.ts` - initialize telemetry after `app.whenReady()` and flush on quit

**Renderer**

- Create: `apps/desktop/src/renderer/src/lib/telemetry.ts` - safe wrapper around `window.api.telemetry`
- Create: `apps/desktop/src/renderer/src/lib/telemetry.test.ts`
- Modify: `apps/desktop/src/renderer/src/App.tsx` - lifecycle/onboarding/vault/page events
- Modify: selected feature files only for initial coverage:
  - `apps/desktop/src/main/ipc/vault-handlers.ts`
  - `apps/desktop/src/main/ipc/notes-handlers.ts`
  - `apps/desktop/src/main/ipc/journal-handlers.ts`
  - `apps/desktop/src/main/ipc/tasks-handlers.ts`
  - `apps/desktop/src/main/ipc/inbox-handlers.ts`
  - `apps/desktop/src/main/ipc/search-handlers.ts`
  - `apps/desktop/src/main/ipc/calendar-handlers.ts`
  - `apps/desktop/src/main/sync/runtime.ts`

**Docs / Dashboards**

- Create: `docs/metrics/application-metrics.md` - event dictionary and Grafana query cookbook
- Create: `docs/metrics/grafana-dashboard-queries.md` - sampled-safe dashboard SQL

---

## Chunk 1: Shared Contract

### Task 1: Add telemetry API schemas

**Files:**
- Create: `packages/contracts/src/telemetry-api.ts`
- Create: `packages/contracts/src/telemetry-api.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/package.json`

- [ ] **Step 1.1: Write failing contract tests**

Create `packages/contracts/src/telemetry-api.test.ts` with tests for:

- accepts a valid anonymous batch with `app_started`
- accepts valid metrics fields
- rejects unknown event name
- rejects unknown surface
- rejects URLs, paths, emails, long text values in dimensions
- rejects more than 100 events
- rejects missing `installId` or `sessionId`

Run:

```bash
pnpm --filter @memry/contracts exec vitest run src/telemetry-api.test.ts
```

Expected: FAIL because `telemetry-api.ts` does not exist.

- [ ] **Step 1.2: Implement minimal telemetry schemas**

Create `packages/contracts/src/telemetry-api.ts`:

```ts
import { z } from 'zod'

export const TelemetryEventNameSchema = z.enum([
  'app_started',
  'app_backgrounded',
  'app_active_heartbeat',
  'onboarding_started',
  'onboarding_completed',
  'vault_created',
  'vault_opened',
  'page_viewed',
  'note_created',
  'note_opened',
  'note_updated',
  'note_deleted',
  'journal_opened',
  'journal_updated',
  'task_created',
  'task_completed',
  'task_reopened',
  'project_created',
  'inbox_captured',
  'inbox_filed',
  'inbox_archived',
  'inbox_snoozed',
  'search_opened',
  'search_performed',
  'search_result_opened',
  'calendar_event_created',
  'calendar_event_updated',
  'calendar_google_connected',
  'calendar_google_sync_completed',
  'graph_opened',
  'setting_changed',
  'sync_enabled',
  'sync_run_completed',
  'sync_error',
  'voice_recording_completed',
  'transcription_completed',
  'ai_action_completed',
  'app_error_seen'
])

export const TelemetrySurfaceSchema = z.enum([
  'app',
  'onboarding',
  'vault',
  'notes',
  'journal',
  'tasks',
  'inbox',
  'calendar',
  'search',
  'graph',
  'settings',
  'sync',
  'ai',
  'voice',
  'updater'
])

export const TelemetryResultSchema = z.enum(['success', 'failed', 'canceled', 'skipped'])
export const TelemetryBuildChannelSchema = z.enum(['development', 'staging', 'production'])
export const TelemetryAuthStateSchema = z.enum(['anonymous', 'signed_in', 'signed_out'])
export const TelemetrySyncStateSchema = z.enum(['disabled', 'enabled', 'unknown'])

const SAFE_DIMENSION_VALUE = /^(?!.*@)(?!.*:\/\/)(?!.*[/\\]).{1,64}$/

export const TelemetryMetricsSchema = z.object({
  durationMs: z.number().finite().nonnegative().optional(),
  itemCount: z.number().finite().nonnegative().optional(),
  byteCount: z.number().finite().nonnegative().optional(),
  queueCount: z.number().finite().nonnegative().optional(),
  resultCount: z.number().finite().nonnegative().optional(),
  retryCount: z.number().finite().nonnegative().optional(),
  activeSeconds: z.number().finite().nonnegative().optional(),
  value: z.number().finite().optional()
})

export const TelemetryEventSchema = z.object({
  id: z.string().uuid(),
  name: TelemetryEventNameSchema,
  occurredAt: z.string().datetime(),
  surface: TelemetrySurfaceSchema,
  action: z.string().regex(SAFE_DIMENSION_VALUE),
  objectType: z.string().regex(SAFE_DIMENSION_VALUE).optional(),
  source: z.string().regex(SAFE_DIMENSION_VALUE).optional(),
  result: TelemetryResultSchema.optional(),
  errorCode: z.string().regex(SAFE_DIMENSION_VALUE).optional(),
  dimensions: z.record(SafeDimensionValueSchema, SafeDimensionValueSchema).optional(),
  metrics: TelemetryMetricsSchema.optional()
})

export const TelemetryBatchSchema = z.object({
  schemaVersion: z.literal(1),
  installId: z.string().uuid(),
  sessionId: z.string().uuid(),
  appVersion: z.string().min(1).max(32),
  buildChannel: TelemetryBuildChannelSchema,
  platform: z.enum(['darwin', 'win32', 'linux']),
  arch: z.string().min(1).max(32),
  locale: z.string().min(2).max(16),
  timezoneOffsetMinutes: z.number().int().min(-840).max(840),
  authState: TelemetryAuthStateSchema,
  syncState: TelemetrySyncStateSchema,
  clientQueueDepth: z.number().int().min(0).max(1000).optional(),
  events: z.array(TelemetryEventSchema).min(1).max(100)
})

export type TelemetryEventName = z.infer<typeof TelemetryEventNameSchema>
export type TelemetrySurface = z.infer<typeof TelemetrySurfaceSchema>
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>
export type TelemetryBatch = z.infer<typeof TelemetryBatchSchema>
```

Export it from `packages/contracts/src/index.ts`.

Add the subpath export to `packages/contracts/package.json`:

```json
"./telemetry-api": "./src/telemetry-api.ts"
```

- [ ] **Step 1.3: Verify contract tests**

Run:

```bash
pnpm --filter @memry/contracts exec vitest run src/telemetry-api.test.ts
pnpm --filter @memry/contracts typecheck
```

Expected: PASS.

- [ ] **Step 1.4: Commit**

```bash
git add packages/contracts/src/telemetry-api.ts packages/contracts/src/telemetry-api.test.ts packages/contracts/src/index.ts packages/contracts/package.json
git commit -m "feat(metrics): add telemetry contract"
```

### Task 2: Add telemetry IPC/RPC surface

**Files:**
- Modify: `packages/contracts/src/ipc-channels.ts`
- Modify: `packages/contracts/src/ipc-channels.test.ts`
- Create: `packages/rpc/src/telemetry.ts`
- Create: `packages/rpc/src/telemetry.test.ts`
- Modify: `packages/rpc/src/index.ts`
- Generated: `apps/desktop/src/preload/generated-rpc.ts`
- Generated: `apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts`

- [ ] **Step 2.1: Add failing RPC tests**

Add tests asserting:

- `TelemetryChannels.invoke.TRACK === 'telemetry:track'`
- `TelemetryChannels.invoke.FLUSH === 'telemetry:flush'`
- `TelemetryChannels.invoke.GET_SETTINGS === 'telemetry:getSettings'`
- `TelemetryChannels.invoke.SET_ENABLED === 'telemetry:setEnabled'`
- `telemetryRpc.name === 'telemetry'`

Run:

```bash
pnpm --filter @memry/contracts exec vitest run src/ipc-channels.test.ts
pnpm --filter @memry/rpc exec vitest run src/telemetry.test.ts
```

Expected: FAIL until channels/domain exist.

- [ ] **Step 2.2: Implement telemetry channel and RPC domain**

Add to `packages/contracts/src/ipc-channels.ts`:

```ts
export const TelemetryChannels = {
  invoke: {
    TRACK: 'telemetry:track',
    FLUSH: 'telemetry:flush',
    GET_SETTINGS: 'telemetry:getSettings',
    SET_ENABLED: 'telemetry:setEnabled'
  }
} as const
```

Create `packages/rpc/src/telemetry.ts`:

```ts
import type { TelemetryEvent } from '../../contracts/src/telemetry-api.ts'
import { TelemetryChannels } from '../../contracts/src/ipc-channels.ts'
import { defineDomain, defineMethod, type RpcClient } from './schema.ts'

export interface TelemetrySettings {
  enabled: boolean
}

type SuccessResponse = Promise<{ success: boolean; error?: string }>

export const telemetryRpc = defineDomain({
  name: 'telemetry',
  methods: {
    track: defineMethod<(event: TelemetryEvent) => SuccessResponse>({
      channel: TelemetryChannels.invoke.TRACK,
      params: ['event']
    }),
    flush: defineMethod<() => SuccessResponse>({
      channel: TelemetryChannels.invoke.FLUSH
    }),
    getSettings: defineMethod<() => Promise<TelemetrySettings>>({
      channel: TelemetryChannels.invoke.GET_SETTINGS
    }),
    setEnabled: defineMethod<(enabled: boolean) => SuccessResponse>({
      channel: TelemetryChannels.invoke.SET_ENABLED,
      params: ['enabled']
    })
  }
})

export type TelemetryClientAPI = RpcClient<typeof telemetryRpc>
```

Wire `telemetryRpc` into `packages/rpc/src/index.ts`.

- [ ] **Step 2.3: Regenerate IPC/RPC bindings**

Run:

```bash
pnpm ipc:generate
pnpm ipc:check
```

Expected: generated preload and main invoke-map include `telemetry`.

- [ ] **Step 2.4: Verify**

Run:

```bash
pnpm --filter @memry/contracts exec vitest run src/ipc-channels.test.ts src/telemetry-api.test.ts
pnpm --filter @memry/rpc exec vitest run src/telemetry.test.ts src/index.test.ts
pnpm ipc:check
```

Expected: PASS.

- [ ] **Step 2.5: Commit**

```bash
git add packages/contracts/src/ipc-channels.ts packages/contracts/src/ipc-channels.test.ts packages/rpc/src/telemetry.ts packages/rpc/src/telemetry.test.ts packages/rpc/src/index.ts apps/desktop/src/preload/generated-rpc.ts apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts
git commit -m "feat(metrics): expose telemetry ipc api"
```

---

## Chunk 2: Cloudflare Ingestion

### Task 3: Add Workers Analytics Engine binding

**Files:**
- Modify: `apps/sync-server/wrangler.toml`
- Modify: `apps/sync-server/wrangler.test.ts`
- Modify: `apps/sync-server/src/types.ts`

- [ ] **Step 3.1: Write failing config tests**

Extend `apps/sync-server/wrangler.test.ts` to assert:

- root/staging/production define `binding = "PRODUCT_TELEMETRY"`
- production dataset is `memry_product_telemetry_production`
- staging dataset is `memry_product_telemetry_staging`

Run:

```bash
pnpm --filter @memry/sync-server exec vitest run wrangler.test.ts
```

Expected: FAIL until binding is present.

- [ ] **Step 3.2: Add Analytics Engine binding**

Add to `apps/sync-server/wrangler.toml` root:

```toml
[[analytics_engine_datasets]]
binding = "PRODUCT_TELEMETRY"
dataset = "memry_product_telemetry_dev"
```

Add under `[env.staging]`:

```toml
[[env.staging.analytics_engine_datasets]]
binding = "PRODUCT_TELEMETRY"
dataset = "memry_product_telemetry_staging"
```

Add under `[env.production]`:

```toml
[[env.production.analytics_engine_datasets]]
binding = "PRODUCT_TELEMETRY"
dataset = "memry_product_telemetry_production"
```

Update `apps/sync-server/src/types.ts`:

```ts
PRODUCT_TELEMETRY: AnalyticsEngineDataset
TELEMETRY_HMAC_KEY: string
```

- [ ] **Step 3.3: Verify**

Run:

```bash
pnpm --filter @memry/sync-server exec vitest run wrangler.test.ts
pnpm --filter @memry/sync-server typecheck
```

Expected: PASS. If production health tests fail for missing `TELEMETRY_HMAC_KEY`, update
required-secret handling in Task 5 after route coverage is added.

- [ ] **Step 3.4: Commit**

```bash
git add apps/sync-server/wrangler.toml apps/sync-server/wrangler.test.ts apps/sync-server/src/types.ts
git commit -m "feat(metrics): configure telemetry analytics dataset"
```

### Task 4: Implement telemetry service mapping

**Files:**
- Create: `apps/sync-server/src/services/telemetry.ts`
- Create: `apps/sync-server/src/services/telemetry.test.ts`

- [ ] **Step 4.1: Write failing service tests**

Test:

- `hashTelemetryId` returns stable hex HMAC and never raw ID
- valid batch writes one datapoint per event
- `index1` is install hash
- blob slots match the design mapping
- double slots default to `0`
- `_sample_interval` is not written by us
- invalid batch returns structured validation failure

Run:

```bash
pnpm --filter @memry/sync-server exec vitest run src/services/telemetry.test.ts
```

Expected: FAIL because service does not exist.

- [ ] **Step 4.2: Implement service**

Create `apps/sync-server/src/services/telemetry.ts` with:

- `hashTelemetryId(secret: string, id: string): Promise<string>`
- `writeTelemetryBatch(env, batch): Promise<{ accepted: number }>`
- `toDataPoint(batch, event, hashes)` mapping to WAE arrays
- strict helper for timezone bucket, dimension key/value compaction, and numeric defaults

Use Web Crypto HMAC:

```ts
const key = await crypto.subtle.importKey(
  'raw',
  new TextEncoder().encode(secret),
  { name: 'HMAC', hash: 'SHA-256' },
  false,
  ['sign']
)
```

Call:

```ts
env.PRODUCT_TELEMETRY.writeDataPoint({
  blobs,
  doubles,
  indexes: [anonInstallHash]
})
```

Do not await Analytics Engine writes; they return immediately in the Worker runtime.

- [ ] **Step 4.3: Verify**

Run:

```bash
pnpm --filter @memry/sync-server exec vitest run src/services/telemetry.test.ts
pnpm --filter @memry/sync-server typecheck
```

Expected: PASS.

- [ ] **Step 4.4: Commit**

```bash
git add apps/sync-server/src/services/telemetry.ts apps/sync-server/src/services/telemetry.test.ts
git commit -m "feat(metrics): map telemetry batches to analytics engine"
```

### Task 5: Add public `/telemetry/batch` route

**Files:**
- Create: `apps/sync-server/src/routes/telemetry.ts`
- Create: `apps/sync-server/src/routes/telemetry.test.ts`
- Modify: `apps/sync-server/src/index.ts`
- Modify: `apps/sync-server/src/index.test.ts`

- [ ] **Step 5.1: Write failing route tests**

Test:

- valid `POST /telemetry/batch` returns `{ accepted: 1 }`
- route does not require auth
- invalid payload returns 400
- more than 100 events returns 400
- request body over 128 KB returns 413
- route uses `createRateLimiter({ keyPrefix: 'telemetry', ... })`
- production health requires `TELEMETRY_HMAC_KEY`

Run:

```bash
pnpm --filter @memry/sync-server exec vitest run src/routes/telemetry.test.ts src/index.test.ts
```

Expected: FAIL.

- [ ] **Step 5.2: Implement route**

Create `apps/sync-server/src/routes/telemetry.ts`:

```ts
import { Hono } from 'hono'
import { TelemetryBatchSchema } from '@memry/contracts/telemetry-api'
import { AppError, ErrorCodes } from '../lib/errors'
import { createRateLimiter } from '../middleware/rate-limit'
import { writeTelemetryBatch } from '../services/telemetry'
import type { AppContext } from '../types'

export const telemetry = new Hono<AppContext>()

telemetry.use(
  '/batch',
  createRateLimiter({ maxRequests: 60, windowSeconds: 60, keyPrefix: 'telemetry' })
)

telemetry.post('/batch', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = TelemetryBatchSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid telemetry payload', 400)
  }

  const result = await writeTelemetryBatch(c.env, parsed.data)
  return c.json(result, 202)
})
```

Wire in `apps/sync-server/src/index.ts`:

```ts
import { telemetry } from './routes/telemetry'
app.route('/telemetry', telemetry)
```

Update the existing body-limit helper in `apps/sync-server/src/index.ts` so telemetry has a
smaller limit than the general API:

```ts
const MAX_BODY_BYTES_TELEMETRY = 128 * 1024

const getMaxBodyBytes = (path: string): number => {
  if (path.startsWith('/telemetry/')) {
    return MAX_BODY_BYTES_TELEMETRY
  }

  const isBlobRoute = path.includes('/blob') || path.includes('/attachments/')
  return isBlobRoute ? MAX_BODY_BYTES_BLOB : MAX_BODY_BYTES_API
}
```

Add `TELEMETRY_HMAC_KEY` to required production secrets.

- [ ] **Step 5.3: Verify**

Run:

```bash
pnpm --filter @memry/sync-server exec vitest run src/routes/telemetry.test.ts src/services/telemetry.test.ts src/index.test.ts
pnpm --filter @memry/sync-server typecheck
```

Expected: PASS.

- [ ] **Step 5.4: Commit**

```bash
git add apps/sync-server/src/routes/telemetry.ts apps/sync-server/src/routes/telemetry.test.ts apps/sync-server/src/index.ts apps/sync-server/src/index.test.ts
git commit -m "feat(metrics): add telemetry batch endpoint"
```

---

## Chunk 3: Desktop Telemetry Runtime

### Task 6: Persist anonymous install ID outside the vault

**Files:**
- Create: `apps/desktop/src/main/telemetry/install-id.ts`
- Create: `apps/desktop/src/main/telemetry/install-id.test.ts`

- [ ] **Step 6.1: Write failing tests**

Test:

- creates UUID when no file exists
- reuses UUID from existing file
- replaces corrupt file with a new UUID
- uses Electron `app.getPath('userData')`

Run:

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/main/telemetry/install-id.test.ts
```

Expected: FAIL.

- [ ] **Step 6.2: Implement install ID storage**

Use a JSON file under `app.getPath('userData')/telemetry.json`:

```json
{ "installId": "<uuid-v4>" }
```

Use `createLogger('TelemetryInstall')`. Do not put this in vault settings or synced settings.

- [ ] **Step 6.3: Verify and commit**

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/main/telemetry/install-id.test.ts
git add apps/desktop/src/main/telemetry/install-id.ts apps/desktop/src/main/telemetry/install-id.test.ts
git commit -m "feat(metrics): persist anonymous telemetry install id"
```

### Task 7: Build main-process telemetry client

**Files:**
- Create: `apps/desktop/src/main/telemetry/client.ts`
- Create: `apps/desktop/src/main/telemetry/client.test.ts`

- [ ] **Step 7.1: Write failing client tests**

Test:

- `track` queues events when enabled
- `track` drops events when disabled
- queue caps at 500 events and drops oldest
- `flush` posts `/telemetry/batch`
- flush failure is swallowed and keeps/drops according to retry policy
- `setEnabled(false)` clears queue
- payload includes install/session/app/platform context

Run:

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/main/telemetry/client.test.ts
```

Expected: FAIL.

- [ ] **Step 7.2: Implement client**

Implement:

- `createTelemetryClient(deps)`
- `track(event)`
- `flush(reason)`
- `setEnabled(enabled)`
- `getSettings()`

Defaults:

- production enabled unless user setting says false
- non-production disabled unless `MEMRY_TELEMETRY_ENABLED=true`
- endpoint from `TELEMETRY_ENDPOINT`, otherwise `${SYNC_SERVER_URL}/telemetry/batch`, otherwise production default
- flush every 30 seconds, max batch 50
- max queue 500

Use `net.fetch`, not renderer fetch. Use `createLogger('Telemetry')`.

- [ ] **Step 7.3: Verify and commit**

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/main/telemetry/client.test.ts
git add apps/desktop/src/main/telemetry/client.ts apps/desktop/src/main/telemetry/client.test.ts
git commit -m "feat(metrics): add desktop telemetry queue"
```

### Task 8: Add telemetry runtime and IPC handlers

**Files:**
- Create: `apps/desktop/src/main/telemetry/runtime.ts`
- Create: `apps/desktop/src/main/telemetry/runtime.test.ts`
- Create: `apps/desktop/src/main/ipc/telemetry-handlers.ts`
- Create: `apps/desktop/src/main/ipc/telemetry-handlers.test.ts`
- Modify: `apps/desktop/src/main/ipc/index.ts`
- Modify: `apps/desktop/src/main/index.ts`

- [ ] **Step 8.1: Write failing tests**

Test:

- `registerTelemetryHandlers` registers all four channels
- track handler validates `TelemetryEventSchema`
- flush handler calls runtime flush
- setEnabled persists setting and clears queue when false
- runtime emits `app_started` after init

Run:

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/main/ipc/telemetry-handlers.test.ts src/main/telemetry/runtime.test.ts
```

Expected: FAIL.

- [ ] **Step 8.2: Implement runtime and handlers**

Runtime responsibilities:

- initialize once after `app.whenReady()`
- create session UUID per launch
- load install ID
- read enabled setting from userData telemetry config
- expose `trackTelemetry`, `flushTelemetry`, `setTelemetryEnabled`, `getTelemetrySettings`
- flush on `before-quit` and existing shutdown path

IPC handler responsibilities:

- renderer calls `window.api.telemetry.track(event)`
- handler validates event and forwards to runtime
- failures return `{ success: false, error }` but renderer wrapper ignores failures

Register in `apps/desktop/src/main/ipc/index.ts` beside other handlers. In `apps/desktop/src/main/index.ts`,
initialize after `app.whenReady()` and before first window creation if possible; read existing boot order before
patching.

- [ ] **Step 8.3: Regenerate and verify**

Run:

```bash
pnpm ipc:generate
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/main/ipc/telemetry-handlers.test.ts src/main/telemetry/runtime.test.ts src/main/ipc/index.test.ts
pnpm ipc:check
```

Expected: PASS.

- [ ] **Step 8.4: Commit**

```bash
git add apps/desktop/src/main/telemetry/runtime.ts apps/desktop/src/main/telemetry/runtime.test.ts apps/desktop/src/main/ipc/telemetry-handlers.ts apps/desktop/src/main/ipc/telemetry-handlers.test.ts apps/desktop/src/main/ipc/index.ts apps/desktop/src/main/index.ts apps/desktop/src/preload/generated-rpc.ts apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts
git commit -m "feat(metrics): wire desktop telemetry runtime"
```

---

## Chunk 4: Product Instrumentation

### Task 9: Add safe renderer telemetry wrapper

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/telemetry.ts`
- Create: `apps/desktop/src/renderer/src/lib/telemetry.test.ts`

- [ ] **Step 9.1: Write failing tests**

Test:

- wrapper creates UUID event ID and ISO timestamp
- wrapper calls `window.api.telemetry.track`
- wrapper catches IPC errors
- wrapper strips unknown dimension values before sending if local helper is used

Run:

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/renderer/src/lib/telemetry.test.ts
```

Expected: FAIL.

- [ ] **Step 9.2: Implement wrapper**

Expose:

```ts
trackTelemetry(name, { surface, action, objectType, source, result, errorCode, dimensions, metrics })
```

This file must not know content, routes with IDs, or raw search strings. It only accepts typed enum
values from call sites.

- [ ] **Step 9.3: Verify and commit**

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/renderer/src/lib/telemetry.test.ts
git add apps/desktop/src/renderer/src/lib/telemetry.ts apps/desktop/src/renderer/src/lib/telemetry.test.ts
git commit -m "feat(metrics): add renderer telemetry wrapper"
```

### Task 10: Instrument lifecycle, onboarding, vault, and navigation

**Files:**
- Modify: `apps/desktop/src/renderer/src/App.tsx`
- Modify: `apps/desktop/src/main/ipc/vault-handlers.ts`

- [ ] **Step 10.1: Add tests or existing test assertions**

Use renderer tests where available and IPC tests for vault handlers. Verify:

- onboarding completion emits `onboarding_completed`
- vault creation emits `vault_created`
- vault opening emits `vault_opened`
- `page_viewed` uses surface/page enum only, no note IDs or paths

Run targeted existing tests first to identify the right files:

```bash
rg -n "FirstRunOnboarding|VaultOnboarding|vault:create|vault:select" apps/desktop/src -g '*.test.tsx' -g '*.test.ts'
```

- [ ] **Step 10.2: Implement instrumentation**

Add only these day-one events:

- `onboarding_started`
- `onboarding_completed`
- `vault_created`
- `vault_opened`
- `page_viewed`

Keep dimensions coarse:

- onboarding source/step enum
- vault source enum: `create`, `select`, `switch`, `auto_open`
- page enum: `inbox`, `journal`, `calendar`, `graph`, `tasks`, `note`, `settings`

- [ ] **Step 10.3: Verify and commit**

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/main/ipc/vault-handlers.test.ts
pnpm --filter @memry/desktop typecheck
git add apps/desktop/src/renderer/src/App.tsx apps/desktop/src/main/ipc/vault-handlers.ts
git commit -m "feat(metrics): track activation and navigation events"
```

### Task 11: Instrument core product actions

**Files:**
- Modify: `apps/desktop/src/main/ipc/notes-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/journal-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/tasks-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/inbox-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/search-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/calendar-handlers.ts`

- [ ] **Step 11.1: Add focused tests**

For each handler file, add only one or two assertions that successful action calls invoke
`trackTelemetry` with safe enum dimensions. Do not assert every field in every test.

Required coverage:

- note create/open/update/delete
- journal open/update
- task create/complete/reopen
- inbox capture/file/archive/snooze
- search open/perform/result opened, without query text
- calendar event create/update and Google connect/sync result

- [ ] **Step 11.2: Implement instrumentation**

Rules:

- Track after operation succeeds.
- For failed operations, track `result: 'failed'` only where there is already structured error handling.
- Never include names/titles/query strings/paths.
- Use `source` enums already known at call site; otherwise use `unknown`.
- Use counts/durations only where already available without extra queries.

- [ ] **Step 11.3: Verify**

Run:

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts \
  src/main/ipc/notes-handlers.test.ts \
  src/main/ipc/journal-handlers.test.ts \
  src/main/ipc/tasks-handlers.test.ts \
  src/main/ipc/inbox-handlers.test.ts \
  src/main/ipc/search-handlers.test.ts \
  src/main/ipc/calendar-handlers.test.ts
pnpm --filter @memry/desktop typecheck
```

Expected: PASS. If existing known type errors appear outside touched files, record them and continue only
if no new errors are introduced.

- [ ] **Step 11.4: Commit**

```bash
git add apps/desktop/src/main/ipc/notes-handlers.ts apps/desktop/src/main/ipc/journal-handlers.ts apps/desktop/src/main/ipc/tasks-handlers.ts apps/desktop/src/main/ipc/inbox-handlers.ts apps/desktop/src/main/ipc/search-handlers.ts apps/desktop/src/main/ipc/calendar-handlers.ts
git commit -m "feat(metrics): track core product usage events"
```

### Task 12: Instrument sync and reliability

**Files:**
- Modify: `apps/desktop/src/main/sync/runtime.ts`
- Modify: `apps/desktop/src/main/sync/engine/push-coordinator.ts`
- Modify: `apps/desktop/src/main/sync/engine/pull-coordinator.ts`
- Modify only if needed: `apps/desktop/src/main/sync/engine/crdt-sync-coordinator.ts`

- [ ] **Step 12.1: Add tests**

Extend existing sync runtime/engine tests to assert:

- enabling sync emits `sync_enabled`
- completed push/pull emits `sync_run_completed`
- sync failure emits `sync_error` with enum error code only
- queue size/item count metrics are numeric only

- [ ] **Step 12.2: Implement sync telemetry**

Track:

- source operation: `push`, `pull`, `full`, `crdt`
- dimension transport: `record`, `crdt`
- itemCount, queueCount, durationMs
- result/errorCode enum

Do not include item IDs, note IDs, device IDs, or server cursors.

- [ ] **Step 12.3: Verify and commit**

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts \
  src/main/sync/runtime.test.ts \
  src/main/sync/engine-pull.test.ts \
  src/main/sync/engine-crdt.test.ts
pnpm --filter @memry/desktop typecheck
git add apps/desktop/src/main/sync/runtime.ts apps/desktop/src/main/sync/engine/push-coordinator.ts apps/desktop/src/main/sync/engine/pull-coordinator.ts apps/desktop/src/main/sync/engine/crdt-sync-coordinator.ts
git commit -m "feat(metrics): track sync reliability metrics"
```

---

## Chunk 5: Dashboards and Verification

### Task 13: Document event dictionary and Grafana queries

**Files:**
- Create: `docs/metrics/application-metrics.md`
- Create: `docs/metrics/grafana-dashboard-queries.md`

- [ ] **Step 13.1: Write docs**

`docs/metrics/application-metrics.md` must include:

- event dictionary
- allowed dimensions
- denied data examples
- owner dashboard per event group
- rollout checklist

`docs/metrics/grafana-dashboard-queries.md` must include sampled-safe queries:

```sql
SELECT
  intDiv(toUInt32(timestamp), 86400) * 86400 AS t,
  SUM(_sample_interval * double1) AS events
FROM memry_product_telemetry_production
WHERE timestamp > NOW() - INTERVAL '30' DAY
GROUP BY t
ORDER BY t
```

Use `SUM(_sample_interval * double1)` for counts and weighted averages for durations.

- [ ] **Step 13.2: Verify docs**

Run:

```bash
rg -n "count\\(\\)|AVG\\(" docs/metrics/grafana-dashboard-queries.md
rg -n "title|query|url|path|email|content" docs/metrics/application-metrics.md
```

Expected: no unsafe query patterns; denylist terms appear only in privacy/denylist sections.

- [ ] **Step 13.3: Commit**

```bash
git add docs/metrics/application-metrics.md docs/metrics/grafana-dashboard-queries.md
git commit -m "docs(metrics): add telemetry event dictionary and grafana queries"
```

### Task 14: End-to-end local and staging verification

**Files:**
- No source files expected unless verification exposes bugs

- [ ] **Step 14.1: Local contract and unit verification**

Run:

```bash
pnpm --filter @memry/contracts exec vitest run src/telemetry-api.test.ts src/ipc-channels.test.ts
pnpm --filter @memry/rpc exec vitest run src/telemetry.test.ts src/index.test.ts
pnpm --filter @memry/sync-server exec vitest run src/routes/telemetry.test.ts src/services/telemetry.test.ts wrangler.test.ts
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/main/telemetry src/main/ipc/telemetry-handlers.test.ts src/renderer/src/lib/telemetry.test.ts
pnpm ipc:check
```

Expected: PASS.

- [ ] **Step 14.2: Full repo gates**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

Expected: PASS, except known pre-existing typecheck issues called out in project notes if they still exist
and are unrelated. Record exact failures if any.

- [ ] **Step 14.3: Local Worker smoke test**

Run:

```bash
pnpm --filter @memry/sync-server exec wrangler dev --local --port 8791
```

In a second shell:

```bash
curl -i http://localhost:8791/telemetry/batch \
  -H 'Content-Type: application/json' \
  --data '{"schemaVersion":1,"installId":"550e8400-e29b-41d4-a716-446655440000","sessionId":"550e8400-e29b-41d4-a716-446655440001","appVersion":"0.1.0","buildChannel":"development","platform":"darwin","arch":"arm64","locale":"en","timezoneOffsetMinutes":-180,"authState":"anonymous","syncState":"disabled","events":[{"id":"550e8400-e29b-41d4-a716-446655440002","name":"app_started","occurredAt":"2026-05-01T12:00:00.000Z","surface":"app","action":"started","result":"success"}]}'
```

Expected: `202 Accepted` with `{"accepted":1}`.

- [ ] **Step 14.4: Staging deployment verification**

Before deploy, set staging secret:

```bash
pnpm --filter @memry/sync-server exec wrangler secret put TELEMETRY_HMAC_KEY --env staging
```

Deploy:

```bash
pnpm --filter @memry/sync-server deploy:staging
```

Query Analytics Engine:

```bash
curl "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/analytics_engine/sql" \
  --header "Authorization: Bearer $CLOUDFLARE_ANALYTICS_TOKEN" \
  --data "SHOW TABLES"
```

Expected: staging telemetry table appears after first successful event write.

- [ ] **Step 14.5: Commit any verification fixes**

Only if verification required fixes:

```bash
git add <fixed-files>
git commit -m "fix(metrics): address telemetry verification gaps"
```

---

## Final Done Criteria

- Telemetry contracts reject unsafe/free-form data
- Desktop can track anonymous users without signup
- Telemetry opt-out works and drops queued events
- `/telemetry/batch` accepts valid anonymous batches without auth
- Worker writes only hashed install/session identifiers to Analytics Engine
- Workers Analytics Engine binding exists for development, staging, and production
- Core dashboards have sampled-safe SQL
- `pnpm ipc:check`, targeted Vitest suites, typecheck, and lint have been run
- No raw content, paths, URLs, emails, or search queries are present in telemetry tests or docs except denylist examples
