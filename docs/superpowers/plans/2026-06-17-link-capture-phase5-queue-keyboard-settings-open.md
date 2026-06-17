# Link Capture Phase 5 — Offline queue, keyboard command, settings, "Add & open" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the clipper trustworthy: queue captures when Memry is unreachable and retry on reconnect (badge shows the count), add a keyboard shortcut to capture without the popup, ship a settings options page (re-pair / unpair / port override), and an "Add & open" action that deep-links to the captured item.

**Architecture:** 5.1 builds an extension-local offline queue in `browser.storage.local` with a `chrome.alarms`-driven retry and an action badge; pure queue logic is isolated into a tested helper. 5.2 reuses that queue from a `commands` keyboard handler that messages the already-declared content script (no new permission). 5.3 adds a WXT options page plus one auth-guarded desktop route `/pair/revoke` (the desktop already has `unpairCapture()`/`rotateCaptureToken()`). 5.4 adds an `InboxChannels.events.OPEN_ITEM` event, a `memry://open?item=<id>` deep-link parse, and a popup split button.

**Tech Stack:** WXT MV3 + React 19 (extension), Electron main + React renderer (desktop), Zod contracts, Vitest. No new dependencies.

## Global Constraints

- Prettier: single quotes, NO semicolons, 100-char width, no trailing commas — copy verbatim from `CLAUDE.md`.
- Tailwind logical properties only: `ms/me`, `ps/pe`, `start/end`, `text-start/text-end` — never `ml/mr/pl/pr/left/right`.
- NO `Co-Authored-By` trailer on commits.
- Commit ONLY the task's files by explicit path. NEVER `git add -A` (the working tree has untracked `import-prompt/`, `marketing/`, and unrelated `apps/marketing-emails` edits that must not be committed).
- Import the capture contract via the subpath `@memry/contracts/capture-api`, never the barrel.
- **No new dependencies.** The ONLY new permission is `alarms` (5.1). `commands` and `options_ui` are manifest keys, not permissions. No new `host_permissions`.
- Branch: `feat/link-capture-capture-modes` (Phase 4, stacked). The Phase 4 carry-over fixes are already committed (`b83c60b5`, `e7568a37`); the spec is `cf9c1e73`.
- Spec: `docs/superpowers/specs/2026-06-17-link-capture-phase5-queue-keyboard-settings-open.md`.
- Native-module gotcha: if a desktop `test:main` run fails with `better-sqlite3 ERR_DLOPEN_FAILED` or `cleanupTestDatabase ... reading 'close'`, run `pnpm --filter @memry/desktop rebuild:node` and retry.

---

## File Structure

**Extension (`apps/extension`):**

- `src/lib/capture-queue.ts` — NEW. Pure queue logic (`isRetryable`, `enqueue`, `dequeueById`, `badgeText`, `QueuedCapture`, `MAX_QUEUE`).
- `src/lib/capture-queue.test.ts` — NEW.
- `src/lib/messages.ts` — add `FLUSH_QUEUE`/`REVOKE` popup messages + `FlushResponse`.
- `src/lib/popup-state.ts` — add `'queued'` phase/action + `SAVE_DONE` branch.
- `src/lib/popup-state.test.ts` — reducer tests for the `queued` branch.
- `src/lib/capture-client.ts` — `probeServer(fetchFn, ports)` overload + `postRevoke` + `revokeUrl`.
- `src/lib/capture-client.test.ts` — port-list probe + `postRevoke` tests. (Create if absent.)
- `src/entrypoints/background.ts` — queue/badge/flush/alarms, `captureOrQueue`, `onCommand`, `REVOKE`, port-override probe.
- `src/entrypoints/popup/App.tsx` — offline copy + "Add & open" split button.
- `src/entrypoints/options/index.html` + `main.tsx` + `App.tsx` — NEW options page.
- `wxt.config.ts` — `alarms` permission, `commands` block.

**Desktop / contracts:**

- `apps/desktop/src/main/capture/server.ts` (+ `server.test.ts`) — `POST /pair/revoke`.
- `packages/contracts/src/inbox-channels.ts` — `OPEN_ITEM` event.
- `apps/desktop/src/main/index.ts` — `parseInboxOpenItemId` helper + deep-link `?item=` send.
- `apps/desktop/src/main/index.deeplink.test.ts` — NEW, pure helper test (or fold into an existing index test file).
- A renderer inbox subscriber for the generated `OPEN_ITEM` event.

---

## Task 1: Capture-queue pure helpers (extension)

**Files:**

- Create: `apps/extension/src/lib/capture-queue.ts`
- Test: `apps/extension/src/lib/capture-queue.test.ts`

**Interfaces:**

- Produces (consumed by Tasks 3, 4):
  - `QueuedCapture = { id: string; capture: ArticleCapture; queuedAt: number }`
  - `MAX_QUEUE = 50`
  - `isRetryable(error: string): boolean`
  - `enqueue(queue: QueuedCapture[], item: QueuedCapture, max?: number): QueuedCapture[]`
  - `dequeueById(queue: QueuedCapture[], id: string): QueuedCapture[]`
  - `badgeText(count: number): string`

- [ ] **Step 1: Write the failing test**

Create `apps/extension/src/lib/capture-queue.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { ArticleCapture } from '@memry/article-extract'
import { badgeText, dequeueById, enqueue, isRetryable, MAX_QUEUE } from './capture-queue'

const cap = { url: 'https://x.test' } as unknown as ArticleCapture
const item = (id: string) => ({ id, capture: cap, queuedAt: 0 })

describe('isRetryable', () => {
  it('retries only unreachable-server errors', () => {
    expect(isRetryable('app-closed')).toBe(true)
    expect(isRetryable('network')).toBe(true)
  })
  it('does not retry payload/auth/4xx/5xx failures', () => {
    expect(isRetryable('bad-token')).toBe(false)
    expect(isRetryable('origin-not-allowed')).toBe(false)
    expect(isRetryable('invalid-capture')).toBe(false)
    expect(isRetryable('payload-too-large')).toBe(false)
    expect(isRetryable('http-413')).toBe(false)
    expect(isRetryable('http-500')).toBe(false)
  })
})

describe('enqueue', () => {
  it('appends to the end', () => {
    expect(enqueue([item('a')], item('b')).map((q) => q.id)).toEqual(['a', 'b'])
  })
  it('drops the oldest when over the cap', () => {
    const r = enqueue([item('a'), item('b')], item('c'), 2)
    expect(r.map((q) => q.id)).toEqual(['b', 'c'])
  })
  it('defaults to MAX_QUEUE', () => {
    expect(MAX_QUEUE).toBe(50)
  })
})

describe('dequeueById', () => {
  it('removes the matching item', () => {
    expect(dequeueById([item('a'), item('b')], 'a').map((q) => q.id)).toEqual(['b'])
  })
})

describe('badgeText', () => {
  it('blanks at zero, caps at 99+', () => {
    expect(badgeText(0)).toBe('')
    expect(badgeText(5)).toBe('5')
    expect(badgeText(150)).toBe('99+')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/extension test -- capture-queue`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `apps/extension/src/lib/capture-queue.ts`:

```ts
import type { ArticleCapture } from '@memry/article-extract'

export interface QueuedCapture {
  id: string
  capture: ArticleCapture
  queuedAt: number
}

export const MAX_QUEUE = 50

// Retryable = the server was unreachable, not the payload being bad. Pairing,
// validation, 4xx and 5xx codes are permanent — retrying never helps and a 5xx
// loop would spin forever on a server bug. ponytail: upgrade path = backoff-retry
// 5xx a few times before dropping.
export function isRetryable(error: string): boolean {
  return error === 'app-closed' || error === 'network'
}

// Append, dropping the oldest when the queue would exceed `max`.
export function enqueue(
  queue: QueuedCapture[],
  item: QueuedCapture,
  max = MAX_QUEUE
): QueuedCapture[] {
  const next = [...queue, item]
  return next.length > max ? next.slice(next.length - max) : next
}

export function dequeueById(queue: QueuedCapture[], id: string): QueuedCapture[] {
  return queue.filter((q) => q.id !== id)
}

export function badgeText(count: number): string {
  if (count <= 0) return ''
  return count > 99 ? '99+' : String(count)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/extension test -- capture-queue`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/lib/capture-queue.ts apps/extension/src/lib/capture-queue.test.ts
git commit -m "feat(extension): offline capture-queue pure helpers"
```

---

## Task 2: Queue messages + `queued` reducer state (extension)

**Files:**

- Modify: `apps/extension/src/lib/messages.ts`
- Modify: `apps/extension/src/lib/popup-state.ts`
- Test: `apps/extension/src/lib/popup-state.test.ts`

**Interfaces:**

- Produces (consumed by Tasks 3, 7, 9):
  - `PopupMessage` += `{ type: 'FLUSH_QUEUE' }`, `{ type: 'REVOKE' }`
  - `FlushResponse = { flushed: number; remaining: number }`
  - `Phase` += `'queued'`; `PopupState.action` union += `'queued'`; `SAVE_DONE` with `error === 'queued'` → action `'queued'` (a success-ish terminal state, not an error).

- [ ] **Step 1: Extend messages.ts**

In `apps/extension/src/lib/messages.ts`, extend `PopupMessage` and add `FlushResponse` after `ScreenshotResponse`:

```ts
export type PopupMessage =
  | { type: 'GET_STATUS' }
  | { type: 'PAIR' }
  | { type: 'CAPTURE'; capture: ArticleCapture }
  | { type: 'WAIT_FOR_SERVER' }
  | { type: 'GRAB_SCREENSHOT' }
  | { type: 'FLUSH_QUEUE' }
  | { type: 'REVOKE' }
```

```ts
export interface FlushResponse {
  flushed: number
  remaining: number
}
```

- [ ] **Step 2: Write the failing reducer tests**

In `apps/extension/src/lib/popup-state.test.ts`, add (reuse the existing `reducer`, `initialState`, `selectPhase` imports):

```ts
describe('offline queue state', () => {
  it('SAVE_DONE with a queued result is a terminal queued state, not an error', () => {
    const mid = reducer(initialState, { type: 'SAVE_START' })
    const s = reducer(mid, { type: 'SAVE_DONE', result: { ok: false, error: 'queued' } })
    expect(s.action).toBe('queued')
    expect(s.errorMessage).toBeNull()
    expect(selectPhase(s)).toBe('queued')
  })

  it('SAVE_DONE with a real error still maps to error', () => {
    const s = reducer(initialState, {
      type: 'SAVE_DONE',
      result: { ok: false, error: 'bad-token' }
    })
    expect(s.action).toBe('error')
    expect(selectPhase(s)).toBe('error')
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @memry/extension test -- popup-state`
Expected: FAIL — `'queued'` action/phase not handled.

- [ ] **Step 4: Update popup-state.ts**

Add `'queued'` to the `Phase` union (after `'saved'`):

```ts
export type Phase =
  | 'extracting'
  | 'capturing'
  | 'app-closed'
  | 'launching'
  | 'ready'
  | 'approving'
  | 'saving'
  | 'saved'
  | 'queued'
  | 'error'
```

Add `'queued'` to `PopupState.action`:

```ts
action: 'idle' | 'launching' | 'approving' | 'saving' | 'saved' | 'queued' | 'error'
```

Replace the `SAVE_DONE` case:

```ts
    case 'SAVE_DONE':
      if (action.result.ok) {
        return { ...state, action: 'saved', itemId: action.result.itemId }
      }
      if (action.result.error === 'queued') {
        return { ...state, action: 'queued', errorMessage: null }
      }
      return { ...state, action: 'error', errorMessage: mapError(action.result.error) }
```

In `selectPhase`, add the queued check right after the `saved` check:

```ts
if (state.action === 'saved') return 'saved'
if (state.action === 'queued') return 'queued'
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @memry/extension test -- popup-state`
Expected: PASS (existing + 2 new).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @memry/extension typecheck`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add apps/extension/src/lib/messages.ts apps/extension/src/lib/popup-state.ts apps/extension/src/lib/popup-state.test.ts
git commit -m "feat(extension): queued capture state + flush/revoke messages"
```

---

## Task 3: Background queue + badge + flush + alarms (extension, manual-QA)

**Files:**

- Modify: `apps/extension/wxt.config.ts`
- Modify: `apps/extension/src/entrypoints/background.ts`
- Modify: `apps/extension/src/entrypoints/popup/App.tsx`

**Interfaces:**

- Consumes: `capture-queue` helpers (Task 1), `FlushResponse` + `'queued'` state (Task 2), `probeServer`/`postCapture` (`capture-client`).
- Produces: `captureOrQueue(body)` and `flushQueue()` used by Task 4; the `'queued'` popup rendering used by Task 9.

- [ ] **Step 1: Add the `alarms` permission**

In `apps/extension/wxt.config.ts`, change the permissions line:

```ts
    permissions: ['storage', 'activeTab', 'alarms'],
```

- [ ] **Step 2: Add queue + badge + flush + alarm wiring to background.ts**

In `apps/extension/src/entrypoints/background.ts`, update the imports:

```ts
import type {
  CaptureResponse,
  FlushResponse,
  PageMetrics,
  PairResponse,
  PopupMessage,
  ScreenshotResponse,
  StatusResponse
} from '@/lib/messages'
import type { ArticleCapture } from '@memry/article-extract'
import { claimToken, pollUntil, postCapture, probeServer, requestPair } from '@/lib/capture-client'
import { bytesToDataUrl, planStitch } from '@/lib/capture-modes'
import {
  badgeText,
  dequeueById,
  enqueue,
  isRetryable,
  type QueuedCapture
} from '@/lib/capture-queue'
```

Add the queue layer above `export default defineBackground` (after the existing `getToken`/`setToken` helpers):

```ts
const QUEUE_KEY = 'memry:capture-queue'
const FLUSH_ALARM = 'memry-flush'

async function readQueue(): Promise<QueuedCapture[]> {
  const r = await browser.storage.local.get(QUEUE_KEY)
  const v = r[QUEUE_KEY]
  return Array.isArray(v) ? (v as QueuedCapture[]) : []
}

async function writeQueue(queue: QueuedCapture[]): Promise<void> {
  await browser.storage.local.set({ [QUEUE_KEY]: queue })
}

async function setBadge(count: number): Promise<void> {
  await browser.action.setBadgeText({ text: badgeText(count) })
  if (count > 0) await browser.action.setBadgeBackgroundColor({ color: '#E56458' })
}

async function ensureFlushAlarm(): Promise<void> {
  const existing = await browser.alarms.get(FLUSH_ALARM)
  if (!existing) await browser.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 })
}

async function stopFlushAlarm(): Promise<void> {
  await browser.alarms.clear(FLUSH_ALARM)
}

// Try the live server once and drain queued items oldest-first. Drop on success
// or permanent failure; stop the pass (keep the rest) the moment the server is
// unreachable again.
async function flushQueue(): Promise<FlushResponse> {
  let queue = await readQueue()
  if (queue.length === 0) {
    await stopFlushAlarm()
    return { flushed: 0, remaining: 0 }
  }
  const found = await probeServer()
  const token = await getToken()
  if (!found || !token) return { flushed: 0, remaining: queue.length }
  let flushed = 0
  for (const item of [...queue]) {
    const res = await postCapture(found.port, token, item.capture)
    if (res.ok) {
      queue = dequeueById(queue, item.id)
      flushed++
    } else if (isRetryable(res.error)) {
      break
    } else {
      console.warn('[memry] dropping unsendable queued capture', item.id, res.error)
      queue = dequeueById(queue, item.id)
    }
  }
  await writeQueue(queue)
  await setBadge(queue.length)
  if (queue.length === 0) await stopFlushAlarm()
  return { flushed, remaining: queue.length }
}

// Capture, or queue it for retry when the server is unreachable. Permanent
// errors (bad token, invalid payload) pass straight through to the popup.
async function captureOrQueue(body: ArticleCapture): Promise<CaptureResponse> {
  const res = await capture(body)
  if (res.ok) {
    void flushQueue()
    return res
  }
  if (isRetryable(res.error)) {
    const queue = enqueue(await readQueue(), {
      id: crypto.randomUUID(),
      capture: body,
      queuedAt: Date.now()
    })
    await writeQueue(queue)
    await setBadge(queue.length)
    await ensureFlushAlarm()
    return { ok: false, error: 'queued' }
  }
  return res
}
```

- [ ] **Step 3: Route messages through the queue + restore badge on startup**

In the `defineBackground` callback, replace the listener body so `CAPTURE` queues, `GET_STATUS` opportunistically flushes, and `FLUSH_QUEUE` is handled; then add the alarm listener and a startup badge restore:

```ts
export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: PopupMessage) => {
    switch (message.type) {
      case 'GET_STATUS':
        return getStatus().then((status) => {
          if (status.connection === 'ready') void flushQueue()
          return status
        })
      case 'PAIR':
        return pair()
      case 'CAPTURE':
        return captureOrQueue(message.capture)
      case 'WAIT_FOR_SERVER':
        return waitForServer()
      case 'GRAB_SCREENSHOT':
        return grabScreenshot()
      case 'FLUSH_QUEUE':
        return flushQueue()
      default:
        return undefined
    }
  })

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === FLUSH_ALARM) void flushQueue()
  })

  // Restore the badge + retry alarm whenever the service worker (re)starts.
  void (async () => {
    const queue = await readQueue()
    await setBadge(queue.length)
    if (queue.length > 0) await ensureFlushAlarm()
  })()
})
```

(`REVOKE` is added in Task 7; leave it out for now.)

- [ ] **Step 4: Render the queued state in the popup**

In `apps/extension/src/entrypoints/popup/App.tsx`, exclude `'queued'` from the editable block guard and add a queued message. Change the block guard:

```tsx
      {phase !== 'extracting' && phase !== 'capturing' && phase !== 'saved' && phase !== 'queued' && (
```

In the footer block, after the `{phase === 'saved' && ...}` paragraph, add:

```tsx
{
  phase === 'queued' && (
    <p className="py-2 text-center text-[14px] font-medium text-foreground">
      Saved offline — syncs when Memry opens ✓
    </p>
  )
}
```

- [ ] **Step 5: Typecheck + build + unit suite**

Run: `pnpm --filter @memry/extension typecheck && pnpm --filter @memry/extension build && pnpm --filter @memry/extension test`
Expected: 0 type errors; build succeeds; all unit tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/extension/wxt.config.ts apps/extension/src/entrypoints/background.ts apps/extension/src/entrypoints/popup/App.tsx
git commit -m "feat(extension): offline queue with alarm retry + badge"
```

---

## Task 4: Keyboard command — capture without the popup (extension, manual-QA)

**Files:**

- Modify: `apps/extension/wxt.config.ts`
- Modify: `apps/extension/src/entrypoints/background.ts`

**Interfaces:**

- Consumes: `captureOrQueue`, `setBadge`, `readQueue` (Task 3); the content script `EXTRACT` handler + `ExtractResponse` (existing).
- Produces: a `capture-page` command that captures the active tab in Article mode.

- [ ] **Step 1: Add the `commands` block to the manifest**

In `apps/extension/wxt.config.ts`, add a `commands` key inside `manifest` (sibling of `permissions`):

```ts
    commands: {
      'capture-page': {
        suggested_key: { default: 'Ctrl+Shift+S', mac: 'Command+Shift+S' },
        description: 'Capture this page to Memry'
      }
    }
```

(ponytail: suggested keys silently no-op on collision; the user rebinds at `chrome://extensions/shortcuts`. `commands` is a manifest key, not a permission.)

- [ ] **Step 2: Handle the command in background.ts**

Add the import for `ExtractResponse` (extend the existing `@/lib/messages` import type list) and, inside the `defineBackground` callback (after the `onMessage` listener), add:

```ts
browser.commands.onCommand.addListener(async (command) => {
  if (command !== 'capture-page') return
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return
  // The content script is declared on *://*/* and auto-injected, so messaging
  // it needs no activeTab grant. It is absent on chrome://, the Web Store, and
  // PDFs — sendMessage rejects there, which we surface as a brief error badge.
  const extracted: ExtractResponse = await browser.tabs
    .sendMessage(tab.id, { type: 'EXTRACT' })
    .catch(() => ({ ok: false, error: 'no-content-script' }))
  if (!extracted.ok) {
    await browser.action.setBadgeText({ text: '!' })
    await browser.action.setBadgeBackgroundColor({ color: '#E56458' })
    setTimeout(() => void restoreQueueBadge(), 2000)
    return
  }
  const res = await captureOrQueue(extracted.capture)
  if (res.ok) {
    await browser.action.setBadgeText({ text: '✓' })
    await browser.action.setBadgeBackgroundColor({ color: '#3B873E' })
    setTimeout(() => void restoreQueueBadge(), 2000)
  }
  // A queued save already set the count badge inside captureOrQueue.
})
```

Add the `restoreQueueBadge` helper next to `setBadge` (Task 3 block):

```ts
async function restoreQueueBadge(): Promise<void> {
  await setBadge((await readQueue()).length)
}
```

- [ ] **Step 3: Typecheck + build**

Run: `pnpm --filter @memry/extension typecheck && pnpm --filter @memry/extension build`
Expected: 0 type errors; build succeeds (WXT emits the `commands` manifest key).

- [ ] **Step 4: Commit**

```bash
git add apps/extension/wxt.config.ts apps/extension/src/entrypoints/background.ts
git commit -m "feat(extension): keyboard command captures the active page"
```

---

## Task 5: Desktop `/pair/revoke` route (desktop)

**Files:**

- Modify: `apps/desktop/src/main/capture/server.ts`
- Modify: `apps/desktop/src/main/capture/server.test.ts`

**Interfaces:**

- Consumes: `validateCaptureRequest` (`./auth`), `getCaptureToken`/`isOriginAllowed` (already imported), `unpairCapture` (`./pairing`, existing — line 47).
- Produces: `POST /pair/revoke` → 200 after `unpairCapture()`, guarded by the same auth as `/capture`.

- [ ] **Step 1: Write the failing server test**

In `apps/desktop/src/main/capture/server.test.ts`, add `unpairCapture` to the `./pairing` mock (find the `vi.mock('./pairing', ...)` factory and add `unpairCapture: vi.fn()` to the returned object; capture it as `const mockUnpair = vi.fn()` at module scope if the file uses that style — mirror how `claimPairing` is mocked). Then add this case after the existing `/capture` test:

```ts
it('revokes pairing for an authorized origin', async () => {
  origins.add('chrome-extension://abc')
  const res = await req(port, '/pair/revoke', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Origin: 'chrome-extension://abc',
      'X-Memry-Capture': '1'
    }
  })
  expect(res.status).toBe(200)
  expect(mockUnpair).toHaveBeenCalledTimes(1)
})

it('rejects revoke with a bad token', async () => {
  origins.add('chrome-extension://abc')
  const res = await req(port, '/pair/revoke', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer wrong',
      Origin: 'chrome-extension://abc',
      'X-Memry-Capture': '1'
    }
  })
  expect(res.status).toBe(401)
  expect(mockUnpair).not.toHaveBeenCalled()
})
```

(Match `TOKEN`, `origins`, `req`, and `port` to the existing test harness in this file. If the `/capture` test uses different helper names, reuse those.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main capture/server.test.ts`
Expected: FAIL — `/pair/revoke` returns 404.

- [ ] **Step 3: Add the route**

In `apps/desktop/src/main/capture/server.ts`, add `unpairCapture` to the pairing import (line 5):

```ts
import {
  getCaptureToken,
  isOriginAllowed,
  claimPairing,
  openPairingWindow,
  unpairCapture
} from './pairing'
```

Add the route inside `handle`, immediately before the final `json(res, 404, ...)`:

```ts
if (req.method === 'POST' && req.url === '/pair/revoke') {
  const token = await getCaptureToken()
  const auth = validateCaptureRequest(
    {
      authorization: req.headers.authorization,
      origin,
      'x-memry-capture': req.headers['x-memry-capture'] as string | undefined
    },
    token,
    isOriginAllowed
  )
  if (!auth.ok) {
    json(res, 401, { error: auth.reason })
    return
  }
  await unpairCapture()
  json(res, 200, { ok: true })
  return
}
```

(ponytail: `unpairCapture()` clears the whole allowlist + token — single-extension model; per-origin revoke is a Phase 6 non-goal.)

- [ ] **Step 4: Run the test + typecheck**

Run: `pnpm --filter @memry/desktop test:main capture/server.test.ts && pnpm --filter @memry/desktop typecheck:node`
Expected: PASS; 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/capture/server.ts apps/desktop/src/main/capture/server.test.ts
git commit -m "feat(capture): add auth-guarded /pair/revoke route"
```

---

## Task 6: Port-override probe + revoke client (extension)

**Files:**

- Modify: `apps/extension/src/lib/capture-client.ts`
- Test: `apps/extension/src/lib/capture-client.test.ts` (create if absent)

**Interfaces:**

- Produces (consumed by Task 7):
  - `probeServer(fetchFn?, ports?: number[])` — probes the supplied port list (defaults to `PROBE_PORTS`).
  - `revokeUrl(port: number): string`
  - `postRevoke(port: number, token: string, fetchFn?): Promise<boolean>`

- [ ] **Step 1: Write the failing tests**

Create (or append to) `apps/extension/src/lib/capture-client.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { postRevoke, probeServer, revokeUrl } from './capture-client'

const ok = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response
const notOk = () => ({ ok: false, json: async () => ({}) }) as unknown as Response

describe('probeServer with an explicit port list', () => {
  it('returns the first live server in the supplied list', async () => {
    const fetchFn = vi.fn(async (url: string) =>
      url.includes(':9001') ? ok({ app: 'memry', paired: true, version: '1' }) : notOk()
    ) as unknown as typeof fetch
    const found = await probeServer(fetchFn, [9000, 9001])
    expect(found?.port).toBe(9001)
  })
})

describe('postRevoke', () => {
  it('returns true on a 2xx', async () => {
    const fetchFn = vi.fn(async () => ok({ ok: true })) as unknown as typeof fetch
    expect(await postRevoke(7849, 'tok', fetchFn)).toBe(true)
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(revokeUrl(7849))
  })
  it('returns false on a non-2xx', async () => {
    const fetchFn = vi.fn(async () => notOk()) as unknown as typeof fetch
    expect(await postRevoke(7849, 'tok', fetchFn)).toBe(false)
  })
  it('returns false when fetch throws', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('down')
    }) as unknown as typeof fetch
    expect(await postRevoke(7849, 'tok', fetchFn)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @memry/extension test -- capture-client`
Expected: FAIL — `revokeUrl`/`postRevoke` not exported; `probeServer` ignores the ports arg.

- [ ] **Step 3: Update capture-client.ts**

Add `revokeUrl` next to the other URL builders:

```ts
export function revokeUrl(port: number): string {
  return `http://127.0.0.1:${port}/pair/revoke`
}
```

Change `probeServer` to accept an explicit port list:

```ts
export async function probeServer(
  fetchFn: typeof fetch = fetch,
  ports: number[] = PROBE_PORTS
): Promise<{ port: number; ping: PingResponse } | null> {
  for (const port of ports) {
    try {
      const res = await fetchFn(pingUrl(port), { method: 'GET' })
      if (!res.ok) continue
      const ping = parsePing(await res.json())
      if (ping) return { port, ping }
    } catch {
      // port not listening — try the next one
    }
  }
  return null
}
```

Add `postRevoke` near `postCapture`:

```ts
export async function postRevoke(
  port: number,
  token: string,
  fetchFn: typeof fetch = fetch
): Promise<boolean> {
  try {
    const res = await fetchFn(revokeUrl(port), { method: 'POST', headers: captureHeaders(token) })
    return res.ok
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @memry/extension test -- capture-client`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @memry/extension typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add apps/extension/src/lib/capture-client.ts apps/extension/src/lib/capture-client.test.ts
git commit -m "feat(extension): port-override probe + revoke client"
```

---

## Task 7: Settings options page (extension, manual-QA)

**Files:**

- Create: `apps/extension/src/entrypoints/options/index.html`
- Create: `apps/extension/src/entrypoints/options/main.tsx`
- Create: `apps/extension/src/entrypoints/options/App.tsx`
- Modify: `apps/extension/src/entrypoints/background.ts`

**Interfaces:**

- Consumes: `postRevoke`, `probeServer` with a port list (Task 6); `REVOKE` message (Task 2); existing `GET_STATUS`/`PAIR`.
- Produces: a working options page; a background `REVOKE` handler; a `memry:capture-port` override that `probeServer` honors first.

- [ ] **Step 1: Thread the port override + REVOKE into background.ts**

Add a port-override helper and route the probe through it. Add near the queue layer:

```ts
const PORT_KEY = 'memry:capture-port'

async function getOverridePort(): Promise<number | null> {
  const r = await browser.storage.local.get(PORT_KEY)
  const v = r[PORT_KEY]
  return typeof v === 'number' && Number.isInteger(v) ? v : null
}

// Probe the override port first (if set), then the default range.
async function probe(): Promise<Awaited<ReturnType<typeof probeServer>>> {
  const override = await getOverridePort()
  return override ? probeServer(fetch, [override, ...PROBE_PORTS]) : probeServer()
}
```

Add the `PROBE_PORTS` import from `@/lib/capture-client` (extend the existing import). Then replace the bare `probeServer()` calls inside `getStatus`, `capture`, and `flushQueue` with `probe()`. (Leave `waitForServer`'s `pollUntil(() => probeServer())` — it can stay on the default range, or switch to `probe` for consistency.)

Add a `revoke` function and message case:

```ts
async function revoke(): Promise<{ ok: boolean }> {
  const found = await probe()
  const token = await getToken()
  if (found && token) await postRevoke(found.port, token)
  await browser.storage.local.remove(TOKEN_KEY)
  return { ok: true }
}
```

Import `postRevoke` from `@/lib/capture-client`, and add the case to the message switch:

```ts
      case 'REVOKE':
        return revoke()
```

- [ ] **Step 2: Create the options entrypoint**

Create `apps/extension/src/entrypoints/options/index.html` (mirror `popup/index.html` — check that file for the exact head/script shape; WXT auto-registers `options/` as `options_ui`):

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Memry Web Clipper — Settings</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

Create `apps/extension/src/entrypoints/options/main.tsx` (mirror `popup/main.tsx` for the CSS import + mount):

```tsx
import { createRoot } from 'react-dom/client'
import App from './App'
import '@/entrypoints/popup/style.css'

createRoot(document.getElementById('root')!).render(<App />)
```

(Confirm the popup's CSS import path in `popup/main.tsx` and reuse it verbatim.)

- [ ] **Step 3: Create the options App**

Create `apps/extension/src/entrypoints/options/App.tsx`:

```tsx
import { useEffect, useState } from 'react'
import type { ConnectionState, PairResponse, StatusResponse } from '@/lib/messages'

const PORT_KEY = 'memry:capture-port'

export default function App() {
  const [connection, setConnection] = useState<'unknown' | ConnectionState>('unknown')
  const [port, setPort] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = () =>
    browser.runtime
      .sendMessage({ type: 'GET_STATUS' })
      .then((r: StatusResponse) => setConnection(r.connection))
      .catch(() => setConnection('app-closed'))

  useEffect(() => {
    void refresh()
    browser.storage.local.get(PORT_KEY).then((r) => {
      const v = r[PORT_KEY]
      if (typeof v === 'number') setPort(String(v))
    })
  }, [])

  const onPair = async () => {
    setBusy(true)
    const r: PairResponse = await browser.runtime.sendMessage({ type: 'PAIR' }).catch(() => ({
      ok: false
    }))
    setBusy(false)
    if (r.ok) void refresh()
  }

  const onUnpair = async () => {
    setBusy(true)
    await browser.runtime.sendMessage({ type: 'REVOKE' }).catch(() => {})
    setBusy(false)
    void refresh()
  }

  const onRotate = async () => {
    await onUnpair()
    await onPair()
  }

  const onSavePort = async () => {
    const n = parseInt(port, 10)
    if (port.trim() === '' || Number.isNaN(n)) {
      await browser.storage.local.remove(PORT_KEY)
    } else {
      await browser.storage.local.set({ [PORT_KEY]: n })
    }
    void refresh()
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6 font-sans text-foreground">
      <h1 className="text-lg font-semibold">Memry Web Clipper</h1>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Pairing</h2>
        <p className="text-[13px] text-text-secondary">Status: {connection}</p>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onPair}
            className="rounded bg-accent px-3 py-1.5 text-[13px] text-white disabled:opacity-50"
          >
            Re-pair
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onRotate}
            className="rounded border border-border px-3 py-1.5 text-[13px] disabled:opacity-50"
          >
            Rotate token
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onUnpair}
            className="rounded border border-border px-3 py-1.5 text-[13px] disabled:opacity-50"
          >
            Unpair
          </button>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Port override</h2>
        <p className="text-[13px] text-text-secondary">
          Leave blank to auto-detect (ports 7849–7856).
        </p>
        <div className="flex gap-2">
          <input
            value={port}
            onChange={(e) => setPort(e.target.value)}
            inputMode="numeric"
            placeholder="auto"
            className="w-24 rounded border border-border bg-surface px-2 py-1 text-[13px]"
          />
          <button
            type="button"
            onClick={onSavePort}
            className="rounded border border-border px-3 py-1.5 text-[13px]"
          >
            Save
          </button>
        </div>
      </section>
    </div>
  )
}
```

(Confirm the actual Tailwind token names — `accent`, `text-secondary`, `border`, `surface` — against `popup/App.tsx` + the popup components; reuse whatever they use. Keep to logical properties.)

- [ ] **Step 4: Typecheck + build + lint**

Run: `pnpm --filter @memry/extension typecheck && pnpm --filter @memry/extension build && pnpm --filter @memry/extension lint`
Expected: 0 errors; build emits an `options.html` entrypoint + `options_ui` in the manifest.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/entrypoints/options apps/extension/src/entrypoints/background.ts
git commit -m "feat(extension): settings options page — re-pair/unpair/port override"
```

---

## Task 8: "Add & open" — contract event + deep-link + renderer (desktop)

**Files:**

- Modify: `packages/contracts/src/inbox-channels.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Test: `apps/desktop/src/main/index.deeplink.test.ts` (create)
- Modify: a renderer inbox subscriber (see Step 5)

**Interfaces:**

- Produces: `InboxChannels.events.OPEN_ITEM = 'inbox:open-item'`; `parseInboxOpenItemId(url): string | null`; the generated preload subscriber for the event; a renderer handler that focuses the captured inbox item.

- [ ] **Step 1: Add the contract event**

In `packages/contracts/src/inbox-channels.ts`, add to `InboxChannels.events`:

```ts
    /** Focus a specific inbox item (from the browser-extension "Add & open" deep-link) */
    OPEN_ITEM: 'inbox:open-item',
```

- [ ] **Step 2: Regenerate + validate the IPC map**

Run: `pnpm ipc:generate && pnpm ipc:check`
Expected: the generated preload (`apps/desktop/src/preload/generated-rpc.ts`) gains a subscriber entry mapping to `inbox:open-item`; `ipc:check` passes. Note the generated subscriber method name (e.g. `onInboxOpenItem`) — Step 5 uses it.

- [ ] **Step 3: Write the failing deep-link helper test**

Create `apps/desktop/src/main/index.deeplink.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseInboxOpenItemId } from './index'

describe('parseInboxOpenItemId', () => {
  it('extracts the item id from memry://open?item=...', () => {
    expect(parseInboxOpenItemId('memry://open?item=cap-123')).toBe('cap-123')
  })
  it('returns null for memry://open without an item', () => {
    expect(parseInboxOpenItemId('memry://open')).toBeNull()
  })
  it('returns null for other hosts', () => {
    expect(parseInboxOpenItemId('memry://billing?item=x')).toBeNull()
  })
  it('returns null for malformed input', () => {
    expect(parseInboxOpenItemId('not a url')).toBeNull()
  })
})
```

- [ ] **Step 4: Add the helper + wire the deep-link**

In `apps/desktop/src/main/index.ts`, export the pure helper (place it near `handleDeepLink`):

```ts
export function parseInboxOpenItemId(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'memry:' || parsed.hostname !== 'open') return null
    return parsed.searchParams.get('item')
  } catch {
    return null
  }
}
```

In `handleDeepLink`, inside the `if (parsed.hostname === 'open')` block, after the existing log line, add the send (import `InboxChannels` from `@memry/contracts/ipc-channels` if not already imported):

```ts
if (parsed.hostname === 'open') {
  deepLinkLog.info('launch requested via memry://open')
  const itemId = parsed.searchParams.get('item')
  if (itemId) mainWindow.webContents.send(InboxChannels.events.OPEN_ITEM, { itemId })
}
```

Run the test:

Run: `pnpm --filter @memry/desktop test:main index.deeplink`
Expected: PASS (4 tests). If `index.ts` pulls in heavy main-process imports that break a unit import, instead extract `parseInboxOpenItemId` into a tiny sibling `apps/desktop/src/main/deeplink-utils.ts`, import it into `index.ts`, and point the test there.

- [ ] **Step 5: Subscribe in the renderer**

In the inbox page (`apps/desktop/src/renderer/src/pages/inbox.tsx`), subscribe to the generated event (method name from Step 2) and focus the item. Add an effect:

```tsx
useEffect(() => {
  const off = window.api.inbox.onInboxOpenItem?.(({ itemId }: { itemId: string }) => {
    // Reuse the list's existing item-open path. If the item isn't in the
    // current filtered view, focus the inbox without selecting (don't throw).
    openInboxItem(itemId)
  })
  return () => off?.()
}, [])
```

Replace `onInboxOpenItem` with the actual generated name from Step 2, and `openInboxItem(itemId)` with the inbox list's real open/select handler (trace it from the row click in `apps/desktop/src/renderer/src/pages/inbox/inbox-list-view.tsx` — `onSelectionChange` / the detail-open path). The deliverable: a deep-link with `?item=<id>` brings Memry to front with that item visible/selected.

- [ ] **Step 6: Typecheck + ipc:check + renderer test suite**

Run: `pnpm --filter @memry/desktop typecheck:node && pnpm --filter @memry/desktop typecheck:web && pnpm ipc:check && pnpm --filter @memry/desktop test:renderer inbox`
Expected: 0 type errors; ipc:check passes; renderer inbox tests pass (update any that assert the inbox page's effect set).

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/inbox-channels.ts apps/desktop/src/main/index.ts apps/desktop/src/main/index.deeplink.test.ts apps/desktop/src/preload/generated-rpc.ts apps/desktop/src/renderer/src/pages/inbox.tsx
git commit -m "feat(inbox): open a captured item via memry://open?item deep-link"
```

(Add `apps/desktop/src/main/deeplink-utils.ts` to the `git add` list if Step 4's fallback was used. Include any other files `pnpm ipc:generate` regenerated — check `git status` for the exact set, but stage them by explicit path, never `-A`.)

---

## Task 9: Popup "Add & open" split action (extension, manual-QA)

**Files:**

- Modify: `apps/extension/src/entrypoints/popup/App.tsx`

**Interfaces:**

- Consumes: `onAdd` + `state.itemId` (existing); the `'queued'` phase (Task 2/3).
- Produces: an "Add & open" secondary action that deep-links to the new item on a real save.

- [ ] **Step 1: Add the `onAddAndOpen` handler**

In `apps/extension/src/entrypoints/popup/App.tsx`, after `onAdd`, add:

```tsx
const onAddAndOpen = async () => {
  await onAdd()
  // onAdd dispatched SAVE_DONE synchronously before returning; read the next
  // state via the latest itemId. A queued (offline) save has no item to open.
  const id = stateRef.current.itemId
  if (id && stateRef.current.action === 'saved') {
    browser.tabs.create({ url: `memry://open?item=${encodeURIComponent(id)}` }).catch(() => {})
  }
}
```

`onAdd` updates state asynchronously, so capture the latest state in a ref. Add near the top of the component:

```tsx
const stateRef = useRef(state)
stateRef.current = state
```

(`useRef` is already imported. If `onAdd` returns before `SAVE_DONE` is committed to `stateRef`, change `onAdd` to return the `CaptureResponse` and branch on that directly instead of reading the ref — simpler and race-free:)

```tsx
const onAddAndOpen = async () => {
  const result = await onAdd()
  if (result?.ok) {
    browser.tabs
      .create({ url: `memry://open?item=${encodeURIComponent(result.itemId)}` })
      .catch(() => {})
  }
}
```

To enable the race-free form, change `onAdd` to `return result` at its end (it currently dispatches `SAVE_DONE` and returns void — add `return result`). Use the race-free form.

- [ ] **Step 2: Render the split action**

In the footer, replace the single `ready`-phase button with a primary + secondary pair:

```tsx
{
  phase === 'ready' && (
    <div className="flex flex-col gap-2">
      <PrimaryButton label="Add to Memry" onClick={() => onAdd()} disabled={!draft} />
      <button
        type="button"
        disabled={!draft}
        onClick={onAddAndOpen}
        className="rounded-md border border-border px-3 py-2 text-[13px] font-medium text-text-secondary disabled:opacity-50"
      >
        Add & open in Memry
      </button>
    </div>
  )
}
```

(Match `PrimaryButton`'s wrapper styling so the two read as a stack; reuse existing token names.)

- [ ] **Step 3: Typecheck + build + unit suite**

Run: `pnpm --filter @memry/extension typecheck && pnpm --filter @memry/extension build && pnpm --filter @memry/extension test`
Expected: 0 type errors; build succeeds; tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/extension/src/entrypoints/popup/App.tsx
git commit -m "feat(extension): Add & open split action deep-links to the new item"
```

---

## Task 10: Full gate + whole-branch review + manual GUI QA

**Files:** none (verification only).

- [ ] **Step 1: Extension gate**

Run: `pnpm --filter @memry/extension test && pnpm --filter @memry/extension typecheck && pnpm --filter @memry/extension lint && pnpm --filter @memry/extension build`
Expected: all green.

- [ ] **Step 2: Desktop gate**

Run: `pnpm --filter @memry/desktop test:main capture/server.test.ts && pnpm --filter @memry/desktop test:main index.deeplink && pnpm --filter @memry/desktop typecheck:node && pnpm ipc:check`
Expected: all green. (If `better-sqlite3 ERR_DLOPEN_FAILED`: `pnpm --filter @memry/desktop rebuild:node`, retry.)

- [ ] **Step 3: Contracts gate**

Run: `pnpm --filter @memry/contracts test && pnpm --filter @memry/contracts typecheck`
Expected: green.

- [ ] **Step 4: Formatting**

Run: `git diff --check`
Expected: no whitespace errors. Spot-check single-quote / no-semicolon / no-trailing-comma + logical Tailwind classes in every changed file.

- [ ] **Step 5: Docs gate (desktop touched)**

Run: `pnpm docs:impact --base origin/main --strict`
If it reports `missing-docs`, update `apps/docs/src/**` (browser-extension/capture page: note the new keyboard shortcut, offline queue, settings page) or run `pnpm docs:ai-update --base origin/main`, then re-run `--strict` and `pnpm docs:build`.

- [ ] **Step 6: Whole-branch review (opus)**

Dispatch a review over `git diff main...HEAD` against the spec. Confirm: only `alarms` added to permissions (no stray host perms); no `git add -A` swept `import-prompt/` or `marketing/`; contract subpath imports; logical Tailwind classes; Phase 3.1 pairing/launch + Phase 4 selection/screenshot untouched; `/pair/revoke` reuses `/capture` auth; the queue drops permanent failures (no wedge) and stops the alarm when empty.

- [ ] **Step 7: Manual GUI QA — HUMAN-REQUIRED (acceptance gate)**

Cannot be automated. With `pnpm dev` (desktop) running and the unpacked extension (`apps/extension/.output/chrome-mv3`) loaded:

1. **Queue:** quit Memry → capture via popup AND via the keyboard shortcut → toolbar badge shows the count; popup says "Saved offline." Launch Memry → within ~1 min the badge clears and both items appear in the inbox.
2. **Keyboard:** with Memry open, press the shortcut on a real article → item in the inbox, no popup, brief ✓ badge. On a `chrome://` page → brief `!` badge, no crash.
3. **Settings:** open the options page (right-click the action → Options, or `chrome://extensions`) → status reflects pairing. Unpair → next capture shows needs-pairing. Re-pair works. Rotate token works. Set a wrong port → app looks closed; clear it → recovers.
4. **Add & open:** "Add & open in Memry" → Memry comes to front with the just-captured item focused in the inbox. While Memry is closed → it queues and does NOT try to open.
5. **Regression:** Phase 3.1 pairing/launch + Phase 4 Article/Selection/Shot modes all unchanged.

---

## Self-Review

**Spec coverage:**

- 5.1 Offline queue + retry + badge → Tasks 1 (helpers), 2 (queued state), 3 (background queue/badge/alarm). ✓
- 5.2 Keyboard command (Article, no new perm) → Task 4. ✓
- 5.3 Settings (re-pair/unpair/rotate/port override) → Tasks 5 (`/pair/revoke`), 6 (probe/revoke client), 7 (options page + REVOKE + port thread). ✓
- 5.4 Add & open → Tasks 8 (contract event + deep-link + renderer), 9 (popup split button). ✓
- Permissions: only `alarms` added (Task 3); `commands` (Task 4) + `options_ui` (Task 7) are manifest keys → asserted in Task 10 Step 6. ✓
- Tests: pure logic unit-tested (capture-queue T1, reducer T2, probe/revoke T6, deep-link helper T8, `/pair/revoke` T5); DOM/background/UI manual-QA (T10 Step 7). ✓

**Type consistency:** `QueuedCapture`/`isRetryable`/`enqueue`/`dequeueById`/`badgeText` defined in T1, consumed identically in T3/T4. `FlushResponse` defined T2, returned by `flushQueue` T3. `'queued'` error code: produced by `captureOrQueue` T3, handled in `SAVE_DONE` T2, rendered T3, branched in `onAddAndOpen` T9. `probeServer(fetchFn, ports)` signature matches T6 test + T7 caller. `postRevoke(port, token, fetchFn?)` matches T6 + T7. `parseInboxOpenItemId` matches T8 test + caller. `InboxChannels.events.OPEN_ITEM` defined T8, sent in main T8, subscribed in renderer T8.

**Placeholder scan:** the two genuinely environment-dependent names — the generated preload subscriber method (T8 Step 2/5) and the inbox list's open handler (T8 Step 5) — are resolved by a concrete deterministic step (run `ipc:generate`, read the generated name; trace the row-click handler), not left as TBD. Everything else ships full code.
