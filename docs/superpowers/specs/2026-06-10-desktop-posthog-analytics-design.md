# Desktop PostHog Product Analytics — Design

**Date:** 2026-06-10
**Status:** Approved
**Goal:** Answer "which features are used most" and enable cross-surface marketing funnels (landing → signup → desktop usage → subscription) by instrumenting the desktop app's existing telemetry pipeline, which already mirrors to PostHog.

## Context

The desktop → PostHog pipeline already exists end-to-end; what is missing is instrumentation coverage.

Already built:

- **Contract:** 40 event names in `packages/contracts/src/telemetry-api.ts` with privacy-safe validation (enum-allowlisted names, sanitized dimension values — no UUIDs/paths/emails/URLs, max 1 dimension per event, bounded metrics).
- **Plumbing:** renderer `trackTelemetry()` (`apps/desktop/src/renderer/src/lib/telemetry.ts`) and main `trackMainEvent()` (`apps/desktop/src/main/telemetry/track.ts`) → batching runtime (`apps/desktop/src/main/telemetry/runtime.ts`) → `POST /telemetry/batch` on sync-server → `writeTelemetryBatch` (`apps/sync-server/src/services/telemetry.ts`) → Cloudflare Analytics Engine **and** PostHog mirror. The desktop never talks to PostHog directly; no API key ships in the client.
- **Consent:** Settings toggle (`use-telemetry-settings.ts`, general-section.tsx); default ON in production builds, OFF elsewhere (`computeInitialEnabled` in runtime.ts); persisted in `telemetry.json` in userData.
- **Identity today:** HMAC-hashed install ID → PostHog distinct*id `memry_desktop*<env>\_<installHash>`.

The gap: account-linked identity and the remaining uninstrumented events — see "Coverage baseline" below for the verified numbers.

## Decisions

| Question | Decision                                                                                        |
| -------- | ----------------------------------------------------------------------------------------------- |
| Delivery | Extend the existing proxy pipeline. No PostHog SDK in desktop.                                  |
| Identity | Link to account when signed in, via server-verified token. Anonymous users stay install-hashed. |
| Coverage | Fill all remaining allowlist gaps plus new events (Agent Chat, command palette, updater).       |
| Consent  | Keep opt-out, default-on in production. No onboarding change.                                   |

`posthog-node` in Electron main was rejected: it ships the API key in the client bundle, duplicates the tested batching/offline-queue/consent infrastructure, loses the Analytics Engine mirror, and adds a second egress path. The proxy design keeps the call sites SDK-agnostic, so a direct SDK (e.g. for feature flags) could be added later without re-instrumenting.

## Architecture

```
renderer trackTelemetry() ──IPC──▶ main runtime (batch/queue/consent)
main trackMainEvent() ────────────▶        │
                                           ▼  POST /telemetry/batch  (+ optional Bearer token)
                                    sync-server writeTelemetryBatch
                                      ├─▶ Analytics Engine (unchanged, HMAC hashes only)
                                      └─▶ PostHog mirror (distinct_id resolution below)
```

### Identity merge (the only infrastructure change)

- **Desktop:** when signed in, the telemetry client attaches `Authorization: Bearer <access_token>` to the batch POST. Signed out → no header; behavior identical to today.
- **Sync-server `/telemetry/batch`:** authentication becomes _optional_.
  - Valid token → PostHog `distinct_id = user.id` — the same key `captureBusinessEvent` uses for `user_signed_up` / `subscription_activated` / `device_registered` / `vault_registered`, so cross-surface funnels join. The mirror also emits a `$identify` event with `$anon_distinct_id = memry_desktop_<env>_<installHash>` so PostHog merges the pre-signin person into the account person.
  - Missing or invalid token → fall back to install-hash distinct_id. The batch is **never rejected** for auth reasons.
- Identity is server-verified; the payload cannot assert an account. Event properties are unchanged. The Analytics Engine write path is untouched.
- **Known deviation from `authMiddleware`:** telemetry identity is verified-but-not-revocation-checked — the JWT signature/claims are verified, but there is no devices-table lookup. A revoked device's unexpired token (≤15 min TTL) can still attribute telemetry to the account. Accepted for write-only telemetry; do not assume parity with the real auth path.

## Coverage baseline (verified 2026-06-10) and remaining work

**Correction:** 29 of 40 contract events already fire — core loop (notes, journal, tasks, project, `search_performed`), inbox, calendar, sync, vault, app lifecycle diagnostics, and `page_viewed` are instrumented in main IPC handlers and `telemetry/diagnostics.ts`. The earlier "only ~3 fire" estimate came from grepping the wrong symbol name and was wrong.

Instrumentation continues to sit in **main-process IPC handlers** wherever possible: renderer-initiated CRUD flows through them (single choke point) and sync-applied remote changes do not, so remote writes never pollute usage counts. Renderer call sites are used only for UI-only events.

Remaining work:

### A. Identity merge

As designed above: sync-server optional auth + `$identify`, desktop bearer header.

### B. Noise control

`note_updated` (notes-handlers.ts) and `journal_updated` (journal-handlers.ts) currently fire **unthrottled on every autosave**. Add the 5-minute per-document throttle.

### C. Missing contract events

- `app_backgrounded`, `app_active_heartbeat` — main lifecycle (`main/index.ts`, `telemetry/diagnostics.ts`)
- `onboarding_started`, `onboarding_completed` — `vault-onboarding.tsx`
- `setting_changed` — `settings-handlers.ts` SET handler; setting key as the single dimension
- `search_result_opened` — command palette result opens (`command-palette.tsx`), objectType note/task/journal

Deliberately not instrumented:

- `graph_opened` — redundant; `page_viewed` already fires with surface `graph`
- `search_opened` — the command palette is the search surface; `command_palette_opened` (below) covers it
- `voice_recording_completed`, `transcription_completed`, `ai_action_completed` — deferred to a follow-up plan; the inbox voice flow needs its own exploration

### D. New events (contract extension)

Add to `TelemetryEventNameSchema`:

- `agent_chat_started`, `agent_chat_message_sent` — `agent/runtime/turn.ts`; properties carry the backend/provider label only, never prompt or message content. Reuse the existing `ai` surface.
- `command_palette_opened` — `command-palette.tsx` open transition; palette result opens fire the existing `search_result_opened`.
- `app_update_installed` — fires on first launch after a version change, compared against `lastRunVersion` persisted in `telemetry.json`; surface `updater`.

Contract edits require `pnpm ipc:generate` then `pnpm ipc:check`.

## Noise control

`note_updated` and `journal_updated` fire on autosave and would emit thousands of events per session. A small throttle helper in the main telemetry module caps them at **one event per document per 5 minutes** (in-memory map, cleared on app quit; no persistence needed). All other events are discrete user actions and fire unthrottled. `app_active_heartbeat` uses the existing batching cadence.

## Privacy and error handling

All existing guarantees stand, unchanged:

- Event names must be in the contract enum; dimension values are sanitized (no UUIDs, emails, URLs, paths; ≤64 chars; ≤1 dimension).
- No note/journal/task content, titles, or identifiers ever leave the device.
- Wrappers never throw; telemetry failure cannot break the app.
- Consent checked in the runtime; toggle in Settings; default-on only in production builds.
- Batch endpoint rate-limited (60 req/min/IP) and capped at 100 events per batch.

## Testing

- **Desktop unit tests:** per instrumented handler, assert the event fires with the right name/surface/action/result shape (mock `getTelemetryRuntime`). Throttle helper gets its own test (fires once, suppresses within window, fires after window).
- **Sync-server tests:** `/telemetry/batch` with valid token → distinct_id is user.id and `$identify` merge emitted; with no/invalid token → install-hash path, request still 202.
- **Contract tests:** new enum values round-trip through `TelemetryEventSchema`.
- **Gates:** `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm ipc:generate` + `pnpm ipc:check` (Phase 4), `pnpm docs:impact --base origin/main --strict` with telemetry docs updated under `apps/docs/src`.

## Out of scope (follow-ups)

- PostHog dashboards/insights for feature usage (build after Phase 1 data lands).
- Landing-page `posthog-js` instrumentation.
- PostHog feature flags / session replay (replay intentionally excluded for privacy).
- Backfilling or re-keying historical Analytics Engine data.
