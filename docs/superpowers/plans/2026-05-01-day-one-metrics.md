# Day One Metrics Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship privacy-first, anonymous day-one metrics for Memry production launch, with Cloudflare Analytics Engine as the custom metrics store, Grafana as the primary dashboard/alerting layer, and Sentry as the crash/release-health workflow.

**Architecture:** Desktop metrics are generated in Electron renderer/main, validated through typed IPC, redacted and bucketed in main, queued locally under app userData, then uploaded to `/telemetry/batch` on the sync-server Worker. The Worker validates an allowlisted schema and writes both desktop product metrics and sync-server custom metrics into Cloudflare Analytics Engine. Grafana reads Analytics Engine through the SQL API; Sentry receives only scrubbed crash/performance/release data.

**Tech Stack:** Electron 39, React 19, TypeScript, Zod, Hono, Cloudflare Workers Analytics Engine, Grafana, Sentry Electron, Vitest, existing `electron-log`.

**External docs checked:** Cloudflare Analytics Engine binding syntax and automatic dataset creation; Analytics Engine SQL/Grafana integration; Sentry Electron SDK-side data scrubbing.

---

## Non-Negotiable Privacy Rules

- No note text, task title, journal text, inbox content, file name, folder path, URL, search query, calendar title/location/attendee, email, device name, vault path, account ID, IP, or raw user-agent in telemetry payloads.
- No session replay, heatmaps, autocapture, screenshots, DOM recording, or console-log forwarding for production day one.
- No stable server-side user profile for product analytics. Retention and activation milestones are computed locally and emitted once.
- Metrics are off until the user explicitly enables "Share anonymous product and reliability metrics" in onboarding or settings.
- The telemetry Worker rejects unknown event names, unknown payload keys, raw strings longer than the defined caps, and any blocked key names.
- Long-term storage is aggregate-only. Raw Analytics Engine rows are for short-term launch diagnostics.

## Success Criteria

- A production build can answer these launch questions without inspecting private content:
  - How many opted-in installs opened the app today?
  - What percent reached first useful action?
  - What percent returned on D1/D7/D30?
  - Which features are being used daily?
  - Is sync setup succeeding?
  - Are sync pushes/pulls healthy?
  - Are crashes/startup failures regressing by app version?
- Grafana has one Memry launch dashboard with product, desktop quality, and sync health panels.
- Sentry has release health enabled and PII scrubbed before events leave the app.
- `pnpm ipc:check`, `pnpm typecheck`, focused desktop tests, and focused sync-server tests pass.

---

## File Structure

**Create:**

```text
packages/contracts/src/telemetry.ts
packages/contracts/src/telemetry.test.ts

apps/sync-server/src/routes/telemetry.ts
apps/sync-server/src/routes/telemetry.test.ts
apps/sync-server/src/services/analytics-engine.ts
apps/sync-server/src/services/analytics-engine.test.ts
apps/sync-server/src/services/sync-analytics.ts
apps/sync-server/src/services/sync-analytics.test.ts

apps/desktop/src/main/telemetry/client.ts
apps/desktop/src/main/telemetry/client.test.ts
apps/desktop/src/main/telemetry/identity.ts
apps/desktop/src/main/telemetry/identity.test.ts
apps/desktop/src/main/telemetry/privacy.ts
apps/desktop/src/main/telemetry/privacy.test.ts
apps/desktop/src/main/telemetry/queue.ts
apps/desktop/src/main/telemetry/queue.test.ts
apps/desktop/src/main/telemetry/runtime.ts
apps/desktop/src/main/telemetry/runtime.test.ts
apps/desktop/src/main/ipc/telemetry-handlers.ts
apps/desktop/src/main/ipc/telemetry-handlers.test.ts
apps/desktop/src/preload/api/telemetry.ts

apps/desktop/src/main/observability/sentry.ts
apps/desktop/src/main/observability/sentry.test.ts

apps/desktop/src/renderer/src/lib/telemetry.ts
apps/desktop/src/renderer/src/lib/telemetry.test.ts
apps/desktop/src/renderer/src/hooks/use-feature-telemetry.ts
apps/desktop/src/renderer/src/hooks/use-feature-telemetry.test.ts

docs/observability/day-one-metrics.md
docs/observability/privacy-metrics-policy.md
ops/grafana/memry-day-one-dashboard.json
ops/grafana/memry-day-one-alerts.md
```

**Modify:**

```text
packages/contracts/package.json
packages/contracts/src/ipc-channels.ts
packages/contracts/src/settings-schemas.ts

apps/sync-server/wrangler.toml
apps/sync-server/src/types.ts
apps/sync-server/src/index.ts
apps/sync-server/src/routes/sync.ts
apps/sync-server/src/services/sync-telemetry.ts

apps/desktop/package.json
apps/desktop/src/main/index.ts
apps/desktop/src/main/ipc/index.ts
apps/desktop/src/main/ipc/settings-handlers.ts
apps/desktop/src/preload/index.ts
apps/desktop/src/preload/index.d.ts
apps/desktop/src/renderer/src/pages/settings/setup-wizard.tsx
apps/desktop/src/renderer/src/pages/settings/setup-wizard.i18n.test.tsx
apps/desktop/src/renderer/src/pages/settings/general-section.tsx
packages/i18n/src/locales/en/settings.json
packages/i18n/src/locales/tr/settings.json
packages/i18n/src/locales/ar/settings.json
```

---

## Event Model

Use one Analytics Engine dataset for day-one metrics: `memry_telemetry_events`.

Analytics Engine column mapping:

```text
index1  = dailyAnonId
blob1   = environment
blob2   = source              # desktop | sync_server
blob3   = eventName
blob4   = appVersion
blob5   = platform            # macos | windows | linux | server
blob6   = releaseChannel      # dev | staging | production
blob7   = feature             # notes | tasks | journal | inbox | calendar | graph | search | sync | app
blob8   = outcome             # success | failure | skipped | started | completed
blob9   = reason              # enum/bucket only
blob10  = bucket              # latency/count/size/session bucket
blob11  = locale
blob12  = schemaVersion
double1 = count
double2 = durationMs
double3 = itemCount
double4 = payloadBytes
double5 = errorCount
```

All queries must use `SUM(_sample_interval * doubleN)` or `SUM(_sample_interval)` so downsampling stays correct.

Day-one event names:

```text
app_installed
app_session_started
app_session_ended
retention_milestone_reached
activation_milestone_reached
feature_daily_summary
feature_action_completed
quality_event_recorded
perf_measurement_recorded
sync_setup_step_completed
sync_operation_completed
sync_operation_rejected
sync_crdt_activity
telemetry_batch_rejected
telemetry_batch_accepted
```

Day-one activation milestones:

```text
first_app_open
first_vault_opened
first_note_created
first_capture_created
first_task_created
first_journal_entry_created
first_search_completed
first_second_session
first_sync_setup_started
first_sync_setup_completed
```

Day-one retention milestones:

```text
d1
d7
d30
```

---

## Chunk 1: Shared Contracts And Privacy Wall

### Task 1: Add telemetry contract

**Files:**
- Create: `packages/contracts/src/telemetry.ts`
- Test: `packages/contracts/src/telemetry.test.ts`
- Modify: `packages/contracts/package.json`

- [ ] **Step 1: Write failing schema tests**

Test that:
- allowed event payloads parse
- unknown event names fail
- unknown payload keys fail
- blocked keys like `email`, `title`, `content`, `path`, `url`, `query`, `deviceName`, `accountId`, `userId` fail
- overlong string values fail
- daily anonymous IDs are accepted only as fixed-size hex strings

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @memry/contracts typecheck`

Expected: FAIL because `@memry/contracts/telemetry` does not exist.

- [ ] **Step 3: Implement the Zod contract**

Add:
- `TelemetryEventNameSchema`
- `TelemetrySourceSchema`
- `TelemetryFeatureSchema`
- `TelemetryOutcomeSchema`
- `TelemetryBucketSchema`
- `TelemetryEventSchema`
- `TelemetryBatchSchema`
- `TelemetryConsentSettingsSchema`
- `BLOCKED_TELEMETRY_KEYS`
- `assertTelemetryPayloadIsSafe(payload)`

Use `z.object(...).strict()` everywhere.

- [ ] **Step 4: Export the subpath**

Modify `packages/contracts/package.json`:

```json
"./telemetry": "./src/telemetry.ts"
```

- [ ] **Step 5: Verify**

Run:

```bash
pnpm --filter @memry/contracts typecheck
```

Expected: PASS.

### Task 2: Add telemetry IPC channels

**Files:**
- Modify: `packages/contracts/src/ipc-channels.ts`
- Test: `packages/contracts/src/telemetry.test.ts`

- [ ] **Step 1: Add failing contract expectation**

Assert that `TelemetryChannels.invoke.TRACK`, `TelemetryChannels.invoke.SET_CONSENT`, `TelemetryChannels.invoke.GET_CONSENT`, and `TelemetryChannels.invoke.FLUSH` exist.

- [ ] **Step 2: Implement channel constants**

Add:

```ts
export const TelemetryChannels = {
  invoke: {
    TRACK: 'telemetry:track',
    GET_CONSENT: 'telemetry:getConsent',
    SET_CONSENT: 'telemetry:setConsent',
    FLUSH: 'telemetry:flush'
  }
} as const
```

- [ ] **Step 3: Verify**

Run:

```bash
pnpm --filter @memry/contracts typecheck
pnpm ipc:check
```

Expected: PASS.

---

## Chunk 2: Cloudflare Analytics Engine Ingestion

### Task 3: Add Analytics Engine binding

**Files:**
- Modify: `apps/sync-server/wrangler.toml`
- Modify: `apps/sync-server/src/types.ts`

- [ ] **Step 1: Add binding to all environments**

Top level:

```toml
[[analytics_engine_datasets]]
binding = "TELEMETRY"
dataset = "memry_telemetry_events_dev"
```

Staging:

```toml
[[env.staging.analytics_engine_datasets]]
binding = "TELEMETRY"
dataset = "memry_telemetry_events_staging"
```

Production:

```toml
[[env.production.analytics_engine_datasets]]
binding = "TELEMETRY"
dataset = "memry_telemetry_events"
```

- [ ] **Step 2: Add Worker binding type**

Modify `apps/sync-server/src/types.ts`:

```ts
TELEMETRY: AnalyticsEngineDataset
```

- [ ] **Step 3: Verify**

Run:

```bash
pnpm --filter @memry/sync-server typecheck
```

Expected: PASS.

### Task 4: Add Analytics Engine writer

**Files:**
- Create: `apps/sync-server/src/services/analytics-engine.ts`
- Test: `apps/sync-server/src/services/analytics-engine.test.ts`

- [ ] **Step 1: Write failing writer tests**

Test mapping from a validated telemetry event to `writeDataPoint`:
- `indexes: [dailyAnonId]`
- blobs match the shared column map
- doubles default to `0` when absent
- writer never receives arbitrary payload keys

- [ ] **Step 2: Implement writer**

Create `writeTelemetryEvent(env.TELEMETRY, event)` and `writeTelemetryBatch(env.TELEMETRY, events)`.

- [ ] **Step 3: Verify**

Run:

```bash
pnpm --filter @memry/sync-server test analytics-engine
pnpm --filter @memry/sync-server typecheck
```

Expected: PASS.

### Task 5: Add `/telemetry/batch`

**Files:**
- Create: `apps/sync-server/src/routes/telemetry.ts`
- Test: `apps/sync-server/src/routes/telemetry.test.ts`
- Modify: `apps/sync-server/src/index.ts`

- [ ] **Step 1: Write route tests**

Cover:
- valid batch returns `{ accepted: N, rejected: 0 }`
- unknown event names return `400`
- unknown payload keys return `400`
- blocked key names return `400`
- batch over 100 events returns `413`
- malformed JSON returns `400`
- accepted and rejected batches are themselves written as aggregate guardrail events

- [ ] **Step 2: Implement route**

Route shape:

```text
POST /telemetry/batch
```

Rules:
- unauthenticated
- max 100 events
- max existing API body size
- no request IP/user-agent stored
- no cookies
- no account/device lookup
- schema validation before any write

- [ ] **Step 3: Register route**

Modify `apps/sync-server/src/index.ts`:

```ts
import { telemetry } from './routes/telemetry'
app.route('/telemetry', telemetry)
```

- [ ] **Step 4: Verify**

Run:

```bash
pnpm --filter @memry/sync-server test telemetry
pnpm --filter @memry/sync-server typecheck
```

Expected: PASS.

---

## Chunk 3: Sync-Server Custom Metrics

### Task 6: Convert existing sync telemetry into Analytics Engine writes

**Files:**
- Modify: `apps/sync-server/src/services/sync-telemetry.ts`
- Create: `apps/sync-server/src/services/sync-analytics.ts`
- Test: `apps/sync-server/src/services/sync-analytics.test.ts`
- Modify: `apps/sync-server/src/routes/sync.ts`

- [ ] **Step 1: Preserve current logger tests**

Run:

```bash
pnpm --filter @memry/sync-server test sync-telemetry
```

Expected: PASS before changes.

- [ ] **Step 2: Add failing Analytics Engine tests**

Test that:
- record pushes emit `sync_operation_completed` plus rejected operation rows
- record pulls/changes emit `sync_operation_completed`
- CRDT traffic emits `sync_crdt_activity`
- rejection reasons are enum buckets, not raw error messages
- item type is mapped to domain only: `notes`, `tasks`, `calendar`, etc.

- [ ] **Step 3: Implement non-blocking writes**

Keep current logs. Add an optional Analytics Engine writer call from sync routes after successful operation/rejection summaries are known. Analytics writes must be best-effort and never fail the sync request.

- [ ] **Step 4: Verify**

Run:

```bash
pnpm --filter @memry/sync-server test sync-analytics
pnpm --filter @memry/sync-server test sync-telemetry
pnpm --filter @memry/sync-server typecheck
```

Expected: PASS.

---

## Chunk 4: Desktop Telemetry Runtime

### Task 7: Add consent setting

**Files:**
- Modify: `packages/contracts/src/settings-schemas.ts`
- Modify: `apps/desktop/src/main/ipc/settings-handlers.ts`
- Modify: `apps/desktop/src/renderer/src/pages/settings/setup-wizard.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/settings/setup-wizard.i18n.test.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/settings/general-section.tsx`
- Modify: `packages/i18n/src/locales/en/settings.json`
- Modify: `packages/i18n/src/locales/tr/settings.json`
- Modify: `packages/i18n/src/locales/ar/settings.json`

- [ ] **Step 1: Add failing settings tests**

Add tests for default telemetry consent state:

```ts
telemetry: {
  shareAnonymousMetrics: false
}
```

- [ ] **Step 2: Add schema/default**

Add `TelemetrySettingsSchema`, `TelemetrySettings`, `TELEMETRY_SETTINGS_DEFAULTS`.

- [ ] **Step 3: Add get/set handlers**

Use existing `readGroupSettings` / `writeGroupSettings` pattern in `settings-handlers.ts`.

- [ ] **Step 4: Add settings UI toggle**

Location: Settings -> General -> Privacy.

Copy:

```text
Share anonymous product and reliability metrics
Helps improve Memry without sending note content, task names, file paths, search queries, calendar details, email, or device names.
```

- [ ] **Step 5: Add onboarding consent prompt**

Location: the existing setup wizard.

Rules:
- default unchecked/off
- user can continue without enabling
- enabling writes `telemetry.shareAnonymousMetrics = true`
- no event is queued before this setting is true
- copy mirrors the Settings privacy text

- [ ] **Step 6: Verify**

Run:

```bash
pnpm test:desktop -- settings
pnpm ipc:check
pnpm typecheck:desktop
```

Expected: PASS.

### Task 8: Add local anonymous identity

**Files:**
- Create: `apps/desktop/src/main/telemetry/identity.ts`
- Test: `apps/desktop/src/main/telemetry/identity.test.ts`

- [ ] **Step 1: Write tests**

Cover:
- install ID is generated once under `app.getPath('userData')`
- daily anonymous ID changes by date
- daily anonymous ID is deterministic for the same date
- no ID contains vault/account/email/device data

- [ ] **Step 2: Implement**

Store a local random install secret in:

```text
<userData>/telemetry/identity.json
```

Compute:

```text
dailyAnonId = sha256(installSecret + YYYY-MM-DD + "memry-telemetry-v1")
```

Use only the first 32 hex chars in events.

- [ ] **Step 3: Verify**

Run:

```bash
pnpm --filter @memry/desktop test identity
```

Expected: PASS.

### Task 9: Add privacy sanitizer

**Files:**
- Create: `apps/desktop/src/main/telemetry/privacy.ts`
- Test: `apps/desktop/src/main/telemetry/privacy.test.ts`

- [ ] **Step 1: Write tests**

Cover:
- blocked key names are dropped/rejected
- freeform strings are rejected unless enum-allowlisted
- counts/durations are bucketed
- payloads are strict and match `TelemetryEventSchema`

- [ ] **Step 2: Implement**

Expose:

```ts
sanitizeTelemetryEvent(input): TelemetryEvent | null
toCountBucket(count): TelemetryBucket
toDurationBucket(ms): TelemetryBucket
toSizeBucket(bytes): TelemetryBucket
```

- [ ] **Step 3: Verify**

Run:

```bash
pnpm --filter @memry/desktop test privacy
```

Expected: PASS.

### Task 10: Add bounded local queue

**Files:**
- Create: `apps/desktop/src/main/telemetry/queue.ts`
- Test: `apps/desktop/src/main/telemetry/queue.test.ts`

- [ ] **Step 1: Write queue tests**

Cover:
- enqueue/dequeue
- max 1,000 pending events
- oldest events are dropped first when over cap
- queue survives process restart
- no vault is required

- [ ] **Step 2: Implement JSONL queue**

Store queue at:

```text
<userData>/telemetry/queue.jsonl
```

This is intentionally outside the vault and contains only already-sanitized events.

- [ ] **Step 3: Verify**

Run:

```bash
pnpm --filter @memry/desktop test queue
```

Expected: PASS.

### Task 11: Add desktop upload client

**Files:**
- Create: `apps/desktop/src/main/telemetry/client.ts`
- Test: `apps/desktop/src/main/telemetry/client.test.ts`

- [ ] **Step 1: Write tests**

Cover:
- POSTs to `${SYNC_SERVER_URL}/telemetry/batch`
- uses Electron `net.fetch`
- sends max 100 events per batch
- retries later on network failure
- drops invalid local events instead of uploading
- does nothing when consent is disabled

- [ ] **Step 2: Implement**

Use the existing sync URL resolution pattern from `apps/desktop/src/main/sync/http-client.ts`.

- [ ] **Step 3: Verify**

Run:

```bash
pnpm --filter @memry/desktop test telemetry/client
```

Expected: PASS.

### Task 12: Wire runtime lifecycle metrics

**Files:**
- Create: `apps/desktop/src/main/telemetry/runtime.ts`
- Test: `apps/desktop/src/main/telemetry/runtime.test.ts`
- Modify: `apps/desktop/src/main/index.ts`

- [ ] **Step 1: Write tests**

Cover:
- `app_installed` emitted once after consent
- `app_session_started` on app ready
- `app_session_ended` on quit with duration bucket
- retention milestones emitted once
- flush on quit is best-effort and does not block app shutdown indefinitely

- [ ] **Step 2: Implement runtime**

Initialize after `app.whenReady()` and after settings are available. Register:
- session start
- periodic flush every 60 seconds
- flush on quit
- D1/D7/D30 milestone check on session start

- [ ] **Step 3: Verify**

Run:

```bash
pnpm --filter @memry/desktop test telemetry/runtime
pnpm --filter @memry/desktop typecheck:node
```

Expected: PASS.

### Task 13: Add telemetry IPC and preload API

**Files:**
- Create: `apps/desktop/src/main/ipc/telemetry-handlers.ts`
- Test: `apps/desktop/src/main/ipc/telemetry-handlers.test.ts`
- Modify: `apps/desktop/src/main/ipc/index.ts`
- Create: `apps/desktop/src/preload/api/telemetry.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/preload/index.d.ts`

- [ ] **Step 1: Write tests**

Cover:
- renderer can track only typed events
- handler rejects unsafe payloads
- consent can be read/updated
- generated preload type includes telemetry API

- [ ] **Step 2: Implement handlers**

IPC handler rules:
- validate with contract
- sanitize in main
- enqueue only if consent enabled
- return `{ success: true }` for dropped no-consent events so callers stay simple

- [ ] **Step 3: Register handlers**

Add to `registerAllHandlers()` / `unregisterAllHandlers()`.

- [ ] **Step 4: Verify**

Run:

```bash
pnpm --filter @memry/desktop test telemetry-handlers
pnpm ipc:check
pnpm typecheck:desktop
```

Expected: PASS.

---

## Chunk 5: Product Instrumentation

### Task 14: Add renderer helper

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/telemetry.ts`
- Test: `apps/desktop/src/renderer/src/lib/telemetry.test.ts`
- Create: `apps/desktop/src/renderer/src/hooks/use-feature-telemetry.ts`
- Test: `apps/desktop/src/renderer/src/hooks/use-feature-telemetry.test.ts`

- [ ] **Step 1: Write tests**

Cover:
- helper calls `window.api.telemetry.track`
- helper never accepts arbitrary strings for feature/outcome/event name
- feature daily summary dedupes per feature/day

- [ ] **Step 2: Implement**

Expose:

```ts
trackActivationMilestone(milestone)
trackFeatureAction(feature, actionOutcome)
trackFeatureDailySummary(feature, counters)
trackPerfMeasurement(feature, durationMs)
```

- [ ] **Step 3: Verify**

Run:

```bash
pnpm --filter @memry/desktop test telemetry
pnpm --filter @memry/desktop typecheck:web
```

Expected: PASS.

### Task 15: Instrument activation events

**Files:** touch only the existing feature entrypoints after reading them.

Minimum day-one activation points:

```text
first_vault_opened
first_note_created
first_capture_created
first_task_created
first_journal_entry_created
first_search_completed
first_sync_setup_started
first_sync_setup_completed
```

- [ ] **Step 1: Locate exact mutation handlers**

Use `rg` for note create, quick capture, task create, journal create, search execution, and sync setup flows.

- [ ] **Step 2: Add focused tests around each wrapper/hook touched**

Each test verifies event name only; no content leaves the handler.

- [ ] **Step 3: Add instrumentation**

Only emit after successful mutation. Never include user-entered values.

- [ ] **Step 4: Verify**

Run the focused tests for touched files plus:

```bash
pnpm --filter @memry/desktop typecheck:web
```

Expected: PASS.

### Task 16: Add feature daily summaries

**Files:** use the renderer telemetry helper and existing feature shell components.

Day-one features:

```text
notes
inbox
tasks
journal
calendar
search
graph
sync
google_calendar
ai
```

- [ ] **Step 1: Add daily summary counters**

Counter examples:
- opened
- createdCountBucket
- editedCountBucket
- completedCountBucket
- failedCountBucket

- [ ] **Step 2: Emit once per feature per day**

Store local dedupe state in renderer local storage or main telemetry state. Do not use feature content.

- [ ] **Step 3: Verify**

Run focused renderer tests and:

```bash
pnpm --filter @memry/desktop typecheck:web
```

Expected: PASS.

---

## Chunk 6: Sentry Release Health

### Task 17: Add scrubbed Sentry Electron setup

**Files:**
- Modify: `apps/desktop/package.json`
- Create: `apps/desktop/src/main/observability/sentry.ts`
- Test: `apps/desktop/src/main/observability/sentry.test.ts`
- Modify: `apps/desktop/src/main/index.ts`

- [ ] **Step 1: Add dependency**

```bash
pnpm --filter @memry/desktop add @sentry/electron
```

- [ ] **Step 2: Write scrubber tests**

Cover:
- `sendDefaultPii` is false
- `beforeSend` removes user/request/query/breadcrumb values that could contain content
- no session replay integration is configured
- release and environment are set

- [ ] **Step 3: Implement**

Initialize in main early, after env load but before app work:

```ts
initSentryObservability({
  dsn: process.env.SENTRY_DSN,
  release: app.getVersion(),
  environment: process.env.NODE_ENV === 'production' ? 'production' : 'development'
})
```

Rules:
- no user identity
- no screenshots
- no replay
- scrub breadcrumbs
- use `beforeSend` and `beforeSendTransaction`

- [ ] **Step 4: CI/release source maps follow-up**

If Sentry is enabled for production, add release/source-map upload in release workflow as a separate commit. Do not block basic metrics on source maps.

- [ ] **Step 5: Verify**

Run:

```bash
pnpm --filter @memry/desktop test sentry
pnpm --filter @memry/desktop typecheck:node
```

Expected: PASS.

---

## Chunk 7: Grafana Dashboard And Alerts

### Task 18: Add dashboard docs and JSON

**Files:**
- Create: `docs/observability/day-one-metrics.md`
- Create: `docs/observability/privacy-metrics-policy.md`
- Create: `ops/grafana/memry-day-one-dashboard.json`

- [ ] **Step 1: Document setup**

Include:
- Cloudflare Analytics Engine dataset names
- Grafana data source setup via Analytics Engine SQL API
- required Cloudflare API token scope: Account Analytics Read
- no PostHog direct renderer embed
- dashboard import steps

- [ ] **Step 2: Add dashboard panels**

Panels:
- DAU opted-in installs
- app sessions by version/platform
- activation milestones
- D1/D7/D30 retention milestone counts
- feature daily summaries
- startup/perf buckets
- sync setup funnel
- sync push/pull success/rejection rate
- CRDT activity and payload buckets
- telemetry rejected batches/PII guardrail

- [ ] **Step 3: Use sampling-safe queries**

Every count query uses `SUM(_sample_interval)`.
Every sum query uses `SUM(_sample_interval * doubleN)`.

- [ ] **Step 4: Verify docs**

Run:

```bash
git diff --check docs/observability/day-one-metrics.md docs/observability/privacy-metrics-policy.md ops/grafana/memry-day-one-dashboard.json
```

Expected: no whitespace errors.

### Task 19: Add alert definitions

**Files:**
- Create: `ops/grafana/memry-day-one-alerts.md`

- [ ] **Step 1: Define day-one alerts**

Alerts:
- crash-free sessions below 99.5% in Sentry
- startup failure rate above 1%
- telemetry batch 5xx above 1%
- telemetry schema rejects spike
- sync setup success drops below baseline
- sync operation rejection spike
- sync p95 latency over 1s for 15 minutes
- CRDT rejected activity spike

- [ ] **Step 2: Add runbook links**

Each alert includes:
- what it means
- likely owner
- first query to run
- rollback / mitigation path

- [ ] **Step 3: Verify docs**

Run:

```bash
git diff --check ops/grafana/memry-day-one-alerts.md
```

Expected: no whitespace errors.

---

## Chunk 8: End-To-End Verification

### Task 20: Local telemetry smoke test

**Files:**
- Add tests only if existing unit coverage cannot prove this path.

- [ ] **Step 1: Run sync-server locally**

```bash
pnpm dev:sync-server
```

- [ ] **Step 2: Run desktop in dev**

```bash
SYNC_SERVER_URL=http://localhost:8787 pnpm dev:desktop
```

- [ ] **Step 3: Enable anonymous metrics in settings**

Expected: no telemetry upload before enabling; uploads start after consent.

- [ ] **Step 4: Trigger events**

Create a note, create a task, open search, start sync setup if available in dev.

- [ ] **Step 5: Inspect sync-server logs**

Expected:
- `/telemetry/batch` accepted rows
- no content in logged events
- rejected-event guardrail works when test payload includes blocked keys

### Task 21: Staging deploy smoke test

**Files:** no repo file edits unless a deployment script is missing.

- [ ] **Step 1: Deploy staging Worker**

```bash
pnpm --filter @memry/sync-server deploy:staging
```

- [ ] **Step 2: Send one synthetic telemetry event**

Use `curl` against staging `/telemetry/batch` with a valid event.

- [ ] **Step 3: Query Analytics Engine**

Use Cloudflare SQL API:

```sql
SELECT blob3 AS eventName, SUM(_sample_interval) AS events
FROM memry_telemetry_events_staging
WHERE timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY eventName
ORDER BY events DESC
```

Expected: synthetic event appears.

- [ ] **Step 4: Verify Grafana**

Expected: staging panel shows event within the dashboard time range.

### Task 22: Full gate

- [ ] **Step 1: Run contract checks**

```bash
pnpm ipc:check
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```

Expected: PASS, except known pre-existing test-file type errors only if still documented in AGENTS.

- [ ] **Step 3: Run focused tests**

```bash
pnpm --filter @memry/contracts typecheck
pnpm --filter @memry/sync-server test telemetry sync-analytics analytics-engine
pnpm --filter @memry/desktop test telemetry sentry settings
```

Expected: PASS.

- [ ] **Step 4: Run production privacy audit**

Search for disallowed payload keys in telemetry code:

```bash
rg -n "email|title|content|path|url|query|deviceName|accountId|userId" \
  packages/contracts/src/telemetry.ts \
  apps/desktop/src/main/telemetry \
  apps/desktop/src/renderer/src/lib/telemetry.ts \
  apps/sync-server/src/routes/telemetry.ts \
  apps/sync-server/src/services/*analytics*.ts
```

Expected: matches only in blocked-key constants/tests/docs.

---

## Launch Checklist

- [ ] Anonymous metrics consent toggle exists and defaults off.
- [ ] No telemetry is uploaded before consent.
- [ ] `/telemetry/batch` rejects unknown fields.
- [ ] Analytics Engine staging dataset receives synthetic event.
- [ ] Grafana dashboard imports and renders staging data.
- [ ] Sentry receives a staged test error with scrubbed payload.
- [ ] Sentry does not receive user identity, URLs with query strings, screenshots, or replay.
- [ ] Production `wrangler.toml` Analytics Engine binding is configured.
- [ ] Production Cloudflare API token is installed in Grafana only, not in the app.
- [ ] Alerts route to the chosen owner channel.
- [ ] Privacy policy copy reflects exactly what is collected and what is never collected.

## Out Of Scope For Day One

- PostHog direct client integration.
- Session replay.
- Heatmaps.
- Raw clickstream timelines.
- Per-user product analytics profiles.
- Long-term raw event warehouse.
- Content-derived quality scoring.
- Remote feature flags or experiments.
