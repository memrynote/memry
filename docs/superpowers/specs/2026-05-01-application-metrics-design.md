# Application Metrics and Anonymous Telemetry

**Date:** 2026-05-01
**Status:** Draft

## Summary

Memry needs production product metrics from day one, including users who never sign up or sign
in. The app should collect privacy-preserving, pseudonymous telemetry from the desktop client,
send it through the existing Cloudflare sync-server Worker, store aggregate-friendly events in
Workers Analytics Engine, and visualize product usage in Grafana.

The telemetry system is separate from sync. It never enters the encrypted sync protocol, never
stores note content, task titles, file paths, URLs, search text, calendar titles, emails, recovery
data, or vault paths, and never blocks user workflows. It answers product questions like activation,
feature adoption, retention, capture volume, note/task/inbox/calendar usage, sync health, and error
rates for anonymous and signed-in users.

## Goals

- Measure day-one usage without requiring signup/signin
- Understand activation, retention, engagement, feature adoption, and reliability
- Keep metrics privacy-preserving by design: no content, no raw identifiers, no raw IP storage
- Route telemetry through Cloudflare and query it from Grafana
- Keep desktop telemetry best-effort and non-blocking
- Define a comprehensive event taxonomy before implementation so instrumentation stays consistent
- Make the implementation movable into a dedicated telemetry Worker later

## Non-Goals

- Session replay
- Keystroke tracking
- User-level support/debug inspection
- Revenue/billing analytics
- Recording note/task/calendar/inbox content
- Recording raw search queries, URLs, file paths, folder names, note titles, task titles, or emails
- Long-term raw event retention beyond Workers Analytics Engine retention
- Perfect fraud resistance; telemetry is a product signal, not a billing source of truth

## External Constraints

- Workers Analytics Engine datasets are created automatically after a Worker binding writes events:
  <https://developers.cloudflare.com/analytics/analytics-engine/get-started/>
- Workers Analytics Engine is intended for custom product/business metrics and can be queried by
  SQL or visualized in Grafana:
  <https://developers.cloudflare.com/workers/observability/metrics-and-analytics/>
- Grafana can query Workers Analytics Engine through the Analytics Engine SQL API using the
  Altinity ClickHouse datasource:
  <https://developers.cloudflare.com/analytics/analytics-engine/grafana/>
- Workers Analytics Engine accepts up to 20 blobs, 20 doubles, and one index per datapoint; a
  Worker invocation can write up to 250 datapoints; retention is three months:
  <https://developers.cloudflare.com/analytics/analytics-engine/limits/>
- Queries must account for `_sample_interval`, especially counts and averages:
  <https://developers.cloudflare.com/analytics/analytics-engine/sampling/>

## Recommended Approach

Use the existing sync-server Worker as the telemetry ingest edge for v1:

```
Memry desktop
  -> main-process telemetry queue
  -> POST /telemetry/batch
  -> apps/sync-server Cloudflare Worker
  -> Workers Analytics Engine dataset
  -> Grafana dashboards
```

This is fastest because the repo already deploys `apps/sync-server` to Cloudflare Workers, with
D1, R2, route tests, rate limiting, and environment-specific Wrangler config. The telemetry route
must be isolated enough that it can later move to a dedicated `memry-telemetry` Worker without
changing desktop event names or Grafana queries.

## Alternatives Considered

### Approach A: Sync-Server Worker + Workers Analytics Engine

**Pros:** fastest to ship, no new service, Cloudflare-native, Grafana-compatible, no raw event D1
table, works for anonymous users.

**Cons:** public unauthenticated telemetry traffic shares the sync-server Worker. Must keep rate
limits, validation, and route boundaries tight.

**Decision:** Use this for v1.

### Approach B: Dedicated Telemetry Worker + Workers Analytics Engine

**Pros:** cleanest blast-radius boundary, easier independent rate limiting and scaling, no coupling
to sync-server secrets or deploys.

**Cons:** extra deployment surface and duplicated Worker plumbing before launch.

**Decision:** Defer. Keep v1 route/service boundaries compatible with this split.

### Approach C: Third-Party Product Analytics

**Pros:** faster dashboard UX, funnels/cohorts out of the box.

**Cons:** weaker privacy posture, another vendor/data processor, often identity-first, less aligned
with local-first/no-signup users.

**Decision:** Do not use for day one.

### Approach D: Store Raw Events in D1

**Pros:** simple SQL, long retention if volumes stay low.

**Cons:** wrong scaling shape for raw analytics, easy to over-retain sensitive metadata, harder
high-cardinality time-series usage.

**Decision:** Do not store raw events in D1. Use D1 only for rate limits and optional daily rollups.

## Privacy Model

### Identity

- Desktop generates a random `telemetryInstallId` on first launch.
- It is stored in Electron `app.getPath('userData')`, not inside a vault and not synced.
- Desktop sends the raw install ID only to Memry's telemetry endpoint.
- The Worker derives `anonInstallHash = HMAC_SHA256(TELEMETRY_HMAC_KEY, telemetryInstallId)`.
- Workers Analytics Engine stores only the derived hash as `index1`, never the raw install ID.
- `sessionId` resets every app launch and is also HMAC-hashed server-side before storage.

This is pseudonymous telemetry, not true anonymity. It supports retention/cohort analysis while
avoiding emails, account IDs, vault paths, and content. If a user disables telemetry, the client
stops sending events and flushes the local queue.

### Consent and Control

- Default for production: telemetry enabled with a visible privacy note in first-run onboarding.
- Settings includes a `Share anonymous usage metrics` toggle.
- Toggling off immediately stops collection and drops queued events.
- Development/test builds default telemetry off unless explicitly enabled with env.

### Denylist

The following are never allowed in telemetry payloads:

- Note, journal, task, project, calendar, inbox, folder, tag, or property names
- Note body, journal body, task descriptions, calendar descriptions, inbox text, transcriptions
- Search queries
- URLs, domains, file paths, image filenames, attachment filenames, vault paths
- Email addresses, OAuth provider account IDs, recovery keys, public/private key material
- Raw device IDs, raw user IDs, raw install IDs, IP addresses
- Clipboard contents or selected text

### Allowed Dimensions

Only low-risk enums and coarse values are allowed:

- App version, build channel, schema version
- OS family, architecture, locale, timezone offset bucket
- Auth state: `anonymous`, `signed_in`, `signed_out`
- Sync state: `disabled`, `enabled`, `unknown`
- Surface: `app`, `onboarding`, `vault`, `notes`, `journal`, `tasks`, `inbox`,
  `calendar`, `search`, `graph`, `settings`, `sync`, `ai`, `voice`, `updater`
- Object type: `note`, `journal`, `task`, `project`, `inbox_text`, `inbox_link`,
  `inbox_image`, `inbox_voice`, `inbox_pdf`, `calendar_event`, `calendar_source`, etc.
- Result: `success`, `failed`, `canceled`, `skipped`
- Error code enum, not error message
- Counts, durations, queue sizes, payload byte sizes, result counts

## Event Contract

The canonical schema lives in `packages/contracts/src/telemetry-api.ts`.

```ts
type TelemetryEventName =
  | 'app_started'
  | 'app_backgrounded'
  | 'app_active_heartbeat'
  | 'onboarding_started'
  | 'onboarding_completed'
  | 'vault_created'
  | 'vault_opened'
  | 'page_viewed'
  | 'note_created'
  | 'note_opened'
  | 'note_updated'
  | 'note_deleted'
  | 'journal_opened'
  | 'journal_updated'
  | 'task_created'
  | 'task_completed'
  | 'task_reopened'
  | 'project_created'
  | 'inbox_captured'
  | 'inbox_filed'
  | 'inbox_archived'
  | 'inbox_snoozed'
  | 'search_opened'
  | 'search_performed'
  | 'search_result_opened'
  | 'calendar_event_created'
  | 'calendar_event_updated'
  | 'calendar_google_connected'
  | 'calendar_google_sync_completed'
  | 'graph_opened'
  | 'setting_changed'
  | 'sync_enabled'
  | 'sync_run_completed'
  | 'sync_error'
  | 'voice_recording_completed'
  | 'transcription_completed'
  | 'ai_action_completed'
  | 'app_error_seen'
```

Events are sent in batches:

```ts
type TelemetryBatch = {
  schemaVersion: 1
  installId: string
  sessionId: string
  appVersion: string
  buildChannel: 'development' | 'staging' | 'production'
  platform: 'darwin' | 'win32' | 'linux'
  arch: string
  locale: string
  timezoneOffsetMinutes: number
  authState: 'anonymous' | 'signed_in' | 'signed_out'
  syncState: 'disabled' | 'enabled' | 'unknown'
  events: TelemetryEvent[]
}

type TelemetryEvent = {
  id: string
  name: TelemetryEventName
  occurredAt: string
  surface: TelemetrySurface
  action: string
  objectType?: string
  source?: string
  result?: 'success' | 'failed' | 'canceled' | 'skipped'
  errorCode?: string
  dimensions?: Record<string, string>
  metrics?: {
    durationMs?: number
    itemCount?: number
    byteCount?: number
    queueCount?: number
    resultCount?: number
    retryCount?: number
    activeSeconds?: number
    value?: number
  }
}
```

Server-side validation rejects:

- unknown event names
- unknown surfaces/actions/object types
- unapproved dimension keys or values
- any dimension key, dimension value, or enum-like string that looks like a URL, path, email, UUID account ID, or long free-form text
- more than one dimension on a single event
- batch size greater than 100 events
- request body larger than 128 KB

## Workers Analytics Engine Mapping

Use one dataset per environment:

- development: `memry_product_telemetry_dev`
- staging: `memry_product_telemetry_staging`
- production: `memry_product_telemetry_production`

`index1`:

- `anonInstallHash`

`blobs`:

1. `event_name`
2. `schema_version`
3. `app_version`
4. `build_channel`
5. `platform`
6. `arch`
7. `locale`
8. `timezone_bucket`
9. `auth_state`
10. `sync_state`
11. `surface`
12. `action`
13. `object_type`
14. `source`
15. `result`
16. `error_code`
17. `dimension_key`
18. `dimension_value`
19. `session_hash`
20. `reserved`

`doubles`:

1. `event_count` = 1
2. `duration_ms`
3. `item_count`
4. `byte_count`
5. `queue_count`
6. `result_count`
7. `error_count`
8. `retry_count`
9. `active_seconds`
10. `value`
11. `batch_size`
12. `client_queue_depth`
13. `reserved`

All missing numeric fields write `0`. Grafana queries must use sampled-safe aggregation:

- Count: `SUM(_sample_interval * double1)`
- Average duration: `SUM(_sample_interval * double2) / SUM(_sample_interval)`
- Sum items: `SUM(_sample_interval * double3)`

## Metric Taxonomy

### North-Star Dashboard

**Purpose:** Is Memry being used, and where is value happening?

- Daily active installs
- Weekly active installs
- New installs
- Returning installs
- Activated installs: completed onboarding + created/opened a vault + created first meaningful item
- Median time to first value
- Events per active install
- Core action mix by surface
- Crash/error rate per active install
- Sync-enabled rate
- Anonymous vs signed-in usage split

### Activation and Onboarding

Events:

- `app_started`
- `onboarding_started`
- `onboarding_completed`
- `vault_created`
- `vault_opened`
- `note_created`
- `inbox_captured`
- `task_created`

Metrics:

- Install -> onboarding start
- Onboarding start -> onboarding complete
- Onboarding complete -> vault created/opened
- Vault created/opened -> first note/task/inbox capture
- Time to first meaningful action
- First meaningful action distribution
- Dropoff by onboarding step

### Retention and Engagement

Events:

- `app_started`
- `app_active_heartbeat`
- `page_viewed`
- core create/update/complete/capture events

Metrics:

- D1/D7/D30 retained installs
- Sessions per install
- Active minutes per session
- Surfaces touched per session
- Power-user distribution: installs with 3+ surfaces used in a week
- New vs returning active installs

### Navigation and Surface Adoption

Events:

- `page_viewed`
- `graph_opened`
- `search_opened`
- `setting_changed`

Metrics:

- Surface visits by day
- First surface after app open
- Surface sequence from onboarding
- Settings adoption by group/key
- Graph/search discovery rate

### Notes and Journal

Events:

- `note_created`
- `note_opened`
- `note_updated`
- `note_deleted`
- `journal_opened`
- `journal_updated`
- `setting_changed` for editor settings

Allowed dimensions:

- note type: `note`, `journal`
- source: `sidebar`, `shortcut`, `inbox_conversion`, `calendar`, `template`, `unknown`
- editor width, toolbar mode, spellcheck boolean

Metrics:

- Notes created per active install
- Notes opened per session
- Journal entries opened/updated
- Notes created from inbox vs scratch
- Editor setting adoption
- Update duration buckets, not content size beyond coarse byte counts if needed

### Tasks and Projects

Events:

- `task_created`
- `task_completed`
- `task_reopened`
- `project_created`
- `setting_changed` for task settings

Allowed dimensions:

- source: `quick_capture`, `task_page`, `note_block`, `calendar`, `inbox_conversion`
- task priority bucket
- has due date: `true` / `false`
- project state: `default`, `custom`

Metrics:

- Tasks created/completed per day
- Completion rate
- Reopen rate
- Due-date adoption
- Project adoption
- Task source mix

### Inbox and Capture

Events:

- `inbox_captured`
- `inbox_filed`
- `inbox_archived`
- `inbox_snoozed`
- `voice_recording_completed`
- `transcription_completed`

Allowed dimensions:

- capture type: `text`, `link`, `image`, `voice`, `clip`, `pdf`
- filing action: `note`, `task`, `archive`, `snooze`
- suggestion result: `accepted`, `rejected`, `unused`
- transcription provider: `local`, `openai`
- result: `success`, `failed`, `canceled`

Metrics:

- Captures by type
- Capture success/failure rate
- Capture -> file/archive/snooze conversion
- Time from capture to filed
- Suggestion acceptance
- Voice/transcription success and latency

### Search, Graph, and Discovery

Events:

- `search_opened`
- `search_performed`
- `search_result_opened`
- `graph_opened`

Allowed dimensions:

- source search type: `quick`, `command_palette`, `global`
- dimension result bucket: `zero`, `one_to_five`, `six_plus`
- result opened type: `note`, `journal`, `task`, `inbox`
- graph depth bucket, not node labels

Metrics:

- Search usage per active install
- Zero-result rate
- Search result open rate
- Graph open rate
- Graph-to-item open rate

### Calendar and Integrations

Events:

- `calendar_event_created`
- `calendar_event_updated`
- `calendar_google_connected`
- `calendar_google_sync_completed`

Allowed dimensions:

- source: `calendar_page`, `day_panel`, `task`, `inbox_snooze`, `google`
- provider: `local`, `google`
- sync result: `success`, `failed`, `skipped`
- error code enum

Metrics:

- Calendar event creation
- Google Calendar connect rate
- Google Calendar sync success/failure rate
- Imported vs Memry-created events
- Calendar action source mix

### Sync, Signup, and Reliability

Events:

- `sync_enabled`
- `sync_run_completed`
- `sync_error`
- `app_error_seen`
- auth-specific events added only with non-identifying state

Allowed dimensions:

- auth state
- source sync operation: `push`, `pull`, `full`, `crdt`
- dimension transport: `record`, `crdt`
- error code enum

Metrics:

- Sync-enabled install share
- Sync run success rate
- Push/pull item counts
- Queue size trends
- Conflict/replay/quota rejection rates
- Error rate by app version and platform

## Dashboards

### Grafana: Product Overview

- Active installs: daily/weekly
- Activation funnel
- Time to first value
- Core action mix
- Anonymous vs signed-in split
- Errors per 100 active installs

### Grafana: Feature Adoption

- Surface visits
- Notes/journal/tasks/inbox/calendar/search/graph weekly adoption
- Feature co-usage matrix
- Settings adoption

### Grafana: Capture and Inbox

- Capture type distribution
- Capture success rate
- File/archive/snooze outcomes
- Time to file
- Transcription success and latency

### Grafana: Sync and Reliability

- Sync-enabled share
- Sync runs by transport
- Sync success/error rates
- Queue size and batch counts
- App error rate by version/platform

### Grafana: Retention

- D1/D7/D30 cohorts
- Returning installs by first value action
- Weekly usage depth buckets

## Error Handling

Desktop:

- Telemetry enqueue is in-memory plus small persisted queue.
- Flush is best-effort on interval, app background, and app shutdown.
- Network failures keep a bounded queue, then drop oldest events.
- Telemetry errors are logged with `createLogger('Telemetry')`, never surfaced to users.
- Telemetry never retries aggressively; use exponential backoff with jitter.

Worker:

- Invalid payloads return 400.
- Oversized batches return 413.
- Rate limit returns 429.
- Analytics Engine write failures return 202 if validation succeeded but write failed after
  response scheduling is best-effort; log the failure for Worker observability.
- No telemetry event should touch D1 except rate limiting or future rollups.

## Testing

### Contract Tests

- Zod accepts every event in the allowlist
- Zod rejects unknown events, unknown dimensions, free-form long values, URLs, paths, emails
- Batch max size and required metadata validated

### Worker Tests

- `POST /telemetry/batch` accepts a valid anonymous batch and calls `writeDataPoint`
- Worker hashes install/session IDs before writing
- Worker does not write raw install ID, session ID, IP, or free-form content
- Unknown events/dimensions are rejected
- Batch size and body size limits are enforced
- Rate limiter is wired
- Wrangler config exposes `PRODUCT_TELEMETRY` per environment

### Desktop Main Tests

- Install ID is generated once, persisted in userData, and reused
- Telemetry queue batches and flushes with `net.fetch`
- Opt-out disables collection and clears pending queue
- Flush failure is swallowed and logged
- Batch payload includes app/platform/session context

### Renderer Tests

- `trackTelemetry` does not throw when IPC fails
- First-run onboarding completion emits only allowed dimensions
- Page navigation emits surface enum, not titles or routes containing IDs

### Integration / Manual

- Run sync-server locally and post a sample telemetry batch
- Query Workers Analytics Engine with `SHOW TABLES`
- Verify a Grafana panel using sampled-safe count query
- Confirm production build has telemetry endpoint configured

## Rollout

1. Ship server ingestion and no-op desktop client disabled by default in non-production.
2. Enable production telemetry for app lifecycle, onboarding, vault, and navigation.
3. Add core product surface events.
4. Add Grafana dashboards and saved sampled-safe queries.
5. Add optional daily rollups to D1/R2 only if three-month raw retention is not enough.

## Open Questions

- Exact product copy for the first-run telemetry notice.
- Whether production should default to opt-out or ask on first run before sending the first event.
- Whether to move telemetry into a dedicated Worker before public launch or after the first metrics
  are flowing.
