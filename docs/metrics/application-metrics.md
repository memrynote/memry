# Application Metrics

Privacy-preserving product telemetry for Memry. Implementation lives in:

- `packages/contracts/src/telemetry-api.ts` — canonical event/batch schema
- `apps/sync-server/src/routes/telemetry.ts` — public `POST /telemetry/batch`
- `apps/sync-server/src/services/telemetry.ts` — Workers Analytics Engine mapping
- `apps/desktop/src/main/telemetry/` — install ID, queue, batching, runtime
- `apps/desktop/src/renderer/src/lib/telemetry.ts` — safe renderer wrapper

## Privacy Rules

The telemetry pipeline is engineered to never accept or store user content. The
following are denied at every layer (contract schema, server validation, renderer
wrapper):

- Note, journal, task, project, calendar, inbox, folder, tag, or property names
- Search queries
- URLs, file paths, image filenames, attachment filenames, vault paths
- Email addresses, OAuth identifiers, recovery keys, public/private key material
- Raw device IDs, raw user IDs, raw install IDs, IP addresses
- Clipboard contents and selected text

`installId` and `sessionId` are sent in plain over TLS to Memry's telemetry
endpoint and are HMAC-hashed inside the Worker before any persistence. Workers
Analytics Engine only ever stores derived hashes.

## Event Dictionary

Every event is one of the following names. Adding a new name requires a contract
change in `packages/contracts/src/telemetry-api.ts`.

### App lifecycle

| Event | Surface | Action | Notes |
| ----- | ------- | ------ | ----- |
| `app_started` | `app` | `started` | Emitted by the runtime once after init when telemetry is enabled |
| `app_backgrounded` | `app` | `backgrounded` | Reserved for future use |
| `app_active_heartbeat` | `app` | `heartbeat` | Reserved for future use |
| `app_error_seen` | `app` | `error_seen` | Reserved for fatal renderer errors |

### Onboarding & activation

| Event | Surface | Action |
| ----- | ------- | ------ |
| `onboarding_started` | `onboarding` | `started` |
| `onboarding_completed` | `onboarding` | `completed` |
| `vault_created` | `vault` | `created` |
| `vault_opened` | `vault` | `opened` |

Allowed `source` values for vault events: `select`, `switch`, `auto_open`, `create`.

### Navigation

| Event | Surface | Action |
| ----- | ------- | ------ |
| `page_viewed` | one of `inbox`, `journal`, `notes`, `tasks`, `calendar`, `graph`, `search`, `settings` | `viewed` |

The renderer only emits the surface enum for navigation. It never includes route
fragments, IDs, or titles.

### Notes & journal

| Event | Surface | Action |
| ----- | ------- | ------ |
| `note_created` | `notes` | `created` |
| `note_opened` | `notes` | `opened` |
| `note_updated` | `notes` | `updated` |
| `note_deleted` | `notes` | `deleted` |
| `journal_opened` | `journal` | `opened` |
| `journal_updated` | `journal` | `updated` |

### Tasks & projects

| Event | Surface | Action |
| ----- | ------- | ------ |
| `task_created` | `tasks` | `created` |
| `task_completed` | `tasks` | `completed` |
| `task_reopened` | `tasks` | `reopened` |
| `project_created` | `tasks` | `created` |

### Inbox & capture

| Event | Surface | Action | Allowed dimensions |
| ----- | ------- | ------ | ------------------ |
| `inbox_captured` | `inbox` | `captured` | `capture_type` ∈ `text`, `link`, `image`, `voice`, `clip`, `pdf` |
| `inbox_filed` | `inbox` | `filed` | — |
| `inbox_archived` | `inbox` | `archived` | — |
| `inbox_snoozed` | `inbox` | `snoozed` | — |
| `voice_recording_completed` | `voice` | `recording_completed` | reserved |
| `transcription_completed` | `voice` | `transcription_completed` | reserved |

### Search, graph, discovery

| Event | Surface | Action | Allowed dimensions |
| ----- | ------- | ------ | ------------------ |
| `search_opened` | `search` | `opened` | — |
| `search_performed` | `search` | `queried` | `search_type` ∈ `quick`, `global`; `result_bucket` ∈ `zero`, `one_to_five`, `six_plus` |
| `search_result_opened` | `search` | `result_opened` | reserved |
| `graph_opened` | `graph` | `opened` | reserved |

### Calendar & integrations

| Event | Surface | Action |
| ----- | ------- | ------ |
| `calendar_event_created` | `calendar` | `created` |
| `calendar_event_updated` | `calendar` | `updated` |
| `calendar_google_connected` | `calendar` | `connected` |
| `calendar_google_sync_completed` | `calendar` | `sync_completed` |

### Sync & reliability

| Event | Surface | Action | Dimensions |
| ----- | ------- | ------ | ---------- |
| `sync_enabled` | `sync` | `enabled` | — |
| `sync_run_completed` | `sync` | `push_completed`/`pull_completed`/`full_completed` | `operation` ∈ `push`, `pull`, `full`, `crdt`; `transport` ∈ `record`, `crdt` |
| `sync_error` | `sync` | `push_failed`/`pull_failed`/`full_failed` | `operation`, `transport`, plus `errorCode` enum |

### AI & settings

| Event | Surface | Action |
| ----- | ------- | ------ |
| `ai_action_completed` | `ai` | `completed` |
| `setting_changed` | `settings` | `changed` |

## Allowed Numeric Metrics

`event.metrics` may contain only the following non-negative finite numbers:

- `durationMs`
- `itemCount`
- `byteCount`
- `queueCount`
- `resultCount`
- `retryCount`
- `activeSeconds`
- `value`

The batch envelope additionally carries `clientQueueDepth` (server-side only;
not free-form).

## Validation Layers

Every event passes through three layers of validation before reaching the
analytics dataset:

1. **Renderer** (`apps/desktop/src/renderer/src/lib/telemetry.ts`) — strips
   dimension values that look like emails, URLs, or paths; wraps every IPC call
   in a try/catch that always resolves.
2. **Main process queue** — accepts only `TelemetryEvent` values that match the
   shared schema; events from a disabled session are dropped before they reach
   the queue.
3. **Worker route** — re-validates with `TelemetryBatchSchema.safeParse` and
   rejects unknown events, unknown surfaces, free-form long values, oversized
   batches (> 100 events), and oversized bodies (> 128 KB).

## Workers Analytics Engine Mapping

The Worker writes one datapoint per event. Mapping documented in
`apps/sync-server/src/services/telemetry.ts` and exercised by
`apps/sync-server/src/services/telemetry.test.ts`.

- `index1` = `anonInstallHash` (HMAC-SHA256 of the install ID)
- 20 blob slots (event_name, schema_version, app_version, build_channel,
  platform, arch, locale, timezone_bucket, auth_state, sync_state, surface,
  action, object_type, source, result, error_code, dimension_key,
  dimension_value, session_hash, reserved)
- 13 double slots (event_count, duration_ms, item_count, byte_count,
  queue_count, result_count, error_count, retry_count, active_seconds, value,
  batch_size, client_queue_depth, reserved)

## Datasets

| Environment | Dataset name |
| ----------- | ------------ |
| Development | `memry_product_telemetry_dev` |
| Staging | `memry_product_telemetry_staging` |
| Production | `memry_product_telemetry_production` |

## Rollout Checklist

Before publishing a new event:

- [ ] Add the event name to `TelemetryEventNameSchema`
- [ ] Decide the surface and action enum
- [ ] Decide the allowed dimensions (must match `SAFE_DIMENSION_VALUE`)
- [ ] Update this document and the Grafana cookbook
- [ ] Add a focused unit test asserting the event is emitted
- [ ] Verify the event in `memry_product_telemetry_staging` first

## Out-of-scope (denied) Examples

The following are intentionally not allowed and will be rejected by the schema:

- `dimensions: { url: 'https://example.com' }` — value matches the URL guard
- `dimensions: { email: 'user@example.com' }` — value matches the email guard
- `dimensions: { folder: '/Users/me/notes' }` — value matches the path guard
- `action: 'open/note'` — action contains a slash
- Any `dimensions` value longer than 64 characters
