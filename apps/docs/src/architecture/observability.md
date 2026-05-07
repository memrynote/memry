# Observability & Telemetry

Local logs and an optional, opt-in telemetry stream.

## Logging

- Use `createLogger(scope)` from electron-log everywhere — never `console.*`.
- Logs land in the OS-standard log directory, rotated by electron-log.
- Renderer and main process logs are separate files.

## Telemetry

- Opt-in via [Settings → General](/user-guide/settings#general).
- Only enums and event names ship — never note titles, file paths, or note IDs.
- Surfaces are tracked at tab-type level (`notes`, `journal`, `tasks`, `inbox`, `calendar`, `search`, `graph`).

## Surfaces

`TelemetrySurface` in `packages/contracts/telemetry-api` lists every legal surface value.

## Tracking Pattern

```ts
void trackTelemetry('page_viewed', { surface, action: 'viewed' })
```

Use `void` so the call is fire-and-forget and can never block UI.

## What Is Never Sent

- Note content
- Note titles
- Identifiers (note IDs, task IDs, project IDs)
- Search queries
