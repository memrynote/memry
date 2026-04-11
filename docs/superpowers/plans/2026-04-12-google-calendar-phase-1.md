# Google Calendar Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a new top-level Calendar workspace with day/week/month/year views, first-class Memry events, imported Google calendars, two-way editing of Memry events, tasks, reminders, and inbox snoozes through Google Calendar, and synced calendar data across Memry devices.

**Architecture:** Keep phase 1 calendar code inside `apps/desktop/src/main/calendar/` and `apps/desktop/src/renderer/src/components/calendar/` instead of adding a new workspace package. Store calendar records in `data.db` with record clocks, sync Memry calendar entities and shared provider metadata through the existing encrypted Memry record-sync pipeline, expose a new calendar IPC/RPC surface, and feed both Calendar and journal schedule panels from one unified projection service. Keep Google access/refresh tokens and loopback OAuth state device-local in the OS keychain; sync shareable provider-link metadata, imported cache, and bindings across devices.

**Tech Stack:** Electron, React 19, TypeScript, Drizzle ORM, better-sqlite3, TanStack Query, Zod, Vitest, Playwright

---

## Chunk 1: Persistence, Sync Foundation & Contracts

### Task 1: Add Syncable Calendar Storage and Repositories

**Files:**
- Create: `packages/db-schema/src/schema/calendar-events.ts`
- Create: `packages/db-schema/src/schema/calendar-sources.ts`
- Create: `packages/db-schema/src/schema/calendar-external-events.ts`
- Create: `packages/db-schema/src/schema/calendar-bindings.ts`
- Modify: `packages/db-schema/src/data-schema.ts`
- Create: `apps/desktop/src/main/calendar/repositories/calendar-events-repository.ts`
- Create: `apps/desktop/src/main/calendar/repositories/calendar-sources-repository.ts`
- Create: `apps/desktop/src/main/calendar/repositories/calendar-external-events-repository.ts`
- Create: `apps/desktop/src/main/calendar/repositories/calendar-events-repository.test.ts`
- Generated: `apps/desktop/src/main/database/drizzle-data/0024_*.sql`
- Modify: `apps/desktop/src/main/database/drizzle-data/meta/_journal.json`

- [ ] Write a failing repository test in `apps/desktop/src/main/calendar/repositories/calendar-events-repository.test.ts` that proves the storage layer can:
  - create/update/archive a `calendar_events` row
  - persist sync clocks for `calendar_events`, shared provider-link rows, external event cache rows, and bindings
  - persist provider accounts and selected Google calendars without storing device-local credentials in the synced row
  - persist imported Google event cache rows
  - persist sync bindings for `event | task | reminder | inbox_snooze`
- [ ] Run `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/main/calendar/repositories/calendar-events-repository.test.ts` and confirm it fails on missing schema/repository code.
- [ ] Add Drizzle tables in:
  - `packages/db-schema/src/schema/calendar-events.ts`
  - `packages/db-schema/src/schema/calendar-sources.ts`
  - `packages/db-schema/src/schema/calendar-external-events.ts`
  - `packages/db-schema/src/schema/calendar-bindings.ts`
- [ ] Export the new tables from `packages/db-schema/src/data-schema.ts`.
- [ ] Implement repository helpers in:
  - `apps/desktop/src/main/calendar/repositories/calendar-events-repository.ts`
  - `apps/desktop/src/main/calendar/repositories/calendar-sources-repository.ts`
  - `apps/desktop/src/main/calendar/repositories/calendar-external-events-repository.ts`
- [ ] Run `pnpm db:generate` and inspect the generated migration under `apps/desktop/src/main/database/drizzle-data/0024_*.sql` plus the updated `meta/_journal.json`.
- [ ] Re-run `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/main/calendar/repositories/calendar-events-repository.test.ts` until it passes.
- [ ] Commit this chunk with a focused message such as `feat: add syncable calendar storage foundation`.

### Task 2: Extend Sync Contracts and Server Allow-Lists for Calendar Records

**Files:**
- Modify: `packages/contracts/src/sync-api.ts`
- Modify: `packages/contracts/src/sync-phase-foundation.test.ts`
- Modify: `apps/sync-server/src/services/sync.ts`
- Modify: `apps/sync-server/src/services/sync-telemetry.ts`
- Modify: `apps/sync-server/src/services/sync-telemetry.test.ts`
- Modify: `apps/sync-server/src/foundation-contracts.test.ts`

- [ ] Extend the sync foundation tests so they fail until `calendar_event`, `calendar_source`, `calendar_binding`, and `calendar_external_event` are treated as encrypted record-sync types.
- [ ] Update `packages/contracts/src/sync-api.ts` so the new calendar item types are added to:
  - `SYNC_ITEM_TYPES`
  - `RECORD_SYNC_ITEM_TYPES`
  - `RECORD_CLOCK_REQUIRED_ITEM_TYPES`
  - `ENCRYPTABLE_ITEM_TYPES`
- [ ] Update the sync-server allow-lists and telemetry summaries in:
  - `apps/sync-server/src/services/sync.ts`
  - `apps/sync-server/src/services/sync-telemetry.ts`
- [ ] Re-run targeted contracts and sync-server Vitest coverage until the new item types are accepted end to end.
- [ ] Commit this chunk with a focused message such as `feat: add calendar sync item types`.

### Task 3: Add Desktop Calendar Record-Sync Services and Item Handlers

**Files:**
- Create: `apps/desktop/src/main/sync/calendar-event-sync.ts`
- Create: `apps/desktop/src/main/sync/calendar-source-sync.ts`
- Create: `apps/desktop/src/main/sync/calendar-binding-sync.ts`
- Create: `apps/desktop/src/main/sync/calendar-external-event-sync.ts`
- Create: `apps/desktop/src/main/sync/item-handlers/calendar-event-handler.ts`
- Create: `apps/desktop/src/main/sync/item-handlers/calendar-source-handler.ts`
- Create: `apps/desktop/src/main/sync/item-handlers/calendar-binding-handler.ts`
- Create: `apps/desktop/src/main/sync/item-handlers/calendar-external-event-handler.ts`
- Create: `apps/desktop/src/main/sync/item-handlers/calendar-event-handler.test.ts`
- Modify: `apps/desktop/src/main/sync/item-handlers/index.ts`
- Modify: `apps/desktop/src/main/sync/runtime.ts`
- Modify: `apps/desktop/src/main/sync/local-mutations.ts`

- [ ] Write a failing sync-handler test in `apps/desktop/src/main/sync/item-handlers/calendar-event-handler.test.ts` that proves calendar records can:
  - enqueue local create/update/delete mutations
  - serialize into encrypted record-sync payloads
  - apply remote upserts/deletes back into the local calendar tables
  - preserve remote ids/bindings/import cache rows across devices
- [ ] Run `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/main/sync/item-handlers/calendar-event-handler.test.ts` and confirm the calendar sync services/handlers do not exist yet.
- [ ] Implement record-sync services in:
  - `apps/desktop/src/main/sync/calendar-event-sync.ts`
  - `apps/desktop/src/main/sync/calendar-source-sync.ts`
  - `apps/desktop/src/main/sync/calendar-binding-sync.ts`
  - `apps/desktop/src/main/sync/calendar-external-event-sync.ts`
- [ ] Implement the desktop remote-sync handlers in:
  - `apps/desktop/src/main/sync/item-handlers/calendar-event-handler.ts`
  - `apps/desktop/src/main/sync/item-handlers/calendar-source-handler.ts`
  - `apps/desktop/src/main/sync/item-handlers/calendar-binding-handler.ts`
  - `apps/desktop/src/main/sync/item-handlers/calendar-external-event-handler.ts`
- [ ] Register the new handlers and local sync adapters in:
  - `apps/desktop/src/main/sync/item-handlers/index.ts`
  - `apps/desktop/src/main/sync/runtime.ts`
  - `apps/desktop/src/main/sync/local-mutations.ts`
- [ ] Re-run `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/main/sync/item-handlers/calendar-event-handler.test.ts` until it passes.
- [ ] Commit this chunk with a focused message such as `feat: add calendar record sync adapters`.

### Task 4: Add Calendar Contracts, IPC, RPC, and Renderer Service

**Files:**
- Create: `packages/contracts/src/calendar-api.ts`
- Modify: `packages/contracts/src/ipc-channels.ts`
- Create: `packages/rpc/src/calendar.ts`
- Modify: `packages/rpc/src/index.ts`
- Create: `apps/desktop/src/main/ipc/calendar-handlers.ts`
- Create: `apps/desktop/src/main/ipc/calendar-handlers.test.ts`
- Modify: `apps/desktop/src/main/ipc/index.ts`
- Create: `apps/desktop/src/renderer/src/services/calendar-service.ts`
- Generated: `apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts`
- Generated: `apps/desktop/src/preload/generated-rpc.ts`
- Generated: `apps/desktop/src/preload/index.d.ts`

- [ ] Write a failing IPC test in `apps/desktop/src/main/ipc/calendar-handlers.test.ts` covering:
  - create/update/delete/list for Memry events
  - range queries that return projected calendar items
  - provider status/list-source/connect/disconnect entry points
  - event subscriptions for calendar item changes
- [ ] Run `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/main/ipc/calendar-handlers.test.ts` and confirm the calendar handler surface does not exist yet.
- [ ] Add `CalendarChannels` and any new event channel constants in `packages/contracts/src/ipc-channels.ts`.
- [ ] Define the public calendar schemas and types in `packages/contracts/src/calendar-api.ts`.
- [ ] Add the calendar RPC domain in `packages/rpc/src/calendar.ts` and export it from `packages/rpc/src/index.ts`.
- [ ] Implement the main-process handler registration in `apps/desktop/src/main/ipc/calendar-handlers.ts` and wire it into `apps/desktop/src/main/ipc/index.ts`.
- [ ] Add the renderer-facing wrapper in `apps/desktop/src/renderer/src/services/calendar-service.ts`.
- [ ] Run `pnpm ipc:generate` to update:
  - `apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts`
  - `apps/desktop/src/preload/generated-rpc.ts`
  - `apps/desktop/src/preload/index.d.ts`
- [ ] Run `pnpm ipc:check`.
- [ ] Re-run `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/main/ipc/calendar-handlers.test.ts` until it passes.
- [ ] Commit this chunk with a focused message such as `feat: add calendar IPC and RPC surface`.

## Chunk 2: Google Provider Loop & Unified Projection

### Task 5: Implement Separate Google Calendar OAuth and Token Storage

**Files:**
- Create: `apps/desktop/src/main/calendar/google/oauth.ts`
- Create: `apps/desktop/src/main/calendar/google/keychain.ts`
- Create: `apps/desktop/src/main/calendar/google/oauth.test.ts`
- Modify: `apps/desktop/src/main/ipc/calendar-handlers.ts`
- Modify: `apps/desktop/src/renderer/src/services/calendar-service.ts`

- [ ] Write a failing OAuth/unit test in `apps/desktop/src/main/calendar/google/oauth.test.ts` that proves:
  - Google Calendar uses a provider-specific OAuth flow with Calendar scopes
  - callback state is validated
  - provider refresh tokens are stored separately from Memry sync auth and remain device-local
  - disconnect removes provider tokens and local provider records cleanly
- [ ] Run `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/main/calendar/google/oauth.test.ts` and confirm there is no provider auth layer yet.
- [ ] Implement provider-specific loopback OAuth in `apps/desktop/src/main/calendar/google/oauth.ts`; do **not** reuse `sync-handlers.ts` or `token-manager.ts` for Google Calendar auth.
- [ ] Implement provider keychain helpers in `apps/desktop/src/main/calendar/google/keychain.ts` using the existing local keychain patterns rather than `KEYCHAIN_ENTRIES`.
- [ ] Add calendar IPC methods for connect/disconnect/status flows in `apps/desktop/src/main/ipc/calendar-handlers.ts`.
- [ ] Expose those methods through `apps/desktop/src/renderer/src/services/calendar-service.ts`.
- [ ] Re-run `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/main/calendar/google/oauth.test.ts` until it passes.
- [ ] Commit this chunk with a focused message such as `feat: add Google Calendar auth flow`.

### Task 6: Build Google Sync Mapping and the Unified Projection Service

**Files:**
- Create: `apps/desktop/src/main/calendar/types.ts`
- Create: `apps/desktop/src/main/calendar/projection.ts`
- Create: `apps/desktop/src/main/calendar/projection.test.ts`
- Create: `apps/desktop/src/main/calendar/google/client.ts`
- Create: `apps/desktop/src/main/calendar/google/mappers.ts`
- Create: `apps/desktop/src/main/calendar/google/sync-service.ts`
- Create: `apps/desktop/src/main/calendar/google/sync-service.test.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/main/ipc/calendar-handlers.ts`

- [ ] Write a failing projection test in `apps/desktop/src/main/calendar/projection.test.ts` that proves a single range query can return:
  - Memry events
  - task-backed all-day and timed items
  - reminder-backed items
  - snooze-backed items
  - imported Google events
  with stable source metadata and editability flags.
- [ ] Write a failing provider-sync test in `apps/desktop/src/main/calendar/google/sync-service.test.ts` covering:
  - push mapping for Memry events, tasks, reminders, and snoozes
  - write-back mapping from Google edits into native source records
  - imported event cache and binding updates being written into synced calendar tables rather than device-only state
  - Google delete semantics clearing task/reminder/snooze scheduling instead of deleting the source record
- [ ] Run:
  - `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/main/calendar/projection.test.ts`
  - `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/main/calendar/google/sync-service.test.ts`
  and confirm both fail before implementation.
- [ ] Implement shared calendar types in `apps/desktop/src/main/calendar/types.ts`.
- [ ] Implement the main-process projection service in `apps/desktop/src/main/calendar/projection.ts`.
- [ ] Implement the Google HTTP client and mapping layer in:
  - `apps/desktop/src/main/calendar/google/client.ts`
  - `apps/desktop/src/main/calendar/google/mappers.ts`
  - `apps/desktop/src/main/calendar/google/sync-service.ts`
- [ ] Start the provider sync runner from `apps/desktop/src/main/index.ts` alongside the reminder and snooze schedulers, but keep failures non-fatal like the existing startup pattern.
- [ ] Add a `syncNow`/refresh path to `apps/desktop/src/main/ipc/calendar-handlers.ts` so the renderer can force a pull after connect/disconnect.
- [ ] Ensure a device without local Google auth can still project synced external events and bindings from Memry sync, while provider refresh/publish/write-back stays disabled until that device connects Google.
- [ ] Re-run both targeted Vitest commands until they pass.
- [ ] Commit this chunk with a focused message such as `feat: add calendar projection and Google sync`.

## Chunk 3: Calendar Workspace UI

### Task 7: Add Calendar as a First-Class Tab and Sidebar Destination

**Files:**
- Create: `apps/desktop/src/renderer/src/pages/calendar.tsx`
- Modify: `apps/desktop/src/renderer/src/components/split-view/tab-content.tsx`
- Modify: `apps/desktop/src/renderer/src/App.tsx`
- Modify: `apps/desktop/src/renderer/src/components/app-sidebar.tsx`
- Modify: `apps/desktop/src/renderer/src/components/sidebar/sidebar-nav.tsx`
- Modify: `apps/desktop/src/renderer/src/hooks/use-sidebar-navigation.ts`
- Modify: `apps/desktop/src/renderer/src/contexts/tabs/types.ts`
- Modify: `apps/desktop/src/renderer/src/contexts/tabs/helpers.ts`
- Modify: `apps/desktop/src/renderer/src/components/tabs/new-tab-menu.tsx`
- Modify: `apps/desktop/src/renderer/src/components/tabs/tab-icon.tsx`
- Modify: `apps/desktop/src/renderer/src/lib/icons/sidebar-nav-icons.tsx`

- [ ] Write a failing renderer test in `apps/desktop/src/renderer/src/pages/calendar.test.tsx` that proves the app can open a singleton `calendar` tab from:
  - the main sidebar
  - the new-tab menu
  - direct tab-content routing
- [ ] Run `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/renderer/src/pages/calendar.test.tsx` and confirm the tab type and route do not exist yet.
- [ ] Add `calendar` to the tab model in:
  - `apps/desktop/src/renderer/src/contexts/tabs/types.ts`
  - `apps/desktop/src/renderer/src/contexts/tabs/helpers.ts`
  - `apps/desktop/src/renderer/src/components/tabs/tab-icon.tsx`
- [ ] Add the sidebar and new-tab entry points in:
  - `apps/desktop/src/renderer/src/components/app-sidebar.tsx`
  - `apps/desktop/src/renderer/src/components/sidebar/sidebar-nav.tsx`
  - `apps/desktop/src/renderer/src/components/tabs/new-tab-menu.tsx`
  - `apps/desktop/src/renderer/src/lib/icons/sidebar-nav-icons.tsx`
- [ ] Add Calendar page routing in:
  - `apps/desktop/src/renderer/src/App.tsx`
  - `apps/desktop/src/renderer/src/components/split-view/tab-content.tsx`
  - `apps/desktop/src/renderer/src/hooks/use-sidebar-navigation.ts`
- [ ] Re-run `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/renderer/src/pages/calendar.test.tsx` until it passes.
- [ ] Commit this chunk with a focused message such as `feat: add calendar workspace navigation`.

### Task 8: Build the Calendar Page, Views, and Event Editor

**Files:**
- Create: `apps/desktop/src/renderer/src/components/calendar/calendar-shell.tsx`
- Create: `apps/desktop/src/renderer/src/components/calendar/calendar-toolbar.tsx`
- Create: `apps/desktop/src/renderer/src/components/calendar/calendar-sidebar.tsx`
- Create: `apps/desktop/src/renderer/src/components/calendar/calendar-day-view.tsx`
- Create: `apps/desktop/src/renderer/src/components/calendar/calendar-week-view.tsx`
- Create: `apps/desktop/src/renderer/src/components/calendar/calendar-month-view.tsx`
- Create: `apps/desktop/src/renderer/src/components/calendar/calendar-year-view.tsx`
- Create: `apps/desktop/src/renderer/src/components/calendar/calendar-item-chip.tsx`
- Create: `apps/desktop/src/renderer/src/components/calendar/calendar-event-editor-drawer.tsx`
- Create: `apps/desktop/src/renderer/src/components/calendar/index.ts`
- Create: `apps/desktop/src/renderer/src/hooks/use-calendar-range.ts`
- Create: `apps/desktop/src/renderer/src/hooks/use-calendar-range.test.tsx`
- Create: `apps/desktop/src/renderer/src/components/calendar/calendar-page.test.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/calendar.tsx`

- [ ] Write a failing page-level test in `apps/desktop/src/renderer/src/components/calendar/calendar-page.test.tsx` that proves:
  - day/week/month/year switching works
  - the sidebar can toggle imported Google calendars vs Memry-owned items
  - creating/editing a Memry event opens the editor drawer
  - projected task/reminder/snooze items render with distinct source styling
- [ ] Write a failing query-hook test in `apps/desktop/src/renderer/src/hooks/use-calendar-range.test.tsx` that proves the hook refetches when calendar events change.
- [ ] Run:
  - `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/renderer/src/components/calendar/calendar-page.test.tsx`
  - `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/renderer/src/hooks/use-calendar-range.test.tsx`
  and confirm the page shell does not exist yet.
- [ ] Implement the shared query hook in `apps/desktop/src/renderer/src/hooks/use-calendar-range.ts`.
- [ ] Implement the UI shell and view components in:
  - `apps/desktop/src/renderer/src/components/calendar/calendar-shell.tsx`
  - `apps/desktop/src/renderer/src/components/calendar/calendar-toolbar.tsx`
  - `apps/desktop/src/renderer/src/components/calendar/calendar-sidebar.tsx`
  - `apps/desktop/src/renderer/src/components/calendar/calendar-day-view.tsx`
  - `apps/desktop/src/renderer/src/components/calendar/calendar-week-view.tsx`
  - `apps/desktop/src/renderer/src/components/calendar/calendar-month-view.tsx`
  - `apps/desktop/src/renderer/src/components/calendar/calendar-year-view.tsx`
  - `apps/desktop/src/renderer/src/components/calendar/calendar-item-chip.tsx`
  - `apps/desktop/src/renderer/src/components/calendar/calendar-event-editor-drawer.tsx`
- [ ] Wire the page in `apps/desktop/src/renderer/src/pages/calendar.tsx`.
- [ ] Re-run both targeted Vitest commands until they pass.
- [ ] Commit this chunk with a focused message such as `feat: add calendar views and event editor`.

### Task 9: Replace Dummy Journal Schedule Data and Reuse Existing Task Drag Mechanics

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/journal/journal-day-panel.tsx`
- Modify: `apps/desktop/src/renderer/src/components/journal/day-context-sidebar.tsx`
- Modify: `apps/desktop/src/renderer/src/components/journal/floating-day-context.tsx`
- Modify: `apps/desktop/src/renderer/src/contexts/drag-context.tsx`
- Modify: `apps/desktop/src/renderer/src/hooks/use-drag-handlers.ts`
- Create: `apps/desktop/src/renderer/src/components/journal/journal-day-panel.test.tsx`

- [ ] Write a failing journal test in `apps/desktop/src/renderer/src/components/journal/journal-day-panel.test.tsx` that proves the journal schedule surfaces use projected calendar data instead of `getDummySchedule`.
- [ ] Run `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/renderer/src/components/journal/journal-day-panel.test.tsx` and confirm the test fails because the journal still uses placeholder events.
- [ ] Replace `getDummySchedule` in `apps/desktop/src/renderer/src/components/journal/journal-day-panel.tsx` with the real calendar query/service.
- [ ] Keep `apps/desktop/src/renderer/src/components/journal/day-context-sidebar.tsx` and `apps/desktop/src/renderer/src/components/journal/floating-day-context.tsx` as presentational components; update their props/callers only as needed for real calendar source metadata.
- [ ] Extend the existing task drag wiring in:
  - `apps/desktop/src/renderer/src/contexts/drag-context.tsx`
  - `apps/desktop/src/renderer/src/hooks/use-drag-handlers.ts`
  so moving a task on the calendar updates its actual due datetime instead of creating a separate planning slot.
- [ ] Re-run `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/renderer/src/components/journal/journal-day-panel.test.tsx` until it passes.
- [ ] Commit this chunk with a focused message such as `feat: reuse calendar projection in journal`.

### Task 10: Add Google Calendar Integration UX in Settings

**Files:**
- Modify: `apps/desktop/src/renderer/src/lib/integration-registry.ts`
- Modify: `apps/desktop/src/renderer/src/components/settings/integration-list.tsx`
- Create: `apps/desktop/src/renderer/src/components/settings/google-calendar-integration-row.tsx`
- Create: `apps/desktop/src/renderer/src/components/settings/google-calendar-source-picker.tsx`
- Create: `apps/desktop/src/renderer/src/components/settings/google-calendar-integration-row.test.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/settings/integrations-section.tsx`

- [ ] Write a failing settings test in `apps/desktop/src/renderer/src/components/settings/google-calendar-integration-row.test.tsx` that proves the integrations screen can:
  - start the Google Calendar connect flow
  - display connection status
  - show the dedicated Memry calendar
  - toggle imported calendar sources on/off
  - disconnect cleanly
- [ ] Run `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/renderer/src/components/settings/google-calendar-integration-row.test.tsx` and confirm the generic “coming soon” row is insufficient.
- [ ] Mark Google Calendar as a real integration in `apps/desktop/src/renderer/src/lib/integration-registry.ts`.
- [ ] Replace the generic connect button path in `apps/desktop/src/renderer/src/components/settings/integration-list.tsx` with a dedicated Google Calendar row component.
- [ ] Implement the connect/status/source-picker UI in:
  - `apps/desktop/src/renderer/src/components/settings/google-calendar-integration-row.tsx`
  - `apps/desktop/src/renderer/src/components/settings/google-calendar-source-picker.tsx`
- [ ] Ensure `apps/desktop/src/renderer/src/pages/settings/integrations-section.tsx` renders the richer Google-specific controls without breaking other integrations.
- [ ] Re-run `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/renderer/src/components/settings/google-calendar-integration-row.test.tsx` until it passes.
- [ ] Commit this chunk with a focused message such as `feat: add Google Calendar settings UI`.

## Chunk 4: Verification & Ship Criteria

### Task 11: Verify the Calendar Milestone End to End

**Files:**
- Create: `apps/desktop/tests/e2e/calendar.e2e.ts`

- [ ] Add `apps/desktop/tests/e2e/calendar.e2e.ts` covering the renderer flow with mocked calendar IPC data:
  - open Calendar workspace
  - switch day/week/month/year
  - create/edit a Memry event
  - render imported Google items and native task/reminder/snooze items together
  - confirm journal day panel uses the same projection
- [ ] Run targeted automated checks:

```bash
pnpm ipc:generate
pnpm ipc:check
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts \
  src/main/sync/item-handlers/calendar-event-handler.test.ts \
  src/main/calendar/repositories/calendar-events-repository.test.ts \
  src/main/calendar/google/oauth.test.ts \
  src/main/calendar/google/sync-service.test.ts \
  src/main/calendar/projection.test.ts \
  src/main/ipc/calendar-handlers.test.ts \
  src/renderer/src/pages/calendar.test.tsx \
  src/renderer/src/components/calendar/calendar-page.test.tsx \
  src/renderer/src/hooks/use-calendar-range.test.tsx \
  src/renderer/src/components/journal/journal-day-panel.test.tsx \
  src/renderer/src/components/settings/google-calendar-integration-row.test.tsx
pnpm --filter @memry/desktop exec playwright test tests/e2e/calendar.e2e.ts
pnpm lint
pnpm typecheck
```

- [ ] Perform a live manual QA pass against a real Google test account because CI will not validate external OAuth and remote calendar side effects:
  - connect a Google Calendar account from Settings > Integrations
  - import at least one existing Google calendar
  - verify the dedicated Google `Memry` calendar is created
  - create a Memry event and verify it appears in Google
  - sign into a second Memry device and verify synced calendar events, selected sources, bindings, and imported cache appear there through Memry sync
  - on the second device, verify calendar rendering still works before Google auth is completed locally
  - drag a task from all-day to a timed slot and verify the task’s due datetime changes
  - move a reminder in Google and verify `remindAt` changes locally
  - move a snoozed inbox item in Google and verify `snoozedUntil` changes locally
  - delete the Google mirror of a task/reminder/snooze and verify the local source record survives while its calendar-driving datetime is cleared
- [ ] Record any failures as follow-up tasks before landing.

## Notes for the Implementer

- Keep Google provider auth completely separate from Memry sync auth. The existing `sync-handlers.ts` Google OAuth flow is for Memry account sign-in, not Google Calendar scopes.
- Do not introduce a separate task planning-slot model in this milestone. Calendar movement edits the real task due datetime.
- Keep `day-context-sidebar.tsx` and `floating-day-context.tsx` mostly presentational; the source of truth should move into the new calendar query/projection service, not into more journal-specific logic.
- Reuse existing drag-and-drop primitives where possible. The renderer already understands the concept of `calendar-task` drags and date-cell drops; extend that path instead of adding a second task drag system.
- Treat imported Google events as imported events, not auto-converted tasks.
- Sync calendar events, imported event cache, shared provider-link metadata, and bindings through the existing encrypted Memry pipeline in phase 1.
- Keep Google access/refresh tokens and local OAuth session state device-local. A device can render synced calendar data without provider auth, but it cannot refresh/publish/write back to Google until the user connects that device.
