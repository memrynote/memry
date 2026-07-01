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

### What Ships

Only enums and event metadata:

```ts
trackTelemetry('page_viewed', { surface: 'notes', action: 'viewed' })
```

Recognized surfaces (`TelemetrySurface` in `packages/contracts/telemetry-api`):

`app`, `onboarding`, `vault`, `notes`, `journal`, `tasks`, `inbox`, `calendar`, `search`,
`graph`, `settings`, `sync`, `ai`, `voice`, `updater`.

### What Never Ships

- Note content
- Note titles
- Identifiers (note IDs, task IDs, project IDs)
- Search queries
- Tag names
- File paths

The contract uses string-typed enums for surfaces and actions; arbitrary strings can't sneak through.

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

| Category        | Events                                                                                |
| --------------- | ------------------------------------------------------------------------------------- |
| Surface views   | `page_viewed` — one per tab open                                                      |
| App lifecycle   | `app_started`, `app_backgrounded`, `app_active_heartbeat`, `app_update_installed`     |
| Onboarding      | `onboarding_started`, `onboarding_completed`                                          |
| Notes           | `note_created`, `note_opened`, `note_updated` (throttled 1/doc/5 min), `note_deleted` |
| Journal         | `journal_opened`, `journal_updated` (throttled 1/doc/5 min)                           |
| Search          | `search_opened`, `search_performed`, `search_result_opened`                           |
| Command palette | `command_palette_opened`, `search_result_opened` (palette context)                    |
| Settings        | `setting_changed` — surface only, never the value                                     |
| Agent chat      | `agent_chat_started`, `agent_chat_message_sent`                                       |
| Sync health     | `sync_enabled`, `sync_run_completed`, `sync_error` (counts/status only)               |
| Auth            | `signin_started`, `signin_succeeded`                                                  |
| Diagnostics     | `app_log_recorded`, `app_error_seen`, `app_launch_phase_completed`                    |

## PostHog Export

The sync server always writes accepted desktop telemetry batches to Cloudflare Analytics Engine.
When `POSTHOG_API_KEY` and `POSTHOG_HOST` are configured on the sync server, the same
content-free events are mirrored to PostHog's batch endpoint.

PostHog mirroring does not use raw install IDs or session IDs. Desktop telemetry uses a
server-HMAC install hash as the PostHog distinct ID so active-install, funnel, and retention
insights work without exposing local identifiers. Session IDs and session hashes stay out of
PostHog.

Additional PostHog events:

| Event                        | Source                                    |
| ---------------------------- | ----------------------------------------- |
| `app_launch_phase_completed` | Electron main/renderer startup milestones |
| `app_log_recorded`           | Sanitized desktop diagnostic breadcrumbs  |
| `app_error_seen`             | Renderer, React boundary, and main errors |
| `server_error_seen`          | Sync-server request/background failures   |
| `server_log_recorded`        | Structured sync-server diagnostic logs    |

### Account-Linked Identity

When a user is signed in, the desktop telemetry flush includes a verified bearer token. The
sync server verifies the token's signature, extracts the account ID, and passes it to PostHog
as the `distinct_id` for the batch. An `$identify` merge event is also sent to link the
anonymous install-hash identity to the account ID so funnels and retention insights stay
coherent across sign-in.

- **Signed-out / anonymous**: uses the server-HMAC install hash as before.
- **Signed-in**: uses the verified account ID. Token signatures are checked but revocation is
  not (the token is accepted as long as the signature is valid and it is not expired).
- **Auth never blocks telemetry**: a missing or invalid bearer falls back to anonymous. Batches
  are never rejected for auth reasons.

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

## Error Reporting

Desktop error reporting follows the same product telemetry setting. Captured errors include process
area, component/source, action, phase, and stable error codes. They do not include note content,
titles, file paths, search text, stack traces, or raw exception messages.

Sync-server error reporting is server-side and uses only sanitized routing metadata: method,
normalized path, route area, source, action, status code, error type, and error code. Dynamic path
segments and query strings are removed before export.

## Server Configuration

Set these sync-server variables to enable PostHog mirroring:

```bash
POSTHOG_API_KEY=phc_...
POSTHOG_HOST=https://us.i.posthog.com
```

Use `https://eu.i.posthog.com` for EU Cloud projects.

## Performance

`trackTelemetry` is debounced and batched. Calls during the first second of startup are deferred
until after the vault is open so they never delay first paint. On the sync server, Analytics Engine
writes finish before `/telemetry/batch` responds, while optional PostHog mirroring runs in
`waitUntil` so third-party telemetry cannot block the request path.
