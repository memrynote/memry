# Redacted Diagnostic Logs → Loki + Opt-in Incident Report

**Date:** 2026-07-18
**Status:** Design approved, ready for implementation plan
**Owner:** Kaan

## Problem

When a user hits an error we cannot see it. The trigger for this work was a real
support case (Fedora, app `v2026-07-10.3`): a blank note, a half-synced note, and a
PDF failing with a 403. We had to email the user, ask them to zip `main.log`, and
wait. We want the next case answered from Grafana.

Two forces are in tension:

1. **We are end-to-end encrypted.** The server must never receive note content,
   titles, attachment filenames, absolute user paths, emails, tokens, or keys.
2. **The signal we need lives in log _messages_.** The existing telemetry pipeline
   ships stack frames only — `TelemetryErrorDetailSchema` has no `message` field _by
   design_, because "on the desktop an error message can embed a note title,
   filename, or content." That safety was bought by dropping the message text.

This project makes message text **shippable by redacting it at the source**, not by
dropping it. Keep the safety, add the signal.

## Goals

- **Path A (always-on):** ship redacted desktop log lines (≥ warn) to Loki so we can
  see _why_ a user hit an error with no user action.
- **Path B (opt-in, one-time):** on a real error/crash, offer a lightweight in-app
  prompt; on consent, bundle recent redacted logs + context under an `incident_id`
  and push to Loki, correlated for support.
- Both paths respect the E2E privacy promise. **Redaction happens on the client
  before anything leaves the device.** The server enforces a second, pattern-based
  guard as defense-in-depth.
- The three known failure modes become diagnosable from Grafana alone, with zero
  note content / absolute paths / tokens in the payload.

## Non-negotiable constraints

- **Redact before send.** No note content, titles, attachment filenames, absolute
  home/vault paths, emails, JWTs/tokens, vault/device keys, IPs. When in doubt, hash
  or drop.
- **Loki labels stay low-cardinality:** `{ app, env, level }` + one new fixed-set
  `kind` label (`error | log | report`). Everything else goes inside the JSON line.
  Never put `installId`/`noteId`/etc. as a label.
- **`apps/desktop/src/main/lib/logger.ts` must NOT import electron** — it is bundled
  into `worker_threads` entries (guarded by `scripts/check-worker-bundles.mjs`). The
  redacting transport that calls `net.fetch` is installed from the **main process**,
  not from `logger.ts`.
- **Do not regress** the existing `/telemetry/batch → desktopErrorEntry → Loki`
  error pipeline. `/batch` is left untouched; new endpoints are added alongside it.
- **Server before desktop.** The sync-server ingest change deploys and is live before
  any desktop build that sends to it. Old clients keep working (additive only).

## Decisions locked (brainstorm)

| #   | Decision                   | Choice                                                                                                                                     |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Path A consent gate        | **Reuse the telemetry toggle** (default-ON in prod, opt-out). Settings copy states diagnostic logs are included.                           |
| 2   | Path A default level       | **warn + error only.** Threshold is config-adjustable; info is not shipped in v1 (Loki volume/cost at 30-day retention).                   |
| 3   | Path B preview before send | **Yes** — the consent dialog shows exactly the redacted lines + snapshot that will leave the device. This is the trust-earning surface.    |
| 4   | Path B bundle scope        | **Recent logs + state snapshot + trigger** — last ≤200 redacted lines / ≤5 min, a redacted device+sync snapshot, and the triggering error. |
| 5   | Hash salt scope            | **Per-install.** Persisted in `telemetry.json`. Stronger privacy; no concrete cross-user correlation need. Server cannot reproduce it.     |
| 6   | Worker log coverage in v1  | **Forward worker warn/error records to main via message port** — Path A covers main + worker logs.                                         |
| 7   | Loki schema                | Add a fixed-set **`kind` label** (`error` / `log` / `report`). Single 30-day retention for v1 (per-stream retention deferred).             |
| —   | Endpoint design            | **New endpoints** `/telemetry/logs` (Path A) + `/diagnostics/report` (Path B). `/batch` stays untouched.                                   |
| —   | Redaction module home      | **`packages/contracts/src/redact.ts`** — pure, no-electron, already importable by desktop main + server.                                   |

## Architecture

```
                 ┌─────────────── desktop (main process) ───────────────┐
electron-log ──▶ │  log-ship transport (≥ warn)                          │
records          │    ├─ redactLogLine()  (contracts/redact.ts, salted)  │
(main + workers  │    ├─ ring buffer (last N redacted lines)  ◀── Path B │
 via msg port)   │    └─ batch queue (500/50/30s, retry)                 │
                 │         │                          incident-report.ts │
                 │         │  POST /telemetry/logs        previewReport() │
                 │         ▼                              sendReport()    │
                 └─────────┼────────────────────────────────┼───────────┘
                           │ (Path A, gated on telemetry)     │ (Path B, per-incident consent)
                           ▼                                  ▼
                 ┌──────────────── sync-server ────────────────┐
                 │  /telemetry/logs        /diagnostics/report  │
                 │    Zod + server PII guard (defense-in-depth) │
                 │    rate-limit, anonymous, dev no-op          │
                 │         desktopLogEntry / desktopReportEntry │
                 └──────────────────────┬───────────────────────┘
                                        ▼
                              Loki  { app, env, level, kind }
                              Grafana /d/memry-logs
```

### Component 1 — Shared redaction core (`packages/contracts/src/redact.ts`)

Pure, unit-testable, **no electron import**. Imported by desktop main (client-side
redaction) and sync-server (defense-in-depth). Consolidates the existing
`redactSensitive` / `keepStackFrameLines` (currently in `telemetry-api.ts`) rather
than duplicating them; those keep their existing exports for back-compat.

**Public API**

```ts
export interface RedactOptions {
  salt: string // per-install salt; '' on the server (pattern-only mode)
  vaultRoot?: string // active vault absolute path, collapsed to <vault>/
}
// Redacts one structured log record. `fields` values are redacted unless the key
// is on the allowlist. Returns a new object; never mutates input.
export function redactLogLine(
  input: { message: string; fields?: Record<string, unknown> },
  opts: RedactOptions
): { message: string; fields: Record<string, unknown> }

// Lower-level, exported for reuse + targeted tests:
export function redactText(text: string, opts: RedactOptions): string
export function hashId(value: string, salt: string): string // sha256(salt+value).slice(0,10)
export function hashEmail(value: string, salt: string): string // [email:hash8]
export function redactPath(text: string, opts: RedactOptions): string
```

**Rules (applied in `redactText`, in order):**

1. **Secrets first (drop, never hash):** JWTs (`eyJ…`), `Authorization`/`Bearer`
   values, `sk-`/API-key shapes, vault/device key material, `token=`/`key=` query
   params → `<redacted>`. Dropping first prevents a later rule from hashing a secret.
2. **URLs:** strip query strings entirely; keep scheme+host+path shape. Any
   remaining `?…`/`#…` → dropped.
3. **Paths:** `/Users/<u>/`, `/home/<u>/`, `/root/`, `C:\Users\<u>\` → `~/`; then the
   active `vaultRoot` → `<vault>/`; keep directory shape + file extension; hash the
   note/attachment **basename** → `[name:hash8].<ext>`.
4. **Emails** → `[email:hash8]`.
5. **IPs** (v4/v6) → `<ip>`.
6. **IDs:** UUID-shaped and known id shapes → `hashId` (`sha256(salt+id).slice(0,10)`)
   so lines still correlate to each other without revealing the id.

**Allowlist (shipped verbatim, keys):** `level, scope, action, errorCode,
appVersion, buildChannel, platform, arch` + numeric metrics keys (`durationMs,
itemCount, queueCount, retryCount, byteCount, resultCount, value, sequenceNum,
count`). Every other field value is run through `redactText`; unknown-typed values
are `JSON.stringify`'d then redacted then re-parsed-or-stringified. Message text is
always redacted.

**Salt semantics:** desktop passes its per-install salt so ids/emails hash
_consistently within one install_ (lines correlate). The server passes `salt=''`
and runs the same module in **pattern-only mode** — it still drops secrets, collapses
paths, and `<email>`/`<ip>`-masks, but produces non-correlatable placeholders. The
server guard is a safety net, not the primary redactor.

**Invariant (fuzz) test — the safety net.** Property test injects synthetic secrets
(fake email, fake JWT, fake absolute path `/Users/kaan/vault/Secret Note.md`, fake
note title, fake API key, fake IPv4/IPv6) into both `message` and arbitrary `fields`,
runs `redactLogLine`, and asserts **the raw value never appears anywhere in the
JSON-serialized output**. Run the three known failure-mode lines through it and
assert the output is both clean and still useful.

### Component 2 — Contracts (schemas + IPC channels)

New file `packages/contracts/src/diagnostics-api.ts`:

```ts
DiagnosticLogLineSchema = {
  ts: string(datetime),
  level: 'warn' | 'error',
  scope: SafeToken,            // logger scope, e.g. 'Sync', 'Electron'
  action: SafeToken.optional,
  message: string.max(2000),   // already redacted on the client
  errorCode: SafeToken.optional,
  fields: SafeFieldsRecord.optional,   // redacted, bounded
  origin: 'main' | 'worker',
  workerName: SafeToken.optional,      // 'Embeddings' | 'ImageProcessing' | 'VoiceTranscription'
}

DiagnosticLogBatchSchema = {          // Path A
  schemaVersion: literal(1),
  installId: uuid, sessionId: uuid,
  appVersion, buildChannel, platform, arch,
  lines: array(DiagnosticLogLine).min(1).max(50),
}

DiagnosticReportSchema = {            // Path B
  schemaVersion: literal(1),
  incidentId: string (opaque code, e.g. 8-char base32),
  installId: uuid, sessionId: uuid,
  appVersion, buildChannel, platform, arch,
  trigger: { source: SafeToken, errorCode: SafeToken.optional, stack: string.max(4000).optional },
  snapshot: DiagnosticSnapshotSchema,   // redacted device + sync state
  lines: array(DiagnosticLogLine).max(200),
  accountId: uuid.optional,             // only if signed in
}

DiagnosticSnapshotSchema = {          // all non-sensitive / already-redacted
  appVersion, buildChannel, platform, arch, locale, uptimeSeconds,
  syncEnabled: boolean, syncState: TelemetrySyncState, queueDepth: number,
  vaultOpen: boolean, authState: TelemetryAuthState,
}
```

Reuse `SafeDimensionValueSchema` shape for `SafeToken` and a bounded record for
`SafeFieldsRecord` (string/number/boolean values, ≤ ~20 keys, each string ≤ 500). The
schemas are the server's first line of defense; the PII guard is the second.

IPC channels in `ipc-channels.ts` → new `diagnosticsChannels`:

```ts
diagnosticsChannels = {
  PREVIEW_REPORT: 'diagnostics:previewReport', // (trigger) → DiagnosticReport (built, not sent)
  SEND_REPORT: 'diagnostics:sendReport' // (report)  → { incidentId } | error
}
```

Path A has **no renderer IPC** (main-only). After editing contracts + preload +
handlers: `pnpm ipc:generate` then `pnpm ipc:check`. Follow the `ipc-contract-change`
skill.

### Component 3 — Path A transport (`apps/desktop/src/main/telemetry/log-ship.ts`)

Installed **from `main/index.ts`** at startup (never from `logger.ts`).

- Registers a custom electron-log transport `log.transports.logShip` with `level =
'warn'` (config-adjustable via `MEMRY_DIAG_LOG_LEVEL` / packaged config). electron-log
  invokes it with each record: `{ data: unknown[], level, scope, date }`. First
  string arg → `message`; object args → merged `fields`.
- **Re-entrancy guard:** skip records whose scope is `LogShip` / `Telemetry` / `Loki`,
  and wrap ship failures so a flush-failure `logger.warn` cannot loop.
- Redacts each record via `redactLogLine` using the **per-install salt** + active
  **vault root** (queried from the vault service; `undefined` before a vault opens).
- Batches with the same semantics as `client.ts` (queue 500 / batch 50 / flush 30s /
  drop-4xx-except-429 / keep-5xx+429 / shutdown flush). Extract the queue/flush core
  from `client.ts` into a shared helper if clean; otherwise a parallel queue with
  identical semantics + its own tests.
- **Gated on telemetry-enabled** (reuse `getTelemetryRuntime().getSettings().enabled`)
  and disabled entirely in dev / when the server has no Loki (server returns a dev
  no-op; client treats repeated 204/"disabled" as no-op). Ships to `/telemetry/logs`.
- Feeds every redacted line into the **Path B ring buffer** (single redaction pass
  serves both paths).

**Worker forwarding (decision 6).** New electron-free helper
`apps/desktop/src/main/lib/log-forward.ts` (safe to bundle into workers — uses the
`process.parentPort` runtime global, **no electron import**):

- Worker side: installs an electron-log transport that serializes each ≥ warn record
  to a plain object and `process.parentPort?.postMessage({ __memryLog: record })`.
  Guarded on `process.parentPort` existence (present only inside `utilityProcess`).
- Main side: each worker's `setupProcessHandlers(child)` (`voice-model.ts`,
  `embeddings.ts`, `image-processing/bridge.ts`) routes `msg.__memryLog` into
  `logShip.ingestForwarded(record, workerName)`, which redacts (in main, single salt)
  and enqueues with `origin='worker'`, `workerName`. `crdt-preflight.ts` is a
  short-lived probe → excluded, noted.
- `check-worker-bundles.mjs` must stay green: verify `log-forward.ts` and its imports
  are electron-free.

### Component 4 — Path B incident report (`apps/desktop/src/main/diagnostics/incident-report.ts`)

- **Ring buffer:** in-memory, last 200 redacted `DiagnosticLogLine`s (also time-bounded
  to 5 min), fed by the log-ship redaction pass.
- `previewReport(trigger)`: generates an `incidentId`, snapshots redacted device+sync
  state, assembles `{ incidentId, trigger, snapshot, lines }` from the buffer, returns
  it to the renderer **without sending**. The renderer renders this verbatim as the
  preview — so preview _is_ exactly the payload.
- `sendReport(report)`: POST `/diagnostics/report`; returns `{ incidentId }`. Errors
  surface via `extractErrorMessage`.
- **Renderer surfaces:** (a) `TabErrorBoundary` gains a subtle "Send diagnostic
  report" CTA; (b) IPC-error toasts (sonner) gain an optional action; (c) a Settings
  entry "Send diagnostic report" (always available). Main-process faults
  (`trackMainUnhandledRejection`, `trackChildProcessGone`) and sync/update failures
  can pre-stage an incident id that the next surfaced error offers.
- **Consent dialog** (`report-incident-dialog.tsx`): "Send a one-time diagnostic
  report? It contains redacted technical logs only — no note content." with
  **[Preview] [Send] [Not now]**. Preview expands the exact redacted lines + snapshot.
  Non-nagging: never auto-opens repeatedly; dismissible; no telemetry-style default-on.
- On send, show the `incidentId` for support reference ("Report sent — reference
  `MEMRY-XXXX`").

### Component 5 — Server ingest (`apps/sync-server`)

- `services/loki.ts`:
  - Add `kind` to stream labels: `stream: { app, env, level, kind }` where
    `kind ∈ {error, log, report}`. Existing `desktopErrorEntry` → `kind='error'`
    (back-compatible: adds a label value, no breaking change).
  - `desktopLogEntry(line, meta) → LokiEntry` (`kind='log'`, `level: warn|error`,
    includes the **redacted `message`** field + scope/action/errorCode/fields/origin/
    workerName + app_version/build_channel/platform + install_hash).
  - `desktopReportEntry(report, meta) → LokiEntry[]` (`kind='report'`, every line
    carries `incident_id`; plus one summary line with trigger + snapshot).
  - `LokiEntry.level` already allows `warn|error` — good.
- Routes (extend `routes/telemetry.ts` or a sibling `routes/diagnostics.ts`):
  - `POST /telemetry/logs`: Zod `DiagnosticLogBatchSchema`, rate-limit (reuse
    `createRateLimiter`, e.g. 120/60s), anonymous allowed, **dev no-op** (204) when
    `LOKI_URL`/`LOKI_TOKEN` unset, else `pushLokiEntries(map desktopLogEntry)` via
    `safeWaitUntil`. Bearer optional (account attribution only).
  - `POST /diagnostics/report`: Zod `DiagnosticReportSchema`, **tighter rate-limit**
    (e.g. 10/hour/IP), anonymous allowed, dev no-op when Loki unset, push
    `desktopReportEntry`. Returns `{ incidentId }` (202).
  - **Server PII guard (defense-in-depth):** before pushing, run every string field
    through a reject/scrub check for email / JWT / absolute-home-path shapes. On a hit:
    scrub (preferred) and increment a `diagnostics_pii_scrubbed` counter log; hard-
    reject (400) only for egregious secret shapes. Reuse the pattern-only `redactText`
    from the shared module (`salt=''`).
- `install_hash` reuses `hashTelemetryId(TELEMETRY_HMAC_KEY, installId)` as today.
- **Deploy first** (GitHub Actions). `/batch` unchanged.

### Component 6 — pull_page_dropped observability

The invalid-pull-response _parse_ failure already logs (`pull-coordinator.ts:454`).
The separate **silent drop** — a pull page whose cursor advances past unparseable
content returning success with no event — must emit a structured `pull_page_dropped`
diagnostic (`log.warn('pull_page_dropped', { reason, pageCount, ... })`) at the drop
site, so Path A surfaces it in Grafana. **Additive log only** — no cursor-logic
change here. Coordinate with the unmerged `sync-pull-cursor-fix` branch; do not
collide (if it lands first, attach the log to its drop site; if not, our log documents
the drop for that branch to fix).

### Component 7 — Settings, docs, rollout

- Settings (i18n): under the existing telemetry/privacy section, copy stating shared
  diagnostics "includes redacted diagnostic logs — no note content." Path B Settings
  entry "Send diagnostic report."
- Docs: update `apps/docs/src/architecture/observability.md` (new `kind=log|report`
  streams, endpoints, redaction guarantees) and the privacy docs; add Grafana queries
  for the new streams. Run `pnpm docs:impact --base <base> --strict` + `pnpm docs:build`.
- Rollout: **feature-flag / version-gate the desktop side** (reuse the feature-flags
  mechanism), **server kill switch** (Loki config unset or a flag disables ingest).

## Data flow — the Fedora case, end to end

1. User on `v2026-07-10.3` opens a note that renders blank → main logs
   `mainLog.warn('memry-file: blocked path outside allowed directories', { filePath: '/home/user/Vault/Attachments/report.pdf' })`.
2. log-ship transport catches it (≥ warn), redacts:
   `message='memry-file: blocked path outside allowed directories'`,
   `fields={ filePath: '<vault>/Attachments/[name:a1b2c3d4].pdf' }`, batches, ships to
   `/telemetry/logs` (telemetry on by default in prod).
3. Server Zod-validates, PII-guard passes, `desktopLogEntry` → Loki
   `{app=desktop, env=production, level=warn, kind=log}` with the redacted line.
4. We see it in Grafana `/d/memry-logs` filtered `kind=log app_version="v2026-07-10.3"`
   — the blocked-path, the unresolvable-signer warn, and the 403 pull error — **without
   emailing the user.**
5. If we need more, the user's error boundary already offered a one-time report; on
   consent, the last 200 redacted lines + a sync snapshot land under one `incidentId`.

## Error handling

- Every ship path is **fire-and-forget** — a failed/absent Loki config or a network
  error must never affect app behavior (mirrors existing `pushLokiEntries`).
- Transport re-entrancy guard prevents log loops.
- Client drop-4xx-except-429 keeps a poison line from wedging the queue.
- Redaction failure on a single field must not throw the whole line away silently —
  fall back to `<redaction-error>` for that value and keep the rest (and log it once,
  guarded).
- Server dev no-op returns 204/202 so a dev desktop build doesn't error-spam.

## Testing strategy

- **Redaction:** golden tests for mac/linux/windows paths, ids, emails, JWTs, IPs,
  URL query strings; the **fuzz invariant** (no raw secret survives); the three known
  lines → assert useful + clean. Server pattern-only mode tested separately.
- **Transport:** batching/flush/retry/drop mirroring `client.test.ts`; disabled-when-
  opted-out sends nothing; no-op when Loki unconfigured; re-entrancy guard; worker
  `__memryLog` ingest → redacted enqueue with `origin='worker'`.
- **Incident report:** ring buffer bounds (200 / 5 min); `previewReport` returns
  exactly what `sendReport` posts; opted-out / not-now sends nothing.
- **Contracts / IPC:** schema tests (reject email/JWT/path/raw-id shapes); IPC
  contract tests; `pnpm ipc:generate && pnpm ipc:check`.
- **worker-bundle guard green** (`logger.ts` + `log-forward.ts` electron-free).
- **E2E:** force an error → prompt appears → preview → consent → report POSTed to a
  mock endpoint; opted-out path sends nothing.
- **Full gate:** `pnpm lint && pnpm typecheck && pnpm test && pnpm ipc:check`, plus
  `pnpm docs:impact --base <base_commit> --strict` and `pnpm docs:build`;
  `git diff --check`.

## Definition of done

- Redacted desktop log lines (≥ warn) appear in Grafana `/d/memry-logs` with
  `app=desktop`, correct `env`/`level`/`kind=log`, and a redacted `message` — verified
  with a synthetic secret that does **not** appear in Loki.
- Triggering an in-app error offers a one-time report; on consent a correlated
  `incident_id` bundle lands in Loki; opting out sends nothing; preview matches what's
  sent.
- The three known failure modes (blocked path, unresolvable signer, invalid/dropped
  pull) are diagnosable from Grafana alone, with zero note content / absolute user
  paths / tokens in the payload.
- Server deployed before desktop; docs + settings updated; all gates green;
  code-review requested.

## Out of scope (v1)

- Info-level shipping (warn+error only).
- Per-stream Loki retention (single 30-day retention).
- `crdt-preflight` worker log forwarding (short-lived probe).
- Cross-user id correlation (per-install salt precludes it by design).
- Any change to `/telemetry/batch` or the existing error pipeline beyond the additive
  `kind='error'` label.
