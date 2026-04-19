# Google Calendar Phase 2 Design

## Goal

Turn the current one-directional-ish Memry ↔ Google Calendar integration into a fully adaptive two-way sync: every create, update, and delete on either side reaches the other reliably, offline-tolerant, conflict-safe, and push-driven where possible.

Phase 1 (shipped) proved the architecture: OAuth + PKCE, a unified projection layer, per-source `calendar_bindings`, and polling inbound sync. Phase 2 closes the correctness gaps, extends the data model, replaces polling with Google push notifications, adds multi-account support, and adds trusted-device Google auth transfer during QR linking.

## Amendment (2026-04-20)

The original M7 plan proposed syncing Google refresh tokens through Memry's normal encrypted record-sync pipeline. The mandatory security review rejected that design. M7 is still part of phase 2, but it is redesigned:

- Google refresh tokens remain device-local secrets during normal operation.
- Cross-device portability happens only during trusted QR device linking.
- The transfer uses the existing short-lived encrypted linking session, not `calendar_sources`, sync items, or any durable token blob on the sync server.
- Recovery-phrase setup and later refresh-token drift are allowed to require Google re-consent on the affected device.

## Product Decisions (closed during brainstorming 2026-04-18, amended 2026-04-20)

All seven milestones below are in phase 2. We ship them sequentially; no rush.

1. **Webhook stack:** Cloudflare Workers + D1. New `POST /webhooks/google-calendar` route on `apps/sync-server`; no 3rd-party relay.
2. **Cross-device token portability (M7):** in phase 2, but not via durable sync payloads. Portable Google auth is provided during trusted QR device linking by transferring encrypted refresh tokens through the existing short-lived linking session only. Dedicated security review gate remains mandatory before implementation.
3. **"Promote external event" (M2.2):** implicit with one-time confirmation. External Google events open read-only; clicking Edit shows *"Editing this event will create a linked copy in Memry so changes sync both ways. Continue?"* with a *don't ask again* option. On confirm, Memry creates a `calendar_events` + `calendar_bindings` pair pointing at the same `remoteEventId` and archives the `calendar_external_events` mirror.
4. **Default target Google calendar for Memry-created events:** per-event picker with last-used memory. First-time onboarding prompt at Google connect: *"Which calendar should new Memry events go to by default?"* — lists the user's calendars, preselects their primary. Choice persisted in `settings`. Falls back to the auto-created `Memry` calendar only if the user dismisses onboarding without choosing.

## Current State Audit (2026-04-18)

Anchored in code at commit `d54ba6de`.

### What works
- OAuth 2.0 + PKCE loopback flow ([oauth.ts](../../../apps/desktop/src/main/calendar/google/oauth.ts)), tokens stored in keytar, scoped to `https://www.googleapis.com/auth/calendar` + identity.
- Inbound pull every 5 min via `syncGoogleCalendarNow()` using Google `syncToken` (stored as `syncCursor`). External events land in `calendar_external_events`.
- Outbound push on local create/update via `pushSourceToGoogleCalendar()` — maps events, tasks, reminders, and inbox snoozes to Google events; auto-creates a `Memry`-named calendar on first push.
- Outbound delete via `deleteSourceFromGoogleCalendar()`.
- `calendar_bindings` table glues any Memry source type to a remote `(calendarId, eventId, etag)`.
- Device-to-device sync for calendar entities via existing `SyncItemHandler` pattern ([item-handlers/calendar-*](../../../apps/desktop/src/main/sync/item-handlers/)).
- Offline creates queue through `SyncQueueManager` like tasks/notes.

### Confirmed gaps (ordered by ROI)

| # | Gap | Evidence |
|---|---|---|
| G1 | Google → Memry writeback for bound sources is implemented but never invoked by the pull loop | `applyGoogleCalendarWriteback` defined in [sync-service.ts:354](../../../apps/desktop/src/main/calendar/google/sync-service.ts) but `syncGoogleCalendarSource` loop only upserts into the read-only mirror ([sync-service.ts:544](../../../apps/desktop/src/main/calendar/google/sync-service.ts)) |
| G2 | Deletions on Google side do not propagate | Google returns `status='cancelled'` in incremental sync; loop has no branch for it |
| G3 | External Google events are read-only in Memry | No promote/edit path |
| G4 | All Memry→Google writes go to auto-created "Memry" calendar | Hard-coded in `ensureMemryCalendarSource` ([sync-service.ts:113](../../../apps/desktop/src/main/calendar/google/sync-service.ts)) |
| G5 | No etag/`If-Match`/412 conflict handling on push | `remoteVersion` stored but unused as a precondition |
| G6 | Poll-only inbound (5 min) | No Google push channel registration; no sync-server webhook |
| G7 | Recurring event single-instance edits unsupported | `recurrenceExceptions` column exists, no mapping in `mapCalendarEventToGoogleInput` |
| G8 | No attendees / reminders / visibility / colorId | Schema lacks fields; mappers drop them |
| G9 | Single Google account only | Schema supports `kind='account'`, OAuth flow does not |
| G10 | No sync health surface in UI | `syncStatus` written but never read by renderer |
| G11 | No vector-clock merge for calendar events | External events bypass `mergeFields`; LWW on etag |
| G12 | Google tokens are device-local only | keytar only; new device re-auths from scratch |

## Architecture (7 milestones)

Each milestone produces working, testable software on its own and ships as its own PR. Each gets its own implementation plan file written just before we start it.

### M1 — Correctness fixes (unblocks everything)

**Goal:** Fix G1, G2, and a missing 410 Gone branch. Smallest-possible wiring change in `sync-service.ts`. No new schema.

**Core change:** extend the `for (const remoteEvent of result.events)` loop in `syncGoogleCalendarSource` so that before upserting into `calendar_external_events`, it checks for an existing `calendar_binding` on `(remoteCalendarId, remoteEventId)`. If found:
- `status === 'cancelled'` → call `applyGoogleCalendarDelete(binding, remote)`
- otherwise → call `applyGoogleCalendarWriteback(binding, remote)`
- skip the external-event mirror write (the event is bound, not shadowed)

If no binding exists, keep existing mirror upsert. For `status==='cancelled'` without a binding, archive the mirror row instead of re-upserting.

**410 Gone handling:** when `client.listEvents` throws a 410, clear `syncCursor`, mark `syncStatus='pending'`, re-invoke self once.

**Files:** `sync-service.ts` only. New tests in `sync-service.test.ts`.

**Plan file:** `docs/superpowers/plans/2026-04-18-google-calendar-phase-2-m1-correctness.md` (drafted alongside this spec).

### M2 — Calendar targeting + editable externals

**Goal:** Fix G3, G4. Let users pick which Google calendar Memry writes to; let users edit externally-owned Google events from within Memry.

**Changes:**
- Add `targetCalendarId: string | null` to `CreateCalendarEventSchema` and `UpdateCalendarEventSchema` in `packages/contracts/src/calendar-api.ts`.
- Persist `targetCalendarId` on the `calendar_events` row (new column + migration `0025_event_target_calendar.sql`). Required for binding resolution; when `null`, fall back to default (see below).
- New `settings` keys: `calendar.google.defaultTargetCalendarId`, `calendar.google.onboardingCompleted`.
- Onboarding IPC flow on first Google connect: `GET /users/me/calendarList` → surface picker → write setting.
- Modify `pushSourceToGoogleCalendar` to consult `targetCalendarId` → fall back to setting default → fall back to Memry-managed calendar.
- Renderer: calendar picker in event editor; default option = last used for this user; persists in `settings`.
- "Promote external" flow (G3): renderer adds Edit button to external event detail view; confirmation dialog; IPC call `calendar.promoteExternalEvent(externalEventId)` copies fields into a new `calendar_events` row, creates a binding using the mirror's `remoteEventId`/`remoteCalendarId`, archives the mirror, publishes projection change.

**Files:** contracts, schema, repositories, sync-service, new `promote-external-event.ts`, renderer event drawer, new onboarding component.

### M3 — Conflict resolution with etag + field clocks

**Goal:** Fix G5, G11.

**Push conflict:** `client.upsertEvent` takes `ifMatch?: string`. On 412 Precondition Failed, pull the latest remote, invoke `mergeCalendarEventFields(local, remote)` using a new helper modelled on `mergeTaskFields`, push the merged result (new etag). On 3 consecutive failures, surface a conflict toast and stop retrying.

**Field clocks:** `CALENDAR_EVENT_SYNCABLE_FIELDS` covers `title, description, location, startAt, endAt, timezone, isAllDay, recurrenceRule, recurrenceExceptions`. Schema adds `field_clocks` JSON column to `calendar_events` (migration `0026_calendar_field_clocks.sql`). Handler updates use the same `initAllFieldClocks` fallback pattern as tasks/projects.

**Files:** new `field-merge-calendar.ts`, modify `sync-service.ts` push path, modify calendar-event-handler, schema + migration, tests.

### M4 — Google push channel (biggest architectural change)

**Goal:** Fix G6. Replace 5-min polling with sub-second push when available; keep polling as fallback.

**Server changes** (`apps/sync-server`):
- New route file `apps/sync-server/src/routes/webhooks.ts` exposing `POST /webhooks/google-calendar`.
- New service `apps/sync-server/src/services/google-webhooks.ts` that:
  - Validates `X-Goog-Channel-Id`, `X-Goog-Channel-Token` (shared secret), `X-Goog-Resource-State` (`sync | exists | not_exists`).
  - Looks up `userId + calendarSourceId` from a new D1 table `google_calendar_channels`.
  - Fans out over existing user `UserSyncState` Durable Object with a new broadcast type `calendar_changes_available: { sourceId }`.
- Migration for D1: `google_calendar_channels(channel_id PK, user_id, source_id, resource_id, token, expires_at, created_at)` with TTL cleanup in existing cleanup cron.

**Desktop changes:**
- `client.watchCalendar({ calendarId, channelId, token, webhookUrl, ttlSeconds })` wraps Google `events.watch`.
- New `google-channel-manager.ts`: on connect/selection change, for each selected source register a channel expiring in 7 days; before expiry, rotate. On disconnect, `channels.stop`.
- WebSocket message handler: on `calendar_changes_available`, invoke `syncGoogleCalendarSource` for the specific source (not full sync).
- 5-min poll remains as fallback; reduced to 30 min when at least one active channel exists.

**Security:** channel token is a 32-byte random secret shared between desktop and sync-server (server side stored hashed). Webhook rejects if hash mismatch.

**Files:** sync-server new route/service, D1 migration, desktop new manager, client extension, integration tests.

### M5 — Data-model completeness + recurrence exceptions

**Goal:** Fix G7, G8.

**Schema additions** to both `calendar_events` and `calendar_external_events` (migration `0027_calendar_rich_fields.sql`):
- `attendees` JSON (`[{ email, displayName?, responseStatus, optional? }]`)
- `reminders` JSON (`{ useDefault: bool, overrides: [{ method: 'email'|'popup', minutes }] }`)
- `visibility` TEXT (`default|public|private|confidential`)
- `colorId` TEXT
- `conferenceData` JSON (Meet link, phone numbers, etc.)

**Mapper updates:** include new fields in both directions. Recurrence exceptions: extend `mapCalendarEventToGoogleInput` to emit `EXDATE` lines derived from `recurrenceExceptions`. Handle single-instance edits: when user edits one occurrence of a recurring Memry event, Google expects a child event with `recurringEventId + originalStartTime`. Add `parentEventId`, `originalStartTime` nullable columns to `calendar_events`.

**Handler updates:** new syncable fields added to `CALENDAR_EVENT_SYNCABLE_FIELDS`; `mergeCalendarEventFields` covers them.

**Renderer:** optional UI for attendees, reminders, visibility in event editor. First pass can be read-only; editable in follow-up.

### M6 — Multi-account + sync health UI

**Goal:** Fix G9, G10.

**Multi-account:**
- OAuth flow accepts `accountId` param; keytar keys suffixed by `accountId`.
- `calendar_sources.kind='account'` rows store one per Google account.
- Connect/disconnect IPC gains `accountId` field; `GET_CALENDAR_PROVIDER_STATUS` returns array of accounts.
- UI: Settings → Calendar → "Add another Google account" button. List shows per-account calendars grouped.
- `pushSourceToGoogleCalendar` resolves `targetCalendarId` → account via `calendar_sources.accountId` → uses the right keytar entry.

**Sync health widget:**
- New renderer component `calendar-sync-health.tsx` subscribed to a new projection event `calendar_sync_status_changed`.
- Per source: icon + `syncStatus` + `lastSyncedAt` + last error message (if any).
- "Retry now" button invokes `syncGoogleCalendarSource(id)`.
- Surface in Sources panel and as a small status chip in calendar header.

### M7 — Cross-device token portability (security-gated, redesigned 2026-04-20)

**Goal:** Fix G12 without durable token sync. A second trusted Memry device linked via QR can reuse Google auth without re-running OAuth.

**Security review conclusion:**
- Storing Google refresh tokens in `calendar_sources` and syncing them through the normal encrypted record-sync pipeline was rejected.
- Approved approach: move refresh tokens only through the existing QR device-link channel, which is already short-lived, encrypted, session-bound, and explicit user-approved.

**Core design:**
- The approving device gathers Google refresh tokens from local keychain for all connected Google accounts.
- Only refresh tokens are exported. Access tokens remain device-local and short-lived.
- The transfer bundle is versioned: `version: 1`, `providers: Array<{ provider: 'google'; accountId: string; refreshToken: string }>`
- The bundle is encrypted with the existing linking `encKey` using XChaCha20-Poly1305, bound to the linking `sessionId` in AAD, and protected with a separate MAC/confirm field derived from the linking `macKey`.
- The sync server stores the provider-auth payload only on the short-lived linking session row. It is never copied into sync items, `calendar_sources`, or durable server-side ciphertext for calendar auth.
- The receiving device finalizes Memry device registration first, then decrypts and imports the refresh tokens into local keychain.
- If keychain persistence fails for one or more imported accounts, device linking still succeeds and the UI surfaces a non-fatal reconnect warning.

**Operational semantics:**
- QR-linked devices can immediately refresh Google access tokens locally.
- Recovery-phrase setup does not receive Google refresh tokens; those devices show reconnect-required until the user re-consents with Google on that device.
- Google refresh-token rotation is local-only. If Google rotates a token on one device and another device later hits `invalid_grant`, that device transitions to reconnect-required instead of attempting cross-device token reconciliation.
- Disconnect continues to clear local Google auth per device; there is no cross-device token blob to tombstone.

**Files:** linking contracts, sync-server linking session persistence, desktop linking flow, Google keychain helpers, local auth status surfaces, reconnect UI.

## Testing strategy

| Layer | What | Tooling |
|---|---|---|
| Unit | mappers (round-trip), field merges, webhook signature validation, QR-link provider-auth crypto | Vitest |
| Integration | sync-service against a mock `GoogleCalendarClient` covering pull/push/delete/412/410/cancelled | Vitest |
| IPC | calendar-handlers for new contracts (targeting, promote, multi-account, reconnect-required state) | Vitest |
| Sync-server | linking route/service with provider-auth payload persistence and completion flow | Vitest + `@cloudflare/workers-types` mocks |
| E2E | real Google test account behind `GOOGLE_CALENDAR_E2E=1` flag. Golden path: offline create → reconnect → event appears on Google. Delete from Google → disappears in Memry within 1 poll or 1 webhook. Trusted QR-linked second device can sync without re-running Google OAuth. | Playwright + Electron |

E2E runs only in CI for PRs touching `calendar/google/**`, `apps/sync-server/src/routes/webhooks.ts`, or linking flow code. Uses a dedicated Google test account with credentials in CI secrets; cleanup hook deletes all events at start.

## Risks

1. **Google API quotas.** Default per-user quota is 1,000,000 reads/day — polling 5 min × 24 h × N calendars is nowhere near. Push channels also cheap. But `events.watch` has a 500/day channel creation quota per project — need to rotate channels sanely (7-day TTL, not 1-hour).
2. **Webhook public URL.** `events.watch` requires an HTTPS endpoint with a domain verified in Google Cloud Console. Need to verify `sync.memry.io` (or whatever the production domain is) before M4 can be tested end-to-end.
3. **Clock drift between devices corrupting field clocks.** Existing `mergeFields` already handles this for tasks/projects; same logic applies.
4. **Refresh-token drift after initial device linking.** Google may rotate the refresh token on one device. This redesign accepts drift and recovers by marking stale devices reconnect-required rather than reintroducing durable token sync.
5. **Breakage of existing handlers.** All 4 existing calendar handlers need minor tweaks across M3 and M5. Regression tests in `item-handlers/*.test.ts` stay green throughout.

## Unresolved questions (defer until the relevant milestone lands)

- **M4 webhook URL** — production and staging domains need verification in Google Cloud Console. Who owns that? (Probably Kaan + DNS config.)
- **M5 attendee UX** — how much of Google's invitation flow do we surface? Minimum-viable is read-only attendee list; full flow is a separate design.
- **M6 multi-account naming** — if the user has two Google accounts each with a "Work" calendar, how do we disambiguate in UI? Account email suffix is likely fine.
- **M7 manual auth import** — do we ever want a post-setup "import Google auth from another trusted device" flow outside QR linking, or is reconnect-on-demand sufficient?

## Links

- Phase 1 design: [2026-04-12-google-calendar-phase-1-design.md](2026-04-12-google-calendar-phase-1-design.md)
- Phase 1 implementation plan: [2026-04-12-google-calendar-phase-1.md](../plans/2026-04-12-google-calendar-phase-1.md)
- M1 implementation plan: [2026-04-18-google-calendar-phase-2-m1-correctness.md](../plans/2026-04-18-google-calendar-phase-2-m1-correctness.md)
