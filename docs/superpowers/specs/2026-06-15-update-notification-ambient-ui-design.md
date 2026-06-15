# Ambient update notification UI

Date: 2026-06-15
Status: Design (pending review)
Owner: Kaan

## Problem

Auto-update interrupts the user with native dialogs on startup: a "new version
available → Download?" popup (`update-available`), then a "Restart now?" popup
(`update-downloaded`). The popups are intrusive and easy to dismiss-and-forget.

Goal: remove the startup popups. Surface updates as an ambient, dismissible UI
affordance the user opens on their own time, with an in-app "What's new" view.

## Decisions (locked)

1. **Placement:** a slim banner row at the bottom of the left sidebar, directly
   above the existing footer (sync / vault / settings). Visible only when an
   update is in play; hidden otherwise.
2. **Details action:** clicking the banner opens an in-app "What's new" modal
   that renders the release notes already on the wire, with the primary action
   (Download / Restart) inline and a secondary "View on GitHub" link.
3. **Scope:** replace BOTH native popups. The banner cycles through states:
   Update available → Downloading… N% → Restart to update. Startup is silent.

## Current state (what already exists)

- Main `apps/desktop/src/main/updater.ts` runs the electron-updater state
  machine and broadcasts `AppUpdateState` to the renderer on every event
  (`UpdaterChannels.events.STATE_CHANGED`). `autoDownload = false`,
  `autoInstallOnAppQuit = true`.
- `AppUpdateState` (in `@memry/contracts/ipc-updater`) already carries
  everything the UI needs: `status`, `availableVersion`, `releaseName`,
  `releaseDate`, `releaseNotes` (already HTML-stripped to plain text),
  `downloadProgressPercent`, `currentVersion`, `error`.
- Renderer hook `use-app-updater.ts` exposes `state` + `checkForUpdates`,
  `downloadUpdate`, `quitAndInstall`. Currently consumed only by Settings →
  General (`pages/settings/general-section.tsx`).
- IPC handlers exist: GET_STATE, CHECK_FOR_UPDATES, DOWNLOAD_UPDATE,
  QUIT_AND_INSTALL (`ipc/updater-handlers.ts`).
- `quitAndInstall` was just fixed to install via graceful shutdown (PR #570).

So this feature is mostly: stop auto-popping the dialogs in main, and add
renderer UI that reads the state already broadcast.

## New behavior

### Main process (`updater.ts`)

- Remove the auto-popup calls: delete `void promptToDownload(info)` from the
  `update-available` handler and `void promptToRestart(info)` from the
  `update-downloaded` handler.
- Delete the now-unused `promptToDownload`, `promptToRestart`,
  `downloadPromptVisible`, `restartPromptVisible`, and `buildPromptDetail`.
  The `dialog` import becomes unused → remove it. `normalizeReleaseNotes` stays
  (still used to populate `state.releaseNotes`).
- Keep the full state machine and broadcasting unchanged — that is what drives
  the new UI. `autoDownload` stays `false` (download is user-initiated from the
  modal). `autoInstallOnAppQuit` stays `true`.
- Net: startup performs the check silently; the renderer reacts to state.

### Renderer

**State → UI mapping** (single source of truth = `AppUpdateState.status`):

| status        | banner                          | modal primary action |
| ------------- | ------------------------------- | -------------------- |
| idle/checking | hidden                          | n/a                  |
| up-to-date    | hidden                          | n/a                  |
| unavailable   | hidden                          | n/a                  |
| available     | "↑ Update available · Details"  | Download             |
| downloading   | "Downloading… N%"               | progress (disabled)  |
| downloaded    | "Restart to update"             | Restart now          |
| error         | "Update failed · Retry" (muted) | Retry (check again)  |

**New components:**

1. `contexts/updater-context.tsx` — `UpdaterProvider` + `useUpdater()`. Wraps the
   existing `useAppUpdater` logic so the banner, the modal, and Settings share
   ONE subscription/state, plus modal open/close state (`isDetailsOpen`,
   `openDetails()`, `closeDetails()`). Mounted high in `App.tsx`.

2. `components/sidebar/sidebar-update-banner.tsx` — the slim row. Reads
   `useUpdater()`; returns `null` for hidden statuses. For `available`/`error`
   click opens the modal; for `downloaded` click opens the modal (primary =
   Restart). Shows progress text for `downloading`. Collapsed-sidebar
   (`group-data-[collapsible=icon]`) variant: icon + dot only, tooltip with the
   label. Uses logical Tailwind classes (RTL-safe).

3. `components/updater/update-details-dialog.tsx` — the "What's new" modal built
   on `ui/dialog.tsx`. Header: "Memrynote {availableVersion} is available"
   (or "What's new in {currentVersion}" when already downloaded). Body: release
   notes (`state.releaseNotes`, rendered with preserved line breaks; empty-state
   fallback text). Footer: status-dependent primary button (Download /
   Downloading… / Restart now / Retry) + "View on GitHub" secondary link +
   Close. Mounted once at root next to `SettingsModal` in `App.tsx`.

**Wiring:**

- `app-sidebar.tsx`: render `<SidebarUpdateBanner />` between `</SidebarContent>`
  and `<SidebarFooter>`.
- `App.tsx`: wrap with `UpdaterProvider`; mount `<UpdateDetailsDialog />` near
  `<SettingsModal />`.
- `pages/settings/general-section.tsx`: switch from `useAppUpdater()` to
  `useUpdater()` so Settings and the banner never diverge. Existing Settings
  updater UI otherwise unchanged.

### "View on GitHub" link

- Requires a generic external-URL opener. No generic `openExternal(url)` exists
  in the renderer today (only note-specific `notes.openExternal(id)`). Add a
  small IPC: `app:open-external` in `packages/contracts`, a preload binding,
  and a main handler that reuses the existing `lib/external-url.ts` allowlist
  (https/http/mailto, from #549). Run `pnpm ipc:generate && pnpm ipc:check`.
- URL: the GitHub releases page, `https://github.com/memrynote/memry/releases`
  (link to the tag when `availableVersion` is known). NOTE: if the repo is
  private, this page is not publicly viewable — the in-app notes are the primary
  surface and the link is a secondary affordance. Confirm repo visibility during
  planning; drop the link if private.

## i18n

Add renderer strings (en/common.json is the only gate per i18n:check):
banner labels per status, modal title variants, button labels (Download,
Downloading, Restart now, Retry, View on GitHub, Close), empty-notes fallback.
Reuse existing `settings:phaseI` error strings where they fit.

## Testing

- **Main** (`updater.test.ts`): assert `dialog.showMessageBox` is NEVER called on
  `update-available` or `update-downloaded` (popups removed) while `state`
  still transitions correctly. Update/replace the existing dialog-assertion
  tests. Keep the quitAndInstall graceful-shutdown tests from PR #570.
- **Renderer:**
  - `sidebar-update-banner.test.tsx`: hidden for idle/up-to-date/unavailable;
    correct label per status; click opens modal; `downloaded` label correct.
  - `update-details-dialog.test.tsx`: renders notes; correct primary action per
    status; Download → `downloadUpdate`, Restart → `quitAndInstall`,
    View on GitHub → `openExternal` with the releases URL.
  - Mock `@/components/ui/dialog`/`picker` per the renderer jsdom convention if
    needed.
- `pnpm ipc:check` green after the new external-URL contract.

## Edge cases

- Download race: the banner reflects whatever `status` the main process
  broadcasts; clicking Restart only calls `quitAndInstall` when `downloaded`
  (button disabled otherwise) — consistent with the PR #570 guard.
- `error` state: banner is muted, non-blocking; Retry re-runs `checkForUpdates`.
- Collapsed sidebar: icon-only with a dot + tooltip.
- Dev/unsupported builds (`status: unavailable`): banner hidden, no modal.

## Out of scope

- Background auto-download (kept manual; user starts it from the modal).
- Rich markdown rendering of notes beyond line breaks (notes are already plain
  text from `normalizeReleaseNotes`).
- Changing the Settings → General updater layout beyond the shared-state swap.
- Update channels / staged rollout.

## Files touched (estimate)

Main: `updater.ts`, `updater.test.ts`, `ipc/` (new external handler),
`lib/external-url.ts` (reuse). Contracts: `packages/contracts` (new
`app:open-external`), preload binding. Renderer: `contexts/updater-context.tsx`
(new), `components/sidebar/sidebar-update-banner.tsx` (new),
`components/updater/update-details-dialog.tsx` (new), `app-sidebar.tsx`,
`App.tsx`, `pages/settings/general-section.tsx`, i18n `en/common.json`.
