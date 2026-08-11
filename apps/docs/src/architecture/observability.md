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

### Choosing a Level

The redacted diagnostic log stream is floored at `warn` (see
[Error Logs in Grafana (Loki)](#error-logs-in-grafana-loki)), so `warn` and `error` are the levels
an operator actually triages. Reserve them for conditions someone can act on, and log expected
steady states at `debug`:

- Certificate pinning falling back to standard TLS when no pins are configured
  (`main/sync/certificate-pinning.ts`) — a deliberate fallback, not a failure.
- `sodium_mlock` / `sodium_munlock` being absent in the WASM libsodium build
  (`main/crypto/memory-lock.ts`) — the expected state in Electron. An mlock/munlock call that
  is present but _fails_ still logs at `warn`.
- Progress notes the embedding worker writes to stderr, such as transformers.js reporting an
  unknown content-length during a model download (`main/lib/embeddings.ts`). A stderr chunk is
  only downgraded when every line in it matches a known-benign pattern, so a real failure
  interleaved with progress output still reaches `error`.

### Log Locations

| Platform | Path                                            |
| -------- | ----------------------------------------------- |
| macOS    | `~/Library/Logs/memrynote/`                     |
| Windows  | `%USERPROFILE%/AppData/Roaming/memrynote/logs/` |
| Linux    | `~/.config/memrynote/logs/`                     |

Older installs logged into an `@memry/desktop` directory (the raw package name). On startup the
main process moves those files into the directories above (a name collision gains a `legacy-`
prefix), then removes the emptied legacy directory. Dev profiles (`MEMRY_DEVICE`) log into a
per-device `memrynote-<device>` directory instead.

The same applies to the app identity as a whole: production launches adopt the `memrynote`
runtime app name and move userData (`Application Support/@memry/desktop` → `…/memrynote`,
leaving a compatibility symlink for downgraded binaries and stored absolute paths). The macOS
Safe Storage keychain item is copied to the new name so existing encrypted secrets keep
decrypting; on Linux a populated safeStorage store keeps the install on the legacy identity
(the keyring item cannot be carried over). See `src/main/app-identity.ts`.

### Launch Phase Timeline

`src/main/launch-timeline.ts` stamps each startup milestone's offset (ms) from process start and
emits them as **one** structured line, `launch timeline`, when the main window is revealed. Phases
are recorded with `recordLaunchPhase(phase)`, which also forwards each one as the per-phase
`app_launch_phase_completed` telemetry event.

| Field                                   | Meaning                                                    |
| --------------------------------------- | ---------------------------------------------------------- |
| `appReadyMs`                            | Electron `app.whenReady()` startup work finished           |
| `windowCreatedMs`                       | main `BrowserWindow` constructed                           |
| `vaultOpenStartMs` / `vaultOpenReadyMs` | vault restore started / reached `isOpen`                   |
| `rendererLoadedMs`                      | renderer `did-finish-load`                                 |
| `readyToShowMs`                         | first `ready-to-show` (absent when it never fired)         |
| `shownMs`                               | window actually revealed                                   |
| `reason`                                | `ready-to-show`, `fallback-timeout`, or `did-fail-load`    |
| `fallback`                              | `true` when the 10s reveal fallback fired                  |
| `vaultOpenPending`                      | vault open was still running at reveal — the prime suspect |

Vault-open timing stops at `isOpen`, not at the `autoOpenLastVault()` promise, which also waits on
the first full sync. A launch onto the vault picker records no vault phase at all.

The line is logged at `warn` when the reveal came from the fallback or took ≥5s — only `warn`/
`error` records reach the diagnostic log sink — and at `info` otherwise, so healthy launches stay
local instead of flooding the sink.

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
`graph`, `settings`, `sync`, `ai`, `voice`, `updater`, `canvas`, `projects`, `tags`.

### What Never Ships

- Note content
- Note titles
- Identifiers (note IDs, task IDs, project IDs)
- Search queries
- Tag names
- User file paths and note filenames
- Raw (unredacted) exception messages — a desktop error message can embed a note title or content

The contract uses string-typed enums for surfaces and actions; arbitrary strings can't sneak
through. The one exception is error diagnostics, which additionally ship a redacted **stack
trace** of code locations and, optionally, a message — but only after the client has run it
through `redactText` (`packages/contracts/src/redact.ts`), never the raw string — see
[Error Reporting](#error-reporting).

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

### Events Before the Runtime Exists

`trackMainEvent` used to no-op while `getTelemetryRuntime()` was still `null`, so anything that
failed during early startup — the app-identity migration, the Safe Storage keychain carry-over,
the GPU crash guard disabling hardware acceleration — was never reported. Early events are now
buffered in memory (`apps/desktop/src/main/telemetry/track.ts`, capped at 100 events) and
forwarded by `drainEarlyMainEvents()`, called from `main/index.ts` immediately after
`initializeTelemetryRuntime`. Each event keeps its original `occurredAt`. The buffer is set to
`null` once drained, so a runtime disposed during shutdown cannot quietly re-accumulate events
nobody will ever flush.

`registerMainDiagnostics()` is registered before any other startup work for the same reason — the
later call in the ready handler is an idempotent no-op — so a failure in the identity carry-over /
pending-install window still produces a report.

### Shutdown Drain

One flush sends at most `TELEMETRY_BATCH_LIMIT` events while a session can queue up to
`TELEMETRY_QUEUE_LIMIT`, so the previous single `flush('shutdown')` silently dropped everything
past the first batch. Shutdown now drains in bounded rounds
(`ceil(TELEMETRY_QUEUE_LIMIT / TELEMETRY_BATCH_LIMIT)`), stopping at the first failed round so an
offline quit never stalls the exit.

## Event Categories

| Category        | Events                                                                                                                                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Surface views   | `page_viewed` — one per active-tab change; carries the tab type as `objectType`                                                                                                                                                  |
| App lifecycle   | `app_started`, `app_backgrounded`, `app_active_heartbeat`, `app_update_installed`, `deep_link_opened` (coarse target only — `open`, `billing_start`, `billing_complete`, `billing`, `oauth`, `pair`, `unknown`; never the URL)   |
| Onboarding      | `onboarding_started`, `onboarding_completed`                                                                                                                                                                                     |
| Vault           | `vault_created`, `vault_opened`                                                                                                                                                                                                  |
| Notes           | `note_created`, `note_opened`, `note_updated` (throttled 1/doc/5 min), `note_deleted`, `note_imported`, `note_exported`                                                                                                          |
| Journal         | `journal_opened`, `journal_updated` (throttled 1/doc/5 min)                                                                                                                                                                      |
| Tasks           | `task_created`, `task_completed`, `task_reopened`, `task_updated`, `task_deleted`                                                                                                                                                |
| Projects        | `project_created`, `project_opened`, `project_updated`, `project_archived`, `project_deleted`, `project_item_linked`                                                                                                             |
| Tags            | `tag_created`, `tag_renamed`, `tag_deleted`, `tag_merged`, `tag_category_created`                                                                                                                                                |
| Canvas          | `canvas_created`, `canvas_opened`, `canvas_deleted`, `canvas_card_added`, plus the rollout counters `canvas_sync_conflict_copy`, `canvas_too_large`, `canvas_asset_uploaded`, `canvas_asset_dedup_hit`, `canvas_asset_gc_reaped` |
| Inbox           | `inbox_captured`, `inbox_filed`, `inbox_archived`, `inbox_snoozed`                                                                                                                                                               |
| Calendar        | `calendar_event_created`, `calendar_event_updated`, `calendar_event_deleted`, `calendar_google_connected`, `calendar_google_disconnected`, `calendar_google_sync_completed`                                                      |
| Import          | `import_completed`                                                                                                                                                                                                               |
| Home            | `home_board_customized`                                                                                                                                                                                                          |
| Search          | `search_performed`, `search_result_opened` (`search_opened` is defined but unused — it would duplicate `command_palette_opened`)                                                                                                 |
| Command palette | `command_palette_opened`, `search_result_opened` (palette context)                                                                                                                                                               |
| Graph           | `graph_opened` — on graph page mount                                                                                                                                                                                             |
| Voice           | `voice_recording_completed` (duration + bytes), `transcription_completed` (success/failure + processing duration)                                                                                                                |
| Settings        | `setting_changed` — surface only, never the value                                                                                                                                                                                |
| Agent chat      | `agent_chat_started`, `agent_chat_message_sent`, `ai_action_completed` (turn result + duration)                                                                                                                                  |
| Sync health     | `sync_enabled`, `sync_run_completed`, `sync_error` (counts/status only)                                                                                                                                                          |
| Auth            | `signin_started`, `signin_succeeded`                                                                                                                                                                                             |
| Diagnostics     | `app_log_recorded`, `app_error_seen`, `app_launch_phase_completed`, `app_crashed` (see [Crash & Unclean-Shutdown Detection](#crash-unclean-shutdown-detection))                                                                  |

## Crash & Unclean-Shutdown Detection

A hard crash — main-process abort, OOM kill, force quit — used to discard the in-memory telemetry
queue, so the crash itself never shipped: the classic "it crashed and there are no logs" report.
Two mechanisms fix that: a marker file that notices the crash, and a durable queue that keeps the
resulting event alive long enough to send.

A marker file (`apps/desktop/src/main/telemetry/crash-marker.ts`):

- `session-marker.json` is written into `userData` at startup with the session id, `startedAt`,
  `lastAliveAt`, and app version, then refreshed every 60s while the app is alive.
- `clearCrashMarker()` removes it once the shutdown cleanup chain completes.
- A marker still present at the **next** launch means the previous session died uncleanly, and
  that launch emits `app_crashed` on its behalf. Detection runs before the new session writes its
  own marker.

The marker's _presence_ is the signal; its contents only enrich the event. An unparseable marker
still reports the crash, just without the observed-uptime metric (`metrics.durationMs`, derived
from `lastAliveAt − startedAt`). The previous session's app version ships as a `prior_app_version`
dimension.

`errorCode` separates the failure modes:

| `errorCode`               | Meaning                                                                      |
| ------------------------- | ---------------------------------------------------------------------------- |
| `UNCLEAN_SHUTDOWN`        | no shutdown was attempted — hard crash, OOM kill, force quit                 |
| `SHUTDOWN_TIMEOUT`        | shutdown ran but the 5s cleanup timeout fired before the forced `app.exit()` |
| `SHUTDOWN_CLEANUP_FAILED` | the cleanup chain rejected                                                   |

The last two are stamped by `markShutdownFailure()` immediately before the forced exit: the log
line for that failure never flushes, but the marker survives to the next launch. Only the process
that wrote a marker may remove one — a second instance that loses the single-instance lock shares
`userData` and must not erase the primary's marker on its way out. Marker write failures are
logged and swallowed; a read-only disk must never break startup.

### Durable Queues

The marker only detects the crash — `app_crashed` still has to survive long enough to be sent, and
both telemetry queues flush on a 30s interval. A second hard crash inside that window would
otherwise take the crash report with it, which is why both queues mirror to `userData`
(`telemetry/queue-store.ts`):

| Queue                                      | Mirror                       | Carries                                     |
| ------------------------------------------ | ---------------------------- | ------------------------------------------- |
| Event queue (`telemetry/client.ts`)        | `telemetry-event-queue.json` | `app_crashed`, `app_error_seen`, all events |
| Log-ship queue (`telemetry/ship-queue.ts`) | `telemetry-log-queue.json`   | Path A redacted `warn`/`error` log lines    |

Every enqueue reaches disk before it returns, and the mirror is rewritten after every flush, so what
is on disk is what has not yet been accepted by the server. The next launch restores it and drains
it; a drained batch is removed from the mirror, so nothing is sent twice.

Rules the mirror follows:

- **Format** is a journal: a `{"version":2}` header line followed by one JSON item per line. An
  enqueue appends its own line rather than re-serialising the queue, which otherwise made each
  event cost a full rewrite of up to 500 objects — worst exactly during the error bursts and
  offline sessions that keep the queue pegged at its limit. The file is rewritten (compacted) on
  drains, on trims, and once the journal outgrows its bound, so it stays bounded.
- **Format changes cannot wedge startup.** The previous `{"version":1,"items":[…]}` format is still
  read, so an upgrading install keeps whatever its last session queued. A file whose version this
  build does not recognise is discarded rather than parsed, builds that predate the mirror never
  read it at all, and a build that predates the journal sees it as unparseable and discards it —
  so a downgrade costs one session's queue, never the launch.
- **Corruption is expected.** The mirror is most likely to be truncated by exactly the crash it was
  written to survive, so an unparseable file is logged, deleted, and treated as empty.
- **Write failures are non-fatal.** A read-only or full disk costs durability, never logging or
  shutdown; the failure is logged once per streak rather than once per line.
- **The limit applies to the restored set too** (`TELEMETRY_QUEUE_LIMIT` / `SHIP_QUEUE_LIMIT`), so a
  mirror written by a build with a larger limit cannot resurrect an unbounded queue.
- **Opting out deletes the mirror.** Turning telemetry off clears the file, not just the in-memory
  queue, and a launch that starts with telemetry disabled discards the mirror instead of restoring
  it.

Restored events keep their own `occurredAt`; the batch envelope is stamped with the session that
ships them, so an event resurrected from a dead session is attributed to the launch that sent it.

### Native Crash Dumps

`crashReporter.start({ uploadToServer: false })` runs before `app.ready`, so main, renderer, and
utility processes all write minidumps for native crashes that no JS handler ever observes. The
dumps stay in `app.getPath('crashDumps')` for the Path B diagnostic bundle the user submits
deliberately. **`uploadToServer` must stay `false`**: a minidump is raw process memory — PostHog
does not ingest minidumps, and there is no way to redact one, so uploading would breach the
redaction model every other telemetry path is built around.

## PostHog Event Capture

PostHog is the sole telemetry store (`POSTHOG_HOST`, `https://us.i.posthog.com` by default). The
sync server transforms each accepted desktop event into a PostHog event
(`services/posthog-transform.ts`) and posts it to the PostHog capture API's `/batch/` endpoint
(`services/posthog.ts`, `capturePostHogEvents`). Event names are preserved from the existing
50-event contract, with one rename: `page_viewed` → `$pageview`, which unlocks PostHog's native
path-analysis and web-analytics views. Batch metadata (platform, arch, locale, app version, build
channel, sync state, timezone offset) becomes person properties (`$set`); the event's own
`dimensions` are flattened onto event properties first, then overwritten by server-derived keys
(`surface`, `action`, `environment`, `session_id`) so a client can never spoof a trusted key by
naming a dimension after it. Server-side business and error events (`services/analytics.ts`) post
to the same capture API, tagged `surface: 'server'`, so one PostHog project holds every event from
both desktop and server.

Errors additionally become `$exception` events for PostHog Error Tracking (`exceptionEvent` in
`services/posthog-transform.ts`), fingerprinted on our own `errorCode` when one is present so
grouping follows the app's own error taxonomy rather than PostHog's pattern-hash default.

#### Stack frames

Error Tracking renders code locations **only** from `$exception_list[].stacktrace` — it never
parses the exception's `value`. The desktop sends its stack as redacted text (that is the shape
the client-side frame filter and redaction produce), so `parseStackFrames` in
`services/posthog-transform.ts` turns each `at fn (file:line:col)` line back into a raw frame:

```json
"stacktrace": { "type": "raw", "frames": [
  { "platform": "custom", "lang": "javascript", "function": "push",
    "filename": "~/app/sync.ts", "lineno": 12, "colno": 5,
    "resolved": true, "in_app": true }
] }
```

Four rules that are load-bearing:

- **Reversed.** PostHog treats the **last** frame as the throw site; a JS stack string is
  innermost-first. The cap of 50 frames is applied _before_ reversing, so a deep stack loses its
  outermost callers rather than the frame that actually failed.
- **`platform: 'custom'`.** Claiming `web:javascript` enters PostHog's symbolification path, which
  needs uploaded source maps and a per-frame chunk id. We ship neither, so it would resolve to
  nothing; `custom` frames render verbatim.
- **`in_app: false`** for `node:*`, `internal/*`, `node_modules` and `electron/js2c` frames. The
  UI hides non-in-app frames by default, falling back to showing all of them when an exception has
  none — so a fully-vendor stack is never blank.
- **Omitted, not empty.** An exception with no parsable frame carries no `stacktrace` key at all.
  `frames: []` would claim we resolved a stack and found nothing; utility-process crashes and
  log-derived errors genuinely have none.

`value` holds the redacted message alone — it is the issue title, and the stack belongs in frames.
A React component stack is promoted to frames when there is no JS stack, and always ships intact as
`$exception_component_stack`.

Errors that carry no JS stack by construction — `child-process-gone` for a crashed utility worker,
where the process that died is not the one reporting — instead carry a synthesized message naming
the worker, reason and exit status, so their issue page is not blank.

This transform is entirely server-side: it applies to batches from already-installed desktop
versions as soon as the sync-server deploys.

No raw identifiers are stored: the install ID is HMAC-hashed server-side (`TELEMETRY_HMAC_KEY`,
`hashTelemetryId`) and used as the PostHog `distinct_id`; server-side `user_id`/`device_id`/
`vault_id` are hashed the same way before they ride along as event properties.

### Account identity

The desktop attaches its access token to `/telemetry/batch` and `/diagnostics/report` as an
**optional** bearer. Neither route runs the auth middleware: `resolveTelemetryAccountHash`
verifies the JWT if one is present and returns `undefined` for a missing, malformed or expired
token, so telemetry is never rejected for auth reasons — that batch simply reports anonymously
against its install hash.

The resolved account id is **HMAC-hashed before it can become a `distinct_id`**, exactly like the
install ID. `TransformContext` names the field `accountHash`, and `resolveDistinctId` shape-checks
it against `hashTelemetryId`'s output (64 lowercase hex chars); anything else — most plausibly a
raw account id — degrades to the install hash rather than reaching PostHog. This is deliberately
strict: a PostHog `$identify` merge is permanent and cannot be undone or re-keyed, so a raw
account id that reached a person profile could not be removed afterwards.

When a batch resolves to an account, a `$identify` event aliases the anonymous install person onto
the account person. It fires **once per app session**, guarded by the `telemetry_identify_sessions`
D1 table (`claimIdentifySession`, migration `0003`, swept by the cron cleanup after 24h). Without
the guard, the desktop's ~30s flush cadence would emit one identified event per batch. The guard
fails open: a D1 error emits `$identify` anyway (idempotent in PostHog) rather than leaving the
install unlinked.

Diagnostic reports resolve identity through the same `resolveDistinctId` path as events and logs,
so a report lands on the same person profile as the events around it.

**Known limitation:** telemetry identity is verified but **not revocation-checked**. A revoked
device's still-unexpired access token (≤15 min) can attribute telemetry until it lapses. Telemetry
is not an authorization decision, so a per-batch device lookup is not worth the D1 read.

Environments are separated by an `environment` property on every event inside one PostHog
project, not by separate projects.

Additional events in the same pipeline:

| Event                        | Source                                    |
| ---------------------------- | ----------------------------------------- |
| `app_launch_phase_completed` | Electron main/renderer startup milestones |
| `app_log_recorded`           | Sanitized desktop diagnostic breadcrumbs  |
| `app_error_seen`             | Renderer, React boundary, and main errors |
| `server_error_seen`          | Sync-server request/background failures   |
| `server_log_recorded`        | Structured sync-server diagnostic logs    |
| `release_asset_downloaded`   | Daily GitHub Releases download-count pull |

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

Body edits reach the note through the CRDT provider rather than the notes UPDATE IPC, so typing
never registered as usage at all. `trackNoteBodyEditThrottled` (`telemetry/diagnostics.ts`, called
from `ipc/crdt-handlers.ts`) now emits `note_updated` with `source: 'editor_body'` on the **same**
`note_updated:<noteId>` throttle key the UPDATE handler uses, so metadata saves and body edits
share one 5-minute window per note. Only the throttle key ever sees the note id; the event itself
carries no identifier.

## Release Download Counts

Downloads happen on GitHub Releases, where PostHog cannot see them — the landing site's
download-click event measures intent, not a download. A daily cron on the sync server
(`services/release-downloads.ts`, run from the `scheduled` handler at 04:00 UTC) reads
`GET /repos/memrynote/memry/releases` and emits one `release_asset_downloaded` event per asset.

**`assets[].download_count` is cumulative per asset.** Emitting it raw would produce a
monotonically increasing counter that is useless as an event stream — and it fails silently,
producing meaningless numbers rather than an error. The last total seen per asset is therefore
stored in D1 (`release_download_counts`, migration `0003`) and only the **delta** is emitted:

- The first run for an asset seeds its row and emits nothing; a cumulative counter carries no
  meaningful delta until it has a baseline.
- A total that went **down** — GitHub recounting, or a replaced asset — reseeds the baseline
  rather than emitting a negative delta.
- The store is written **before** the events are captured. A D1 failure then throws, the cron
  reports it, and the untouched baseline makes the next run emit the full delta. Emitting first
  would double-count that delta after a failed write.

The pull rides its own cron entry (`crons = ["0 */6 * * *", "0 4 * * *"]`) so it runs once a day
while the cleanup sweep keeps its 6-hourly cadence. The daily entry deliberately avoids the
6-hourly times — colliding entries collapse into one invocation.

Events are not person-scoped: an anonymous downloader has no identity to key on, so `distinct_id`
is a fixed `memry_releases_<environment>`. Staging and production both poll the same public repo,
so — as everywhere else — an insight that does not filter `environment` blends them.

| Property               | Meaning                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| `release_tag`          | Release the asset belongs to (`v2026-08-06`)                         |
| `asset_name`           | Published filename                                                   |
| `platform`             | `macos` / `windows` / `linux` / `unknown`, derived from the filename |
| `asset_kind`           | `installer`, or `update_metadata` for `latest*.yml` and `.blockmap`  |
| `downloads`            | **The delta** — sum this, never `cumulative_downloads`               |
| `cumulative_downloads` | Total GitHub reported at pull time, for context only                 |

`asset_kind` is load-bearing: every installed app polls `latest*.yml` and fetches `.blockmap`
deltas on its update schedule, so counting those as downloads would swamp the number that
matters. Filter to `asset_kind = 'installer'` for real downloads.

**Downloads cannot be joined to activation.** An anonymous downloader and a desktop install share
no key. The funnel only works for people who sign up on the landing site _and_ sign in on the
desktop, where the identity merge puts both on one person. This is a limitation to state plainly,
not to engineer around.

## Landing Site Telemetry

The marketing site (`apps/landing`) runs analytics **browser-side** via `posthog-js`
(`apps/landing/src/lib/analytics.ts`), ingesting through PostHog's reverse-proxy subdomain
(`https://e.memrynote.com`) — session replay cannot be routed through the sync server, so landing
traffic does not go through `/telemetry/batch`. The old `POST /telemetry/web` endpoint and its
`LandingTelemetryBatchSchema` contract are gone.

- **Client**: `init()` lazily configures `posthog-js` once per page load, keyed on
  `VITE_POSTHOG_KEY` with `api_host` = `VITE_POSTHOG_HOST` (defaulting to
  `https://e.memrynote.com`), `person_profiles: 'identified_only'`, and masked session recording
  (`session_recording: { maskAllInputs: true }`). It no-ops with no `window` (SSR/prerender) or no
  key configured. `trackLandingPageView` fires PostHog's native `$pageview`; `trackLandingEvent`
  fires one of a fixed set of `landing_*` event names.
- **Payload**: pages and targets are path-only — query strings and hashes are stripped
  client-side (`stripQueryAndHash`) before either ever leaves the browser. UTM params
  (`utm_source`/`medium`/`campaign`/`content`/`term`) are read from the query string, trimmed, and
  capped at 120 characters.
- **Environment**: `environment` is registered once via `posthog.register` — Vercel's
  `VITE_VERCEL_ENV` when present, otherwise a production/development split on Vite's build
  `MODE` — so landing traffic is filterable apart from desktop/server events in the same PostHog
  project.

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
never copied — only its shape. A reason that crossed a structured-clone or IPC boundary keeps its
`.name` but loses both its stack and its constructor; that name is preferred over the constructor
name, so it reports `Rejection_TypeError` rather than collapsing to `Rejection_Error`. When the
code is a `Rejection_*` name the stack is the handler's own frames, not the fault's — the code is
the actionable part.

A **window error** does not always carry an `error` object: cross-origin scripts and some Chromium
failure paths report only a message and a source location, which previously landed as `StringError`
with an empty stack and nothing to triage. The error class is recovered from the message's leading
token (`Uncaught TypeError: …` → `TypeError`, subject to the same enum-token rule) and the
`filename`/`lineno`/`colno` are rebuilt into a stack frame, so the code location survives the same
frame filter and redaction as a real stack. The message text itself is still never shipped.

Because a rejection reason or `event.error` can be **any** value — including a `Proxy` whose traps
throw or an object with throwing getters — every property read in this path (including `instanceof`,
which can trap `getPrototypeOf`) is individually guarded. A hostile value can no longer throw out of
the diagnostics handler and destroy the report being built.

The free-form exception message was historically never sent at all, since on the desktop it can
embed a note title, filename, or content. `buildErrorDetail` now ships it
(`TelemetryErrorDetailSchema.message`, optional, capped at 512) after running it through
`redactText` (`packages/contracts/src/redact.ts`) — the server re-runs redaction in mask mode as
a backstop. This is what makes an issue readable: without a message PostHog titles every issue
with the bare error code, which is how a whole family of production issues came to read
`StringError / StringError`. `redactText` strips known-sensitive shapes (secrets, tokens, emails, ids,
home-directory paths, content-file basenames) rather than proving the remaining prose is
note-free, so this is narrower than the earlier all-or-nothing "no message field" guarantee. The
stack is separately reduced to code-location frames only — the leading `Name: message` header
line is stripped — so a crash's location shows up as, for example, `TypeError` at
`pushRecords (…/sync-engine.js:120)`. Frame file paths are app source/bundle locations (not user
files); any home-directory prefix (`/Users/<name>`, `C:\Users\<name>`) is rewritten to `~`, and
emails, UUIDs, JWTs, and bearer tokens are scrubbed from anything that ships.

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
to Cloudflare's own first-party Workers console logs (with the raw `userId`/`deviceId`/`vaultId`
attached, since that sink is trusted) and to PostHog Logs (with those same ids HMAC-hashed) —
never to the PostHog event itself, which only gets the coded `server_error_seen` event with no
message or stack; this is what makes sync failures debuggable without handing ciphertext-adjacent
detail to a third party. The `server_error_seen` event itself carries no user, device, or vault id
either — its `distinct_id` is a fixed `memry_server_<environment>` value, so the event alone cannot
be traced to an account. Only the PostHog **log** record carries the HMAC-hashed
`userId`/`deviceId`/`vaultId` (when the caller has them), which is what lets a failure be
correlated to an account inside Logs without exposing the raw id. Dynamic path segments and query
strings are normalized away. Expected handled `4xx`
responses (e.g. `SYNC_PAYMENT_REQUIRED`) are still counted as `server_error_seen` but are logged at
`warn` rather than `error` level, keeping real failures distinguishable from expected noise.

## Error & Diagnostic Logs in PostHog

Error events also become searchable **log lines** in PostHog Logs. This replaced a self-hosted
Grafana + Loki instance the sync server used to push to; PostHog Logs now carries the diagnostic
detail (stacks, operational messages) that a PostHog _event_ deliberately omits.

- **Transport**: the sync server posts log lines to PostHog Logs' plain OTLP-JSON receiver
  (`{POSTHOG_HOST}/i/v1/logs`, `services/posthog-logs.ts`, `pushPostHogLogs`) — no OpenTelemetry SDK
  is used — authenticated with the PostHog project token (`POSTHOG_KEY`) as a bearer. Pushes are
  fire-and-forget in `waitUntil`: a missing key (local dev) is a silent no-op, and a failed push
  can never affect request handling. Records are grouped into one `resourceLogs` entry per `app`
  (`desktop` / `server`) so `service.name` and `deployment.environment` stay resource-level
  attributes rather than being duplicated onto every line.
- **Desktop errors**: `/telemetry/batch` events carrying an `errorCode` or `error` detail are
  forwarded as `app="desktop"` lines containing the event name, error code, surface/action/source,
  app version, platform, a **redacted message** (`TelemetryErrorDetailSchema.message` is optional
  and only accepted after the client has run it through `redactText`; the server re-runs
  redaction as a backstop) and **redacted stack frames**, `log_action` — the operational
  breadcrumb that keeps log-type error events (which carry no stack of their own) identifiable —
  and `exit_code`, the platform exit status for process-lifecycle events (empty string when
  absent, since exit code `0` is itself meaningful).
- **Redacted diagnostic logs (`kind=log`, Path A, always-on)**: a main-process electron-log
  transport (`apps/desktop/src/main/telemetry/log-ship.ts`, installed once from `main/index.ts` —
  never from `logger.ts`, which must stay electron-free for worker bundling) intercepts every
  `warn`/`error` record and redacts it via `redactLogLine` (`packages/contracts/src/redact.ts`)
  before anything leaves the device, using a per-install salt (`diagnosticsSalt`, persisted in
  `telemetry.json`) and the active vault root. Redacted lines batch (queue 500 / batch 50 / flush
  30s, drop-4xx-except-429) to `POST /telemetry/logs`, gated on the telemetry toggle
  (`getTelemetryRuntime().getSettings().enabled`) and disabled outright in dev builds. Repeated
  identical `level|scope|message` lines within a 3s window are throttled into one line with a
  `repeatCount` field. The Path B ring those lines also feed is a fixed-capacity circular buffer
  (200 slots, 5-minute window) that stores each line's epoch ms at push time and evicts oldest-first
  through a head index, so one `warn`/`error` costs O(1) instead of re-parsing every retained
  timestamp — the error path has to stay cheap when something is looping. A record's arguments are flattened by `parseRecord`: the first string wins
  the `message` slot, plain objects merge into the fields, and an `Error` contributes `errorName`
  plus `errorMessage`. That last part matters — `logger.error('updater error', err)` used to ship
  `{"errorName":"Error"}` and nothing else, because the label had already claimed the message slot
  and the Error's own message was dropped. Worker processes (embeddings, image processing, voice transcription)
  forward their own `warn`/`error` records to main over `process.parentPort`
  (`apps/desktop/src/main/lib/log-forward.ts`, electron-free) for the same redaction + ship pass,
  tagged `origin: 'worker'` and `workerName`. The server re-runs `redactLogLine` in mask mode (no
  salt) as defense-in-depth before writing to PostHog Logs (`desktopLogRecord` in
  `services/posthog-logs.ts`) — the client-side redaction is primary; the server pass is a second
  net, not the source of truth.
- **Incident reports (`kind=report`, Path B, opt-in one-time)**: on a real error, the app offers a
  one-time "Send diagnostic report" action (the tab error boundary, IPC-error toasts, and a
  Settings entry — available independent of the telemetry toggle). The
  `diagnostics:previewReport` / `diagnostics:sendReport` IPC calls build a `DiagnosticReport` via
  the same pure `buildIncidentReport` function: a generated `incidentId` (`MEMRY-XXXXXXXX`, random
  base32), the last ≤200 redacted lines from the Path A ring buffer (≤5 min), a redacted
  device/sync snapshot (app version, platform, locale, uptime, sync/auth state, queue depth — no
  content), and the triggering error's redacted stack (header line dropped, frames only). Preview
  and send call the same builder with the same `incidentId`, so the consent dialog's preview is
  byte-identical to what ships. `sendReport` posts to `POST /diagnostics/report`; the server writes
  one summary line plus one line per log entry, all tagged `incident_id`, under `kind=report`.
- **Redaction guarantees**: same non-negotiables as [What Never Ships](#what-never-ships) — no note
  content, titles, attachment filenames, absolute home/vault paths, emails, JWTs/tokens, vault/device
  keys, or IPs. `kind=log`/`kind=report` message text runs through the same `redactText` as the
  `/telemetry/batch` error message above; `redactLogLine` additionally redacts each structured
  `fields` entry: secrets are dropped first, paths collapse to `~/` / `<vault>/`, note/attachment
  basenames are salted-hashed to `[name:hash8].ext`, known id fields (`noteId`, `deviceId`, `installId`, …)
  are salted-hashed, and emails become `[email:hash8]`. IPs are masked to `<ip>`. UUID-shaped ids in
  free text are salted-hashed on the client (correlatable, like the id fields above); the server's
  re-redaction pass has no salt, so it masks them to a fixed `<id>` instead. A fixed field allowlist
  (`level, scope, action, errorCode, appVersion, buildChannel, platform, arch, origin, workerName,
reason, phase, mode, status, kind, result`, plus numeric metric keys like
  `durationMs`/`itemCount`) ships verbatim; most other field values run through the same redaction as
  the message.
- **Updater failures**: every failure in `apps/desktop/src/main/updater.ts` logs a
  `describeUpdaterError()` field bag alongside the raw error, so a silent auto-update failure is
  diagnosable from Loki alone: `phase` (`startup-check`, `scheduled-check`, `auto-check-enable`,
  `auto-download-enable`, or — for electron-updater's own `error` event, which carries no phase —
  one of `check` / `download` / `downloaded` / `install` inferred from the status at the time),
  plus `errorName`, `errorMessage`, `errorCode`, `httpStatus`, `url`, `errorCause` and the top
  stack frames as `errorStack`. The field names are chosen against the redaction allowlist above:
  `phase` and `errorCode` ship verbatim, `url` is path-redacted (query string stripped), the rest
  are text-redacted and capped.
- **Process lifecycle**: the main process reports a `child-process-gone` fault with a composite
  `type:reason:name` error code (e.g. `Utility:crashed:Embeddings`). The worker label comes from
  Electron's `details.name`, **not** `details.serviceName`: Electron routes a fork's `serviceName`
  _option_ to `details.name`, while `details.serviceName` holds the Mojo interface name — a
  constant (`node.mojom.NodeService`) that is identical for every utility fork and so cannot tell
  our workers apart. A fork that passes no `serviceName` option reports the default
  `Node Utility Process`. The exit status rides along in the line's `exit_code` field rather than
  inside the error code, so crashes still group by worker in PostHog Logs while the POSIX signal
  (11 SIGSEGV, 6 SIGABRT) stays visible. A utility worker's clean idle-shutdown (embeddings,
  image-processing, voice-model each exit after ~30s idle) is a lifecycle event, not a fault, so a
  `clean-exit` reason is skipped entirely — only a real fault produces an error event, mirroring
  the GPU crash guard. Note that `child_process_gone` is **not** throttled: the crash cadence is
  itself a diagnostic signal. When the owning module can resolve a lifecycle phase for the dead
  worker, the breadcrumb becomes `child_process_gone_<phase>` and the phase joins the exit status
  in the message (`Embeddings utility process crashed (exit 6, idle_shutdown)`). The **error code
  stays phase-free**: it is the Error Tracking fingerprint, so splitting it per phase would orphan
  the existing issue's history.
- **Embedding worker**: phase is `starting`, `in_flight`, `idle_shutdown`, or `idle`. This is what
  separates a harmless teardown crash (`idle_shutdown` — the embedding was already delivered) from
  real user impact (`in_flight` — the user silently lost semantic-search indexing for that note).

  The phase is resolved by `getEmbeddingWorkerPhase(details.name)` at the `child-process-gone` call
  site, **not** inside the worker's own `exit` handler. Electron's `UtilityProcess` `exit` event
  does not fire for a native crash — a SIGABRT out of the model runtime is neither a graceful exit
  nor the V8 `FatalError` the instance `error` event covers — so the bridge never learns its worker
  died. Production proved it: across 107 consecutive `Utility:crashed:Embeddings` events the
  bridge's own `worker_exit_<phase>` breadcrumb emitted **zero**, and so did `embed_failed`, while
  `child-process-gone` fired for all 107. Resolving the phase at the report that does arrive is
  what makes those events answerable. The `worker_exit_<phase>` breadcrumb is kept for the paths
  where `exit` does fire (a non-crash abnormal exit, a force-kill), and carries a different error
  code (`EmbeddingWorkerExit`) so the two are never confused.

  Anything reading the phase from outside the exit handler must also survive the force-kill race:
  `reset()` latches `idle_shutdown` before killing, then nulls the process handle, so the latch is
  cleared when there is no process to kill — the latch now outlives the exit handler that used to
  clear it, and a stale one would make the next worker's crash read as a teardown it never had.

  Embedding generation failures emit `embed_failed`, throttled to one event per 5-minute window
  because a broken worker would otherwise fail once per note edit.

- **Desktop IPC envelopes**: every `{ success: false }` error envelope produced by the IPC layer
  (`withErrorHandler` / `withDb`) also emits an `app_error_seen` event, throttled in-memory to one
  event per **action + error code** per minute so an error loop can't flood the telemetry queue.
  The key must discriminate: keyed by error name alone and shared across all handlers, one benign
  recurring `Error` masked a genuine different `Error` from another handler for the whole window.
  The expected `noVaultOpen` envelope is not tracked, and the envelope's user-facing `error`
  string (which may contain note-derived text) never leaves the process — only the error code and
  redacted stack frames ship. Handlers that **throw** instead of returning an envelope report the
  same way: `createHandler` and `createValidatedHandler` (`main/ipc/validate.ts`) wrap the call,
  so canvas and calendar reads — which never pass through `withDb` / `withErrorHandler` and whose
  rethrow used to be their only trace — are now countable. A Zod validation failure is reported
  too (renderer↔main contract drift, not user error); only the `ZodError` name and stack ship,
  never the issue messages, which can echo input values. An
  [expected condition](#error-reporting) is skipped **before** the throttle map, so a suppressed
  error can't claim the key and mask a real failure from the same handler.
- **Vault watcher**: chokidar `onError` can burst per file (a permission-denied subtree), so
  watcher faults are sampled to one `app_error_seen` per minute (`main/vault/watcher.ts`). Every
  error still reaches the local log.
- **User-visible failures that previously left no trail**: a renderer `did-fail-load` (the user is
  staring at a blank window) reports as `DidFailLoad:<chromiumErrorCode>` — the URL never leaves
  the process; a `memry-file:` protocol serve failure (a silently broken image/PDF/video embed)
  logs a `MemryFile` / `serve_failed` breadcrumb with the coded errno before answering 404; a
  window-close flush rejection (window refuses to close, edits possibly unsaved) reports as
  `window_close_flush_failed`; and quick capture reports
  `QuickCapture` / `global_shortcut_register_failed` when both the configured and the fallback
  global shortcut fail to register.
- **Expected conditions**: some failures are normal states, not faults. They still surface to the
  UI as an error envelope, but the throw site marks them and error telemetry skips them, so they
  cannot drown real signal. Currently marked: an Ollama model-list fetch that is **refused**
  (`ECONNREFUSED` = Ollama is not running), and a **calendar OAuth timeout** (the user opened the
  consent screen and walked away). The suppression is deliberately narrow — a real Ollama
  misconfiguration (DNS failure, connection reset, or a bad HTTP status) is still reported.
- **Server errors**: `captureServerError` pushes its redacted detail (operational message, stack,
  normalized path, error/status codes) as `app="server"` lines — level `error` for 5xx/unhandled,
  `warn` for handled 4xx.
- **Beyond route handlers**: failures that never produce a failing HTTP response also reach
  PostHog Logs — scheduled cleanup-task failures (`source="cron"`), token-revoke failures during
  logout, Resend email send failures (`RESEND_SEND_FAILED`), and `UserSyncState` Durable Object
  alarm/websocket handler errors (`source="user_sync_state_do"`, pushed directly via
  `pushPostHogLogs` since no route error handler ever sees them).
- **Attributes**: `app` (`desktop`/`server`) and `env` are resource-level attributes shared by
  every line in a push; `kind` (`error | log | report`) and, when known, `posthogDistinctId` (the
  already-hashed identity, so PostHog can attribute the line to a person) are per-line attributes;
  `level` rides in `severityText`. Everything else — the JSON body under `line` in
  `services/posthog-logs.ts` — is the log body, not an attribute.
- **Retention**: 14 days, per PostHog Logs' own retention policy.
- **Viewing**: log lines are searchable in PostHog's Logs product, filterable on the
  `service.name` / `deployment.environment` / `kind` attributes and by `distinct_id`.

## Canvas Rollout Panels (Grafana / Analytics Engine)

Panels for the spatial canvas rollout. Create these by hand in Grafana Cloud
against the Analytics Engine dataset; they are recorded here so the rollout is
reproducible and reviewable.

`canvas_opened` fires on every successful canvas load, so a tab-switch remount
counts again. Read it as "canvas loads", not "distinct canvases opened".

The queries below are written against the real datapoint layout used by
`toDataPoint()` / `writeServerPoint()` (`apps/sync-server/src/services/telemetry.ts`,
`apps/sync-server/src/services/analytics.ts`): `blob1` holds the event name and
`index1` holds the HMAC-hashed install id, against the dataset named in
`apps/sync-server/wrangler.toml` (`memry_product_telemetry_production` /
`_staging` / `_dev`). The column names are real; the exact SQL dialect accepted
by the Analytics Engine SQL API through Grafana's Infinity datasource has not
been verified by running these — treat them as a documented starting point,
not verified panel queries, and adjust syntax as needed when building the
panels.

| Panel              | What it answers                        | Query                                                                                                                                                                                                                      |
| ------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canvas adoption    | Are people turning it on and using it? | `SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, count() AS loads, uniq(index1) AS installs FROM memry_product_telemetry_production WHERE blob1 = 'canvas_opened' GROUP BY day ORDER BY day`                 |
| Canvases created   | Is creation growing or one-and-done?   | `SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, count() AS created FROM memry_product_telemetry_production WHERE blob1 = 'canvas_created' GROUP BY day ORDER BY day`                                        |
| Conflict-copy rate | Is last-write-wins hurting real users? | `SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, count() AS conflicts, uniq(index1) AS installs FROM memry_product_telemetry_production WHERE blob1 = 'canvas_sync_conflict_copy' GROUP BY day ORDER BY day` |
| Oversized canvases | Is the size cap being hit?             | `SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, count() AS blocked FROM memry_product_telemetry_production WHERE blob1 = 'canvas_too_large' GROUP BY day ORDER BY day`                                      |
| Unknown sync types | Mixed-version tripwire                 | `SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, count() AS skipped FROM memry_product_telemetry_production WHERE blob1 = 'sync_skipped_unknown_type' GROUP BY day ORDER BY day`                             |

Swap `memry_product_telemetry_production` for `_staging` when checking a
staging deploy. The event names are the stable part of these queries.

Go/no-go for flipping the canvas feature flag on by default is recorded in
`docs/superpowers/specs/2026-07-22-spatial-canvas-m7-rollout-design.md` §7.

## Server Configuration

Set these sync-server variables to enable PostHog capture and log shipping (unset in local dev,
where both are a no-op):

```bash
POSTHOG_KEY=...                          # wrangler secret (PostHog project token)
POSTHOG_HOST=https://us.i.posthog.com    # wrangler var (staging and production)
```

`GITHUB_TOKEN` is optional and only used by the daily
[release download-count](#release-download-counts) cron. Without it the pull is unauthenticated
and shares the 60-requests-per-hour-per-IP limit with every other Worker on the same egress
address; a public-repo read token lifts that. A failed pull throws and is reported as a
`release_download_counts` cron failure rather than silently skewing the numbers.

### Diagnostic Log Endpoints

Two additional endpoints feed the `kind=log` / `kind=report` streams. Both accept unauthenticated
requests (no sign-in required), are rate-limited per user/IP, Zod-validated, and PostHog-Logs-only
— neither writes a PostHog product event:

| Endpoint                   | Stream                 | Rate limit    | Payload                                                                                                 |
| -------------------------- | ---------------------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| `POST /telemetry/logs`     | Path A (`kind=log`)    | 120 req / 60s | `DiagnosticLogBatchSchema` — 1–50 redacted log lines                                                    |
| `POST /diagnostics/report` | Path B (`kind=report`) | 10 req / hour | `DiagnosticReportSchema` — ≤200 redacted lines + a redacted device/sync snapshot + the triggering error |

A malformed payload is rejected with `400 VALIDATION_ERROR` (only the Zod path + issue code is
logged, never values, same convention as `/telemetry/batch`). A valid payload always gets `202`,
including when `POSTHOG_KEY` is unset — the push inside `pushPostHogLogs` is a silent no-op in
that case, so a dev build never error-spams.

`/diagnostics/report` attributes to an account when the desktop attaches a bearer (see
[Account identity](#account-identity)); `/telemetry/logs` is still anonymous because the log
shipper does not attach one yet. `DiagnosticReportSchema.accountId` is accepted for backward
compatibility with older desktop builds but is **deliberately ignored** — a body field is
client-asserted, and it would feed a `distinct_id` whose `$identify` merge is permanent, so
identity comes only from the verified bearer. `/telemetry/batch` is unchanged by either endpoint.

## Performance

`trackTelemetry` is debounced and batched. Calls during the first second of startup are deferred
until after the vault is open so they never delay first paint. On the sync server, PostHog event
capture and PostHog Logs pushes both run in `waitUntil` so neither can block the
`/telemetry/batch` response.
