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
stable metadata — process area, component/source, action, phase, and the error's class name
(`errorCode`) — plus a **redacted stack trace** and, for React boundaries, the component stack.

The free-form exception **message is never sent**: on the desktop it can embed a note title,
filename, or content. The stack is reduced to code-location frames only — the leading
`Name: message` header line is stripped — so a crash shows up as, for example, `TypeError` at
`pushRecords (…/sync-engine.js:120)`: the source location, never the note. Frame file paths are
app source/bundle locations (not user files); any home-directory prefix (`/Users/<name>`,
`C:\Users\<name>`) is rewritten to `~`, and emails, UUIDs, JWTs, and bearer tokens are scrubbed
from anything that ships.

Sync-server error reporting is server-side. Because the sync server is end-to-end-blind (it only
ever holds ciphertext), its own error strings are operational and are sent in full — redacted for
stray identifiers — along with stack frames parsed from the real stack; this is what makes sync
failures debuggable. Server errors are attributed to the signed-in `userId` (plus device and vault
ids when present) so a failure can be traced to the account that hit it. Dynamic path segments and
query strings are normalized away. Expected handled `4xx` responses (e.g. `SYNC_PAYMENT_REQUIRED`)
are still counted as `server_error_seen` but do not open PostHog `$exception` issues, keeping Error
Tracking focused on real failures.

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
  app version, platform, and the **redacted stack frames only** (the schema has no message field —
  messages can embed note content; see Error Reporting above).
- **Server errors**: `captureServerError` pushes its redacted detail (operational message, stack,
  normalized path, error/status codes) as `app="server"` lines — level `error` for 5xx/unhandled,
  `warn` for handled 4xx.
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
