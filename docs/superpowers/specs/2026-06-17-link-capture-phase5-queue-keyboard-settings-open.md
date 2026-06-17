# Link Capture Phase 5 — Offline queue, keyboard command, settings, "Add & open"

Date: 2026-06-17
Status: Approved (design)
Builds on: `2026-06-17-link-capture-phase4-capture-modes-design.md` (its "Non-goals (Phase 5)" section IS this scope).
Branch: stacked on `feat/link-capture-capture-modes` (Phase 4, unmerged). The two Phase 4 carry-overs (broken filed-screenshot image, selection empty-state copy) are already fixed on this branch as precursor commits.

## Goal

Make the clipper trustworthy and fast. Four deferred items, sequenced so the queue lands first and the rest reuse it:

1. **Offline queue + retry + toolbar badge** — capture when Memry is closed/unreachable; persist in `browser.storage`; retry on reconnect; badge shows pending count.
2. **Keyboard command** — an MV3 `commands` shortcut that captures the page (Article mode) without opening the popup.
3. **Settings options page** — the extension's first options UI: re-pair / unpair (token rotate) and a manual port override.
4. **"Add & open" split action** — capture, then deep-link Memry to the created inbox item, building on the existing `memry://open` launch path.

## Non-goals (Phase 6+)

Selection/screenshot capture via the keyboard command (Article only — the others need the popup or `activeTab`). Per-origin revoke when multiple extensions are paired (v1 revoke clears the whole allowlist — single-extension model). `chrome.notifications` toasts (badge is the only feedback channel). Filing a capture straight to a note/folder from the popup. Sync-server changes (queue is local to the browser).

## What already exists (verified against this branch)

- **Extension** (`apps/extension`, WXT MV3):
  - `src/entrypoints/background.ts` — owns the token + all loopback network; message switch (`GET_STATUS`, `PAIR`, `CAPTURE`, `WAIT_FOR_SERVER`, `GRAB_SCREENSHOT`). `capture(body)` (line 52) probes the server, reads the token, calls `postCapture`; returns `{ ok:false, error:'app-closed' }` when no server, `'bad-token'` when unpaired.
  - `src/lib/capture-client.ts` — `probeServer()` walks `PROBE_PORTS` (`DEFAULT_PORT=7849`, range 8). `postCapture()` returns `{ ok:false, error:'network' }` on fetch throw, `'app-closed'`/`http-<status>`/server error code otherwise. All fns take an injectable `fetchFn` for tests.
  - `src/lib/popup-state.ts` — reducer; `mapError(code)` maps error codes to copy. `SAVE_DONE` stores `itemId` on success.
  - `src/entrypoints/popup/App.tsx` — popup; `onAdd()` (line 79) dispatches `SAVE_START` → `CAPTURE` → `SAVE_DONE`; `onLaunchAndAdd()` (line 98) opens `memry://open` then saves. `PrimaryButton` is the single CTA.
  - `wxt.config.ts` — `permissions: ['storage', 'activeTab']`, `host_permissions: ['http://127.0.0.1/*']`. No `commands` key, no `options` entrypoint, no `alarms`.
- **Desktop pairing** (`apps/desktop/src/main/capture/pairing.ts`): single shared token in the OS keychain + an origin allowlist in `store`. **`rotateCaptureToken()` and `unpairCapture()` already exist** (lines 38-52) — both clear the allowlist; rotate mints a new token, unpair deletes it. No HTTP route exposes them yet.
- **Desktop capture server** (`apps/desktop/src/main/capture/server.ts`): routes `/ping`, `/pair/claim`, `/pair/request`, `/capture`. `/capture` is guarded by Bearer token + `X-Memry-Capture` header + allowed origin (`auth.ts`).
- **Desktop deep-link** (`apps/desktop/src/main/index.ts:527` `handleDeepLink`): parses `memry://`; `hostname === 'open'` currently focuses the window only. Renderer navigation uses `mainWindow.webContents.send(<EventChannel>, payload)` (e.g. `openAccountSettings` sends `SettingsChannels.events.OPEN_SECTION`).
- **Inbox** (`apps/desktop/src/renderer/src/pages/inbox.tsx`): `'inbox'` is the default page; the list view tracks item selection. `InboxChannels.events` (`packages/contracts/src/inbox-channels.ts`) has `CAPTURED`/`UPDATED`/`FILED`/… but no "open this item" event.

---

## Phase 5.1 — Offline queue + retry + badge (extension-only, +`alarms`)

The capture path already distinguishes transient failures (`app-closed`, `network`) from permanent ones (`bad-token`, `invalid-capture`, `payload-too-large`). The queue catches the transient ones.

### Storage + pure helpers (`src/lib/capture-queue.ts`, NEW, unit-tested)

- Queue shape: `QueuedCapture = { id: string; capture: ArticleCapture; queuedAt: number }`, persisted at `browser.storage.local` key `memry:capture-queue` as `QueuedCapture[]`.
- Pure helpers (no `browser.*`, fully testable):
  - `isRetryable(error: string): boolean` — `true` for `'app-closed' | 'network'`; `false` for `'bad-token' | 'origin-not-allowed' | 'invalid-capture' | 'payload-too-large' | 'pair-timeout'` and any `http-4xx`. (A 4xx is the server rejecting the payload — retrying never helps.)
  - `enqueue(queue, item, max)` / `dequeueById(queue, id)` — return new arrays. `enqueue` drops the **oldest** when length would exceed `max` (`MAX_QUEUE = 50`). `// ponytail:` 50 is a storage bound, not a product limit; upgrade path = surface "queue full" in the popup.
  - `badgeText(count: number): string` — `count === 0 ? '' : count > 99 ? '99+' : String(count)`.

### Background wiring (`background.ts`)

- A tiny storage layer: `readQueue()`, `writeQueue(q)`, and `setBadge(count)` calling `browser.action.setBadgeText` + `setBadgeBackgroundColor` (no permission — the action is implied by the popup).
- **On capture failure**: change the message-switch `CAPTURE` handler so that when `capture()` returns a retryable error, it enqueues the body, updates the badge, and returns a new `{ ok:false, error:'queued' }` shape so the popup can show "Saved offline" instead of an error. Permanent errors pass through unchanged.
- **Flush** (`flushQueue()`): probe the server; if reachable + token present, `postCapture` each item oldest-first; drop on success or permanent failure (log it); keep on retryable failure and stop the pass (server likely went away again). Recompute the badge. Returns `{ flushed, remaining }`.
- **Flush triggers** (no `alarms` needed for these): on `GET_STATUS` when the server is reachable; right after a successful manual capture; and on a new `FLUSH_QUEUE` popup message.
- **Background retry on reconnect** — the one genuinely-background trigger needs a periodic wake, and an MV3 service worker is evicted when idle. Use **`chrome.alarms`**: while the queue is non-empty, an alarm `memry-flush` fires every 1 min → `flushQueue()`; clear the alarm when the queue drains. This is the only reliable MV3 mechanism for "retry while the popup is closed", and `alarms` is a no-install-warning permission. `// ponytail:` if we ever want to drop the permission, fall back to flush-on-popup-open only and accept that the badge lingers until the user clicks the extension.

### Popup (`popup-state.ts` + `App.tsx`)

- `mapError('queued')` → "Saved offline — will sync when Memry opens." `SAVE_DONE` treats `queued` as a success-ish terminal state (a new `'queued'` action/phase, or reuse `'saved'` with a different label). Reducer unit test for the `queued` branch.

### Permissions

Add `"alarms"` to `wxt.config.ts` `permissions`. No new host permission. Badge uses the existing action.

### Gate (5.1)

`pnpm --filter @memry/extension test` (capture-queue + popup-state reducer) `| typecheck | lint | build`. Background storage/alarm wiring is manual-QA (load unpacked, capture with Memry closed → badge shows count → open Memry → within ~1 min the badge clears and the item appears in the inbox).

---

## Phase 5.2 — Keyboard command (extension-only, +`commands` manifest key)

Reuses 5.1's queue for its failure path.

- **Manifest** (`wxt.config.ts`): add a `commands` block:
  ```
  commands: {
    'capture-page': {
      suggested_key: { default: 'Ctrl+Shift+S', mac: 'Command+Shift+S' },
      description: 'Capture this page to Memry'
    }
  }
  ```
  `// ponytail:` suggested keys can silently collide with another extension; Chrome leaves them unbound and the user rebinds at `chrome://extensions/shortcuts`. `commands` is a manifest key, not a permission — no install warning.
- **Background** (`background.ts`): `browser.commands.onCommand.addListener` for `'capture-page'`:
  1. `browser.tabs.query({ active:true, currentWindow:true })` → active tab.
  2. `browser.tabs.sendMessage(tabId, { type:'EXTRACT' })` → `ArticleCapture`. The content script is declared on `*://*/*` and auto-injected, so **messaging it needs no `activeTab` grant** — the keyboard command never touches `captureVisibleTab` or programmatic injection, so no new permission. On `chrome://`/PDF/extension pages the content script isn't present; `sendMessage` rejects → brief error badge, no capture.
  3. Run the capture through the **same path as the popup** (capture → on retryable failure, enqueue + badge; reuse 5.1).
  4. Feedback without a popup: flash the badge `'✓'` for ~2s on success (best-effort; the SW is alive immediately after handling the command), or the queue count on a queued save.

### Gate (5.2)

Extension `test | typecheck | lint | build`. The onCommand handler is manual-QA: press the shortcut on a real article (Memry open → item in inbox; Memry closed → badge increments).

---

## Phase 5.3 — Settings options page (extension + one desktop route)

The extension's first options page. Re-pair / unpair / port override.

- **WXT options entrypoint** (`src/entrypoints/options/` — `index.html` + `main.tsx` + `App.tsx`), reusing the popup's Tailwind setup. WXT auto-registers it as the manifest `options_ui`. No permission.
- **Sections:**
  - **Pairing status** — read `GET_STATUS`; show `ready` / `needs-pairing` / `app-closed`.
  - **Re-pair** — runs the existing `PAIR` flow (rotates implicitly: see below).
  - **Unpair** — clears the extension's stored token AND tells the desktop to forget it (below). After unpair the extension shows `needs-pairing`.
  - **Rotate token** — presented as a single button = **unpair (revoke) then immediately re-pair**. Reuses the revoke route + existing pairing; no separate rotate route. End state = a fresh token, old token dead.
  - **Port override** — an input storing `memry:capture-port` in `browser.storage.local`. `probeServer()` checks the override port first, then falls back to `PROBE_PORTS`. Empty = auto. Pure extension change to `capture-client.ts` (unit-testable: `probeServer` already takes an injectable `fetchFn`; add an injectable port list).
- **Desktop — one new route** `POST /pair/revoke` (`server.ts`), guarded by the **same auth as `/capture`** (Bearer current token + `X-Memry-Capture` + allowed origin), calling the existing `unpairCapture()`. Returns 200. Only the currently-paired extension can revoke. `// ponytail:` `unpairCapture()` clears the whole allowlist + token (single-extension model); per-origin revoke is a Phase 6 concern, noted in Non-goals.
  - Extension side: `src/lib/capture-client.ts` gains `postRevoke(port, token)`; background gains a `REVOKE` message that calls it then clears the local token.

### Gate (5.3)

Extension `test` (port-override probe, options reducer if any) `| typecheck | lint | build`. Desktop: `pnpm --filter @memry/desktop test:main capture/server.test.ts` (new `/pair/revoke` auth + success case mocking `./pairing`) `+ typecheck:node`. Options-page UI is manual-QA.

---

## Phase 5.4 — "Add & open" split action (extension + desktop deep-link + renderer)

Capture, then open Memry focused on the created inbox item.

- **Popup** (`App.tsx`): split the single CTA into **"Add"** + a secondary **"Add & open"** (a split button, or a second button under the primary). `onAddAndOpen()` = run `onAdd()`, await the result, and on a real save (`state.itemId` present, not a `queued` save) open `browser.tabs.create({ url: 'memry://open?item=' + itemId })`. If the save queued offline, skip the open and keep the "Saved offline" copy (there's no item to open yet).
- **Desktop deep-link** (`index.ts` `handleDeepLink`): on `hostname === 'open'`, read `parsed.searchParams.get('item')`; if present, after focusing the window `mainWindow.webContents.send(InboxChannels.events.OPEN_ITEM, { itemId })`.
- **Contract** (`packages/contracts/src/inbox-channels.ts`): add `OPEN_ITEM: 'inbox:open-item'` to `InboxChannels.events`. Run `pnpm ipc:generate && pnpm ipc:check` after the contract edit.
- **Renderer**: subscribe to `OPEN_ITEM` (in the inbox page or App shell) → ensure the inbox page is active (it's the default) and open that item's detail using the inbox list's existing selection/detail mechanism. `// ponytail:` if the item isn't in the current filtered list (e.g. filtered view), fall back to focusing the inbox without selecting; don't hard-fail.

### Gate (5.4)

Extension `test | typecheck | lint | build`. Desktop: `pnpm --filter @memry/desktop typecheck:node` + `pnpm ipc:check`; deep-link parse is small and covered by `index.phase2.test.ts`-style coverage if present, else manual-QA. The renderer open-item is manual-QA.

---

## Dependency graph + sequencing

```
5.1 Offline queue + badge ─┬─> 5.2 Keyboard command   (failure path reuses the queue)
                           └─> 5.4 Add & open          (offline edge reuses the queue)
5.3 Settings options page  (independent — can land any time)
```

5.1 first: highest value, foundation reused by 5.2 and 5.4's offline edge. 5.2 next (cheap, extension-only). 5.3 and 5.4 are independent; 5.3 before 5.4 (smaller desktop surface — one auth-guarded route vs a new IPC event + renderer nav).

## Permissions / manifest summary

| Change                           | Phase | Kind                                 | Install warning?           |
| -------------------------------- | ----- | ------------------------------------ | -------------------------- |
| `alarms` permission              | 5.1   | permission                           | No (no-warning permission) |
| `commands` block                 | 5.2   | manifest key                         | No                         |
| `options` entrypoint             | 5.3   | manifest key                         | No                         |
| `POST /pair/revoke`              | 5.3   | desktop route (reuses existing auth) | n/a                        |
| `InboxChannels.events.OPEN_ITEM` | 5.4   | IPC event channel                    | n/a                        |

No new `host_permissions`. No new `captureVisibleTab` scope. No new dependencies.

## Tests / verification

- **Pure logic, unit-tested**: `capture-queue` (`isRetryable`, `enqueue`/`dequeueById` cap behavior, `badgeText`), the `queued` reducer branch, the port-override probe order.
- **Desktop unit**: `/pair/revoke` auth + success (`server.test.ts`, mocking `./pairing`).
- **Manual QA**: background queue/alarm flush loop, badge, the keyboard onCommand handler, the options-page UI, the deep-link → renderer open-item nav.
- **Per-phase gate** (the user's gate): `pnpm --filter @memry/extension test|typecheck|lint|build`; for desktop-touching phases (5.3, 5.4) add `pnpm --filter @memry/desktop test:main` (relevant file) `+ typecheck:node` and `pnpm ipc:check`. Run the docs gate (`pnpm docs:impact --base <base> --strict`) before any push, since 5.3/5.4 touch desktop.

## Acceptance — human-required GUI QA

Load the unpacked extension, run `pnpm dev`:

- **Queue**: Memry closed → capture (popup and via shortcut) → toolbar badge shows the pending count, popup says "Saved offline." Open Memry → within ~1 min the badge clears and the items land in the inbox.
- **Keyboard**: press the shortcut on a real article with Memry open → item in the inbox, no popup. On a `chrome://` page → no crash, brief error badge.
- **Settings**: open the options page → status reflects pairing; Unpair → next capture shows `needs-pairing`; Re-pair works; a wrong port override makes the app look closed, clearing it recovers.
- **Add & open**: "Add & open" → Memry comes to front with the just-captured item focused in the inbox. Offline → it saves to the queue and does not try to open.
- **Regression**: Phase 3.1 pairing/launch and Phase 4 selection/screenshot modes unchanged.

## File touch list (estimate)

**Extension:** `wxt.config.ts` (alarms + commands + options), `src/lib/capture-queue.ts` (+test), `src/lib/messages.ts` (`FLUSH_QUEUE`/`REVOKE` + `queued` shapes), `src/lib/popup-state.ts` (+test, `queued` branch), `src/lib/capture-client.ts` (port-override probe + `postRevoke`, +test), `src/entrypoints/background.ts` (queue/badge/alarm/onCommand/revoke), `src/entrypoints/popup/App.tsx` (offline copy + Add&open), `src/entrypoints/options/*` (NEW), `src/components/*` (a settings field or two).

**Desktop / contracts:** `apps/desktop/src/main/capture/server.ts` (+`server.test.ts`) for `/pair/revoke`; `apps/desktop/src/main/index.ts` (deep-link `?item=`); `packages/contracts/src/inbox-channels.ts` (`OPEN_ITEM`); a renderer inbox subscriber for `OPEN_ITEM`.

No new dependencies. New permission: `alarms` only.
