# Observability & Telemetry

Local logs for debugging plus an opt-in, content-free telemetry stream for product metrics.

## Logging

Use `createLogger(scope)` from electron-log everywhere:

```ts
import { createLogger } from '@/lib/logger'
const log = createLogger('Sync')
log.info('pull complete', { count, durationMs })
log.error('pull failed', err)
```

- **Never** use `console.*`. A pre-commit hook flags it.
- Logs land in the OS-standard log directory and rotate automatically.
- Renderer and main process logs are separate files.

### Log Locations

| Platform | Path                                            |
| -------- | ----------------------------------------------- |
| macOS    | `~/Library/Logs/memrynote/`                     |
| Windows  | `%USERPROFILE%/AppData/Roaming/memrynote/logs/` |
| Linux    | `~/.config/memrynote/logs/`                     |

## Telemetry

Telemetry is **opt-in** via [Settings → General → Privacy](/user-guide/settings#general). Off by default.

### What Ships

Only enums and event metadata:

```ts
trackTelemetry('page_viewed', { surface: 'notes', action: 'viewed' })
```

Recognized surfaces (`TelemetrySurface` in `packages/contracts/telemetry-api`):

`onboarding`, `notes`, `journal`, `tasks`, `inbox`, `calendar`, `search`, `graph`, `templates`, `settings`.

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

## Crash Reporting

Currently disabled. Errors are written to local logs and surfaced in-app where appropriate. A future opt-in crash reporter is on the [Roadmap](/roadmap).

## Performance

`trackTelemetry` is debounced and batched. Calls during the first second of startup are deferred until after the vault is open so they never delay first paint.
