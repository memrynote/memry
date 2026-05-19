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

| Category      | Examples                                                |
| ------------- | ------------------------------------------------------- |
| Surface views | `page_viewed` per tab type                              |
| Lifecycle     | `onboarding_started`, `onboarding_completed`            |
| Sync health   | `sync_push_succeeded`, `sync_pull_failed` (counts only) |
| Auth          | `signin_started`, `signin_succeeded`                    |

## PostHog Export

The sync server always writes accepted desktop telemetry batches to Cloudflare Analytics Engine.
When `POSTHOG_API_KEY` and `POSTHOG_HOST` are configured on the sync server, the same
content-free events are mirrored to PostHog's batch endpoint.

PostHog mirroring does not use install IDs, session IDs, or their hashes as person identifiers.
Desktop telemetry is grouped under a server-level `memry_desktop_<environment>` distinct ID while
filterable dimensions stay in event properties.

Additional PostHog events:

| Event                        | Source                                    |
| ---------------------------- | ----------------------------------------- |
| `app_launch_phase_completed` | Electron main/renderer startup milestones |
| `app_log_recorded`           | Sanitized desktop diagnostic breadcrumbs  |
| `app_error_seen`             | Renderer, React boundary, and main errors |
| `server_error_seen`          | Sync-server request/background failures   |
| `server_log_recorded`        | Structured sync-server diagnostic logs    |

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
