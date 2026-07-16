# Observability & Telemetry

Local logs for debugging plus a switchable, content-free telemetry stream for product metrics,
launch diagnostics, and sanitized errors.

## Logging

Use `createLogger(scope)` from electron-log everywhere in the desktop app:

```ts
import { createLogger } from '@/lib/logger'
const log = createLogger('Sync')
log.info('pull complete', { count, durationMs })
log.error('pull failed', err)
```

- **Never** use `console.*`. A pre-commit hook flags it.
- Logs land in the OS-standard log directory and rotate automatically.
- Renderer and main process logs are separate files.
- Dev runs log at `debug`; packaged installs are lowered to `info` (file) / `warn` (console) at
  startup based on `app.isPackaged`, since `NODE_ENV` is undefined at runtime in packaged builds.
- Important launch, renderer, and main-process errors are mirrored as telemetry events when
  product telemetry is enabled.

### Log Locations

| Platform | Path                                            |
| -------- | ----------------------------------------------- |
| macOS    | `~/Library/Logs/memrynote/`                     |
| Windows  | `%USERPROFILE%/AppData/Roaming/memrynote/logs/` |
| Linux    | `~/.config/memrynote/logs/`                     |

## Telemetry

Telemetry is enabled by default in production builds and off by default in development builds.
Users can turn it off via [Settings → General → Privacy](/user-guide/settings#general).

The build channel comes from `MEMRY_ENV` when set (dev/staging profiles) and otherwise from
`app.isPackaged`, so packaged installs report `production`. A telemetry choice the user has
already saved always wins over the channel default.

### What Ships

Only enums and event metadata:

```ts
trackTelemetry('page_viewed', { surface: 'notes', action: 'viewed' })
```

Recognized surfaces (`TelemetrySurface` in `packages/contracts/telemetry-api`):

`app`, `home`, `onboarding`, `vault`, `notes`, `journal`, `tasks`, `inbox`, `calendar`, `search`,
`graph`, `settings`, `sync`, `ai`, `voice`, `updater`.

### What Never Ships

- Note content
- Note titles
- Identifiers (note IDs, task IDs, project IDs)
- Search queries
- Tag names
- User file paths and note filenames
- Exception messages (a desktop error message can embed a note title or content)

The contract uses string-typed enums for surfaces and actions; arbitrary strings can't sneak
through. The one exception is error diagnostics, which additionally ship a redacted **stack trace**
of code locations (never the message) — see [Error Reporting](#error-reporting).

## Tracking Pattern

All telemetry calls are fire-and-forget — never `await`:

```ts
void trackTelemetry('onboarding_completed', {
  surface: 'onboarding',
  action: 'completed',
  result: 'success'
})
```

The `void` makes the call non-blocking and unfailable from the UI's point of view.

## Event Categories

| Category        | Events                                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Surface views   | `page_viewed` — one per active-tab change; carries the tab type as `objectType`                                                  |
| App lifecycle   | `app_started`, `app_backgrounded`, `app_active_heartbeat`, `app_update_installed`                                                |
| Onboarding      | `onboarding_started`, `onboarding_completed`                                                                                     |
| Vault           | `vault_created`, `vault_opened`                                                                                                  |
| Notes           | `note_created`, `note_opened`, `note_updated` (throttled 1/doc/5 min), `note_deleted`                                            |
| Journal         | `journal_opened`, `journal_updated` (throttled 1/doc/5 min)                                                                      |
| Tasks           | `task_created`, `task_completed`, `task_reopened`, `project_created`                                                             |
| Inbox           | `inbox_captured`, `inbox_filed`, `inbox_archived`, `inbox_snoozed`                                                               |
| Calendar        | `calendar_event_created`, `calendar_event_updated`, `calendar_google_connected`, `calendar_google_sync_completed`                |
| Search          | `search_performed`, `search_result_opened` (`search_opened` is defined but unused — it would duplicate `command_palette_opened`) |
| Command palette | `command_palette_opened`, `search_result_opened` (palette context)                                                               |
| Graph           | `graph_opened` — on graph page mount                                                                                             |
| Voice           | `voice_recording_completed` (duration + bytes), `transcription_completed` (success/failure + processing duration)                |
| Settings        | `setting_changed` — surface only, never the value                                                                                |
| Agent chat      | `agent_chat_started`, `agent_chat_message_sent`, `ai_action_completed` (turn result + duration)                                  |
| Sync health     | `sync_enabled`, `sync_run_completed`, `sync_error` (counts/status only)                                                          |
| Auth            | `signin_started`, `signin_succeeded`                                                                                             |
| Diagnostics     | `app_log_recorded`, `app_error_seen`, `app_launch_phase_completed`                                                               |

## Analytics Engine Export

Cloudflare Analytics Engine is the sole telemetry store. The sync server writes each accepted
desktop event as one datapoint into the `memry_product_telemetry_{env}` dataset (binding
`PRODUCT_TELEMETRY`) using a fixed 20-blob / 13-double layout. Server-side business and error
events write to the same dataset with the same layout, tagged `platform` = `surface` = `server`,
so a single Grafana query reads every event.

No raw identifiers are stored: the install ID is HMAC-hashed server-side (`TELEMETRY_HMAC_KEY`)
and used as the datapoint index, so active-install and retention queries work without exposing
local identifiers; session IDs are likewise hashed. Telemetry batches are anonymous — no account
identity is attached.

Dashboards live in self-hosted Grafana (`/d/memry-product-telemetry`), which queries the
Analytics Engine SQL API through the Infinity datasource.

Additional events in the same pipeline:

| Event                        | Source                                    |
| ---------------------------- | ----------------------------------------- |
| `app_launch_phase_completed` | Electron main/renderer startup milestones |
| `app_log_recorded`           | Sanitized desktop diagnostic breadcrumbs  |
| `app_error_seen`             | Renderer, React boundary, and main errors |
| `server_error_seen`          | Sync-server request/background failures   |
| `server_log_recorded`        | Structured sync-server diagnostic logs    |

### Batch Validation & Retry

Each `/telemetry/batch` payload is schema-validated on the sync server. A malformed batch is
rejected with `400 VALIDATION_ERROR`. The server logs the failing field paths (Zod path + issue
code only — never the field values, which may hold the raw identifiers the schema is designed to
strip) so rejections are diagnosable without leaking data.

The desktop client treats a permanent `4xx` (any `4xx` except `429`) as unrecoverable and drops
that batch, so one malformed event cannot wedge the queue head and replay the same rejected batch
on every flush. Transient failures — `5xx`, `429`, and network errors — leave the batch queued for
a later retry.

### Autosave Event Throttling

`note_updated` and `journal_updated` events fired by the autosave path are throttled to at most
one emission per document per 5-minute window (in-memory, resets on restart). This prevents
high-frequency editor flushes from inflating event counts.

## Landing Site Telemetry

The marketing site (`apps/landing`) sends anonymous web events to the rate-limited, unauthenticated
`POST /telemetry/web` endpoint, which writes them to a dedicated Analytics Engine dataset
(`memry_landing_telemetry_{env}`, binding `LANDING_TELEMETRY`).

- **Client**: `trackLandingEvent` / `trackLandingPageView` in `apps/landing/src/lib/analytics.ts`
  post via `navigator.sendBeacon` (falling back to `fetch` with `keepalive`), fire-and-forget, and
  swallow all errors. A random UUID visitor id persists in `localStorage`.
- **Payload** (`LandingTelemetryBatchSchema` in `packages/contracts/telemetry-api`): fixed
  slug-like event names, path-only pages, slug targets, and bounded UTM params. The schema rejects
  anything shaped like an email, URL, filesystem path, or raw identifier; query strings and hashes
  are stripped client-side and again server-side.
- **Datapoint layout**: `blob1`=name, `blob2`=page, `blob3`=target, `blob4`–`blob8`=utm_source /
  medium / campaign / content / term, `double1`=1 (count), `index1`=HMAC of the visitor id
  (`TELEMETRY_HMAC_KEY`) so distinct-visitor queries never see a raw id.

## Error Reporting

Desktop error reporting follows the same product telemetry setting. Each captured error ships
stable metadata — process area, component/source, action, phase, and the error's code
(`errorCode`, a typed code where one exists — see [Vault File Errors](#vault-file-errors)) — plus
a **redacted stack trace** and, for React boundaries, the component stack.

`errorCode` prefers a **typed code the error carries** over its class name: a richer
`telemetryCode` (`NoteError`'s note error code plus the originating errno, see
[Vault File Errors](#vault-file-errors)), then a plain `.code` (better-sqlite3's `error.code`, a
Node system code), walking the `cause`/`AggregateError.errors` chain to a bounded depth so a
`fetch failed` `TypeError` still surfaces the underlying `ECONNREFUSED`. A note write failure
therefore reports `NOTE_WRITE_FAILED:EBUSY` rather than collapsing every note fault to `NoteError`,
and a locked database reports `SQLITE_BUSY` rather than an un-triageable `SqliteError`. A code is
only trusted when it looks like an enum token (`^[A-Za-z][A-Za-z0-9_.:-]{0,63}$`); anything else — a
path, an email, a URL, free-form prose — is **rejected outright** and the class name is used
instead, because a character-substituted path (`_Users_kaan_secret.md`) still leaks its structure.
The class name itself still passes through the safe-token rules (no `@`, `://`, `/`, `\`, ≤64 chars).

An **unhandled rejection** can carry any value as its reason — a string, a plain object, or a
cross-realm `Error` that fails `instanceof Error` — and those carry no stack, which previously
landed in Loki as an unactionable bare `Error` with an empty stack. Reasons are normalized before
reporting: a real `Error` passes through, a cross-realm error's own frames are adopted, and
anything else gets a stack synthesized at the handler plus a code naming the reason's type
(`Rejection_string`, `Rejection_Object`, `Rejection_undefined`). The reason's message or value is
never copied — only its shape.

The free-form exception **message is never sent**: on the desktop it can embed a note title,
filename, or content. The stack is reduced to code-location frames only — the leading
`Name: message` header line is stripped — so a crash shows up as, for example, `TypeError` at
`pushRecords (…/sync-engine.js:120)`: the source location, never the note. Frame file paths are
app source/bundle locations (not user files); any home-directory prefix (`/Users/<name>`,
`C:\Users\<name>`) is rewritten to `~`, and emails, UUIDs, JWTs, and bearer tokens are scrubbed
from anything that ships.

### Vault File Errors

A class name alone is often too coarse to act on: every failed note save reported `NoteError`,
which cannot tell an antivirus or cloud-sync file lock apart from a full disk. `NoteError`
therefore carries the originating fs error as its `cause`, and reports a composite `errorCode` of
its note error code plus the errno — for example `NOTE_WRITE_FAILED:EBUSY` (locked) versus
`NOTE_WRITE_FAILED:ENOSPC` (out of space). The errno is admitted by a strict allowlist
(`/^E[A-Z0-9]+$/`), so **the vault file path is never part of the code** — paths are user data and
stay out of telemetry, as above.

Writes to a locked file are retried a bounded number of times before failing (see
`withTransientFsRetry` in `main/vault/file-ops.ts`). Each retry is written to the local log with
its errno and attempt number — again never the path — so a slow or failed save is explainable from
a user's log file even when telemetry is switched off.

Sync-server error reporting is server-side. Because the sync server is end-to-end-blind (it only
ever holds ciphertext), its own error strings are operational: the redacted message and stack ship
to Cloudflare Workers logs and Loki (never to Analytics Engine, which only gets the coded
`server_error_seen` datapoint); this is what makes sync failures debuggable. Server errors are
attributed to the signed-in `userId` (HMAC-hashed in Analytics Engine, plus device and vault ids
in the log detail) so a failure can be traced to the account that hit it. Dynamic path segments
and query strings are normalized away. Expected handled `4xx` responses (e.g.
`SYNC_PAYMENT_REQUIRED`) are still counted as `server_error_seen` but are logged at `warn` rather
than `error` level, keeping the error dashboards focused on real failures.

## Error Logs in Grafana (Loki)

Error events also become searchable **log lines** in Grafana, backed by a Loki instance running
next to Grafana on the observability VPS. Analytics Engine stays the canonical metrics store;
Loki adds the diagnostic detail (stacks, operational messages) that AE rows deliberately omit.

- **Transport**: the sync server pushes log lines to Loki's push API at
  `{LOKI_URL}/loki/api/v1/push`, guarded by a reverse-proxy bearer token (`LOKI_TOKEN`). Pushes
  are fire-and-forget in `waitUntil`: a missing config (local dev) is a silent no-op, and a
  failed push can never affect request handling. Loki's query endpoints are not exposed
  publicly — Grafana reads Loki over the private docker network.
- **Desktop errors**: `/telemetry/batch` events carrying an `errorCode` or `error` detail are
  forwarded as `app="desktop"` lines containing the event name, error code, surface/action/source,
  app version, platform, the **redacted stack frames only** (the schema has no message field —
  messages can embed note content; see Error Reporting above), `log_action` — the operational
  breadcrumb that keeps log-type error events (which carry no stack of their own) identifiable in
  Grafana — and `exit_code`, the platform exit status for process-lifecycle events (empty string
  when absent, since exit code `0` is itself meaningful). Labels stay low-cardinality
  (`app`/`env`/`level`) — everything else lives inside the JSON line.
- **Process lifecycle**: the main process reports a `child-process-gone` fault with a composite
  `type:reason:name` error code (e.g. `Utility:crashed:Embeddings`). The worker label comes from
  Electron's `details.name`, **not** `details.serviceName`: Electron routes a fork's `serviceName`
  _option_ to `details.name`, while `details.serviceName` holds the Mojo interface name — a
  constant (`node.mojom.NodeService`) that is identical for every utility fork and so cannot tell
  our workers apart. A fork that passes no `serviceName` option reports the default
  `Node Utility Process`. The exit status rides along in the line's `exit_code` field rather than
  inside the error code, so crashes still group by worker in Grafana while the POSIX signal
  (11 SIGSEGV, 6 SIGABRT) stays visible. A utility worker's clean idle-shutdown (embeddings,
  image-processing, voice-model each exit after ~30s idle) is a lifecycle event, not a fault, so a
  `clean-exit` reason is skipped entirely — only a real fault produces an error event, mirroring
  the GPU crash guard. Note that `child_process_gone` is **not** throttled: the crash cadence is
  itself a diagnostic signal.
- **Embedding worker**: the embeddings bridge reports its own non-clean worker exits under
  `source="Embeddings"` with a `worker_exit_<phase>` breadcrumb, where phase is `starting`,
  `in_flight`, `idle_shutdown`, or `idle`. This is what separates a harmless teardown crash
  (`idle_shutdown` — the embedding was already delivered) from real user impact (`in_flight` — the
  user silently lost semantic-search indexing for that note). Embedding generation failures emit
  `embed_failed`, throttled to one event per 5-minute window because a broken worker would
  otherwise fail once per note edit.
- **Desktop IPC envelopes**: every `{ success: false }` error envelope produced by the IPC layer
  (`withErrorHandler` / `withDb`) also emits an `app_error_seen` event, throttled in-memory to one
  event per **action + error code** per minute so an error loop can't flood the telemetry queue.
  The key must discriminate: keyed by error name alone and shared across all handlers, one benign
  recurring `Error` masked a genuine different `Error` from another handler for the whole window.
  The expected `noVaultOpen` envelope is not tracked, and the envelope's user-facing `error`
  string (which may contain note-derived text) never leaves the process — only the error code and
  redacted stack frames ship.
- **Expected conditions**: some failures are normal states, not faults. They still surface to the
  UI as an error envelope, but the throw site marks them and error telemetry skips them, so they
  cannot drown real signal. Currently marked: an Ollama model-list fetch that is **refused**
  (`ECONNREFUSED` = Ollama is not running), and a **calendar OAuth timeout** (the user opened the
  consent screen and walked away). The suppression is deliberately narrow — a real Ollama
  misconfiguration (DNS failure, connection reset, or a bad HTTP status) is still reported.
- **Server errors**: `captureServerError` pushes its redacted detail (operational message, stack,
  normalized path, error/status codes) as `app="server"` lines — level `error` for 5xx/unhandled,
  `warn` for handled 4xx.
- **Beyond route handlers**: failures that never produce a failing HTTP response also reach Loki —
  scheduled cleanup-task failures (`source="cron"`), token-revoke failures during logout, Resend
  email send failures (`RESEND_SEND_FAILED`), and `UserSyncState` Durable Object alarm/websocket
  handler errors (`source="user_sync_state_do"`, pushed directly via the Loki client since no
  route error handler ever sees them).
- **Labels** stay low-cardinality (`app`, `env`, `level`); everything else lives inside the JSON
  log line and is filtered in Grafana with `| json`.
- **Retention**: 30 days, enforced by the Loki compactor.
- **Dashboard**: `Memry — Logs` (`/d/memry-logs`) shows desktop/server error log panels and
  error-volume timeseries, with an `env` switch for production/staging. Ad-hoc digging and live
  tail happen in Grafana Explore against the Loki datasource.

## Server Configuration

Set these sync-server variables to enable Loki error-log shipping (unset in local dev, where
shipping is a no-op):

```bash
LOKI_URL=https://grafana.memrynote.com   # wrangler var
LOKI_TOKEN=...                           # wrangler secret (reverse-proxy bearer token)
```

## Performance

`trackTelemetry` is debounced and batched. Calls during the first second of startup are deferred
until after the vault is open so they never delay first paint. On the sync server, Analytics Engine
writes finish before `/telemetry/batch` responds, while Loki error-log pushes run in
`waitUntil` so log shipping cannot block the request path.
