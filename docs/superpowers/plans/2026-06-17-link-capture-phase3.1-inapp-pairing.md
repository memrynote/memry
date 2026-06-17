# Link Capture Phase 3.1 — In-App Pairing + Launch-on-Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the separate "Pair" ceremony. Pairing happens via an in-app Allow/Deny dialog that Memry pops itself (no browser→app deep-link), folded into a single "Add to Memry" action; and when Memry is closed, the popup launches it via a `memry://` deep-link (now properly registered) before capturing.

**Architecture:** Desktop — `startCaptureServer` gains an injected `requestPairConsent(origin)` callback; a new `POST /pair/request` endpoint triggers Memry's native Allow/Deny dialog and (on Allow, or for an already-allowlisted origin) opens the existing pairing window so the unchanged `POST /pair/claim` can mint the token. Protocol registration is fixed (electron-builder `protocols:` + dev) and a `memry://open` host just focuses/launches. Extension — the background orchestrates capture inline: probe → (launch if closed) → (pair-if-needed via `/pair/request` + poll `/pair/claim`) → `/capture`. The popup drops the Pair button and the app-closed dead-end.

**Tech Stack:** Electron 39 (main), WXT/React extension, Vitest. Node 24, pnpm 11.5.2.

## Global Constraints

- **Repo style (Prettier):** single quotes, no semicolons, 100-char width, no trailing commas.
- **No `Co-Authored-By`** on commits. **Commit hygiene:** `git add` only task files by explicit path — there is unrelated untracked `import-prompt/` in the tree that must NOT be committed.
- **Branch:** work continues on `feat/link-capture-extension` (stacked on `feat/link-capture-loopback`). Desktop changes here touch Phase-2 files (`apps/desktop/src/main/capture/*`, `index.ts`) — that is expected for this stacked branch.
- **Tailwind logical properties only** in extension renderer code (`ms-`/`me-`/`ps-`/`pe-`/`start-`/`end-`).
- **Keep the token security model.** The single human consent (Allow/Deny) is mandatory and must happen in the trusted desktop app — never silent, never extension-side.
- **SECURITY MODEL CHANGE (flag for review):** Phase 2 only opened the pairing window via a user-initiated `memry://pair` deep-link. This plan lets the extension (or any local caller forging a `chrome-extension://` origin) trigger the Allow/Deny dialog via `POST /pair/request`. The defense remains: only `chrome-extension://` origins, a single-pending-dialog guard (no stacking), and the user must click Allow. A non-allowlisted origin cannot obtain a token without an Allow click. This must be re-blessed in the final review.
- **Server contract additions:**
  - `POST /pair/request` → headers: `Origin: chrome-extension://<id>` + `X-Memry-Capture: 1`. → `400 { error:'missing-origin' }` if no origin; `403 { error:'origin-not-allowed' }` if origin isn't `chrome-extension://`; `401 { error:'missing-capture-header' }` if header missing; `200 { status:'already-paired' }` if origin already allowlisted (and a pairing window is opened so the token can be re-claimed); `202 { status:'pending' }` otherwise (Allow/Deny dialog shown; on Allow the pairing window opens).
  - `POST /pair/claim` — UNCHANGED (still window-gated, returns `{ token, port }`).
- **Deep-link hosts:** `memry://pair` (existing dialog path — keep, harmless) and new `memry://open` (just restore+focus, no dialog; used to launch a closed app). Any `memry://` URL already falls through to `restore()+focus()`.
- **macOS dev caveat:** browser→app deep-links require the scheme in `Info.plist`. The `electron-builder protocols:` block fixes the PACKAGED app. For `pnpm dev` on macOS, a dev script patches the dev Electron's `Info.plist` (Increment B). In-app pairing (Increment A) needs NO deep-link and works in `pnpm dev` immediately.

---

## Increments

- **Increment A (Tasks 1–4): in-app pairing — fully testable in `pnpm dev`.** After Task 4, pairing + capture work end-to-end with the desktop app running, no deep-link.
- **Increment B (Tasks 5–6): launch-when-closed via deep-link.** Testable against a packaged build (or the patched dev app on macOS).

---

## Task 1: Desktop — `POST /pair/request` + injected Allow/Deny consent

**Files:**

- Modify: `apps/desktop/src/main/capture/server.ts`
- Modify: `apps/desktop/src/main/index.ts` (wire the consent dialog into `startCaptureServer`)
- Test: `apps/desktop/src/main/capture/server.test.ts`

**Interfaces:**

- Produces: `startCaptureServer(deps?: { requestPairConsent?: (origin: string) => Promise<boolean> }): Promise<number>` (deps optional — existing no-arg callers/tests still compile). New `POST /pair/request` route per the contract above.
- Consumes: existing `isOriginAllowed`, `openPairingWindow`, `claimPairing` from `./pairing`.

- [ ] **Step 1: Write failing tests** — add to `apps/desktop/src/main/capture/server.test.ts` (follow the existing real-loopback test style in that file; reuse its helpers for starting the server and building requests). Add cases:
  - `/pair/request` with no `Origin` → 400 `{error:'missing-origin'}`.
  - `/pair/request` with a non-`chrome-extension://` origin → 403 `{error:'origin-not-allowed'}`.
  - `/pair/request` missing `X-Memry-Capture` → 401 `{error:'missing-capture-header'}`.
  - `/pair/request` from a new `chrome-extension://abc` origin (server started with a fake `requestPairConsent` resolving `true`) → 202 `{status:'pending'}`, the consent callback was invoked once, and a subsequent `POST /pair/claim` (same origin) returns 200 with a token.
  - `/pair/request` when the consent callback resolves `false` → 202, and a later `/pair/claim` returns 403 (window never opened).
  - Single-pending guard: two `/pair/request` calls for the same origin before consent resolves invoke the callback only once.
  - Already-allowlisted origin (claim it first) → `/pair/request` returns 200 `{status:'already-paired'}`.

  Match the file's existing test harness exactly; pass `{ requestPairConsent }` to `startCaptureServer` in these tests.

- [ ] **Step 2: Run tests to confirm RED**

Run: `pnpm --filter @memry/desktop test:main capture/server.test.ts` (use the project's main-test invocation already used for this file).
Expected: FAIL — `/pair/request` returns 404 (route doesn't exist); `startCaptureServer` rejects the `deps` arg shape.

- [ ] **Step 3: Implement in `server.ts`**

Add module state + accept the dep, and add the route. Add `openPairingWindow` to the existing import from `./pairing`.

```ts
let requestPairConsent: ((origin: string) => Promise<boolean>) | null = null
const pendingConsent = new Set<string>()
```

Change the signature (keep the body otherwise unchanged):

```ts
export async function startCaptureServer(
  deps: { requestPairConsent?: (origin: string) => Promise<boolean> } = {}
): Promise<number> {
  requestPairConsent = deps.requestPairConsent ?? null
  // ... existing body unchanged ...
}
```

In `handle()`, add this route BEFORE the `/capture` route:

```ts
if (req.method === 'POST' && req.url === '/pair/request') {
  if (!origin) {
    json(res, 400, { error: 'missing-origin' })
    return
  }
  if (!origin.startsWith('chrome-extension://')) {
    json(res, 403, { error: 'origin-not-allowed' })
    return
  }
  if (req.headers['x-memry-capture'] !== '1') {
    json(res, 401, { error: 'missing-capture-header' })
    return
  }
  if (isOriginAllowed(origin)) {
    // Already consented before — open a window so the extension can (re)claim the
    // token without bothering the user with another dialog.
    openPairingWindow()
    json(res, 200, { status: 'already-paired' })
    return
  }
  // Trigger the in-app Allow/Deny dialog without blocking the socket. Guard against
  // stacking dialogs if the extension re-requests while one is pending.
  if (requestPairConsent && !pendingConsent.has(origin)) {
    pendingConsent.add(origin)
    void requestPairConsent(origin)
      .then((allowed) => {
        if (allowed) openPairingWindow()
      })
      .finally(() => pendingConsent.delete(origin))
  }
  json(res, 202, { status: 'pending' })
  return
}
```

- [ ] **Step 4: Wire the dialog in `index.ts`**

Add a helper near `handleDeepLink` (reuse the already-imported `dialog` and `BrowserWindow`):

```ts
async function showPairConsentDialog(origin: string): Promise<boolean> {
  const mainWindow = BrowserWindow.getAllWindows()[0]
  if (!mainWindow) return false
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Allow', 'Deny'],
    defaultId: 0,
    cancelId: 1,
    title: 'Pair browser extension',
    message: 'Allow the Memry browser extension to save captures to this app?',
    detail: origin
  })
  return response === 0
}
```

Change the `startCaptureServer()` call (currently `void startCaptureServer().catch(...)`) to:

```ts
void startCaptureServer({ requestPairConsent: showPairConsentDialog }).catch((err) =>
  mainLog.error('capture server failed to start', err)
)
```

- [ ] **Step 5: Run tests to confirm GREEN**

Run: `pnpm --filter @memry/desktop test:main capture/server.test.ts`
Expected: PASS (all new + existing cases).

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm --filter @memry/desktop typecheck:node`
Then:

```bash
git add apps/desktop/src/main/capture/server.ts apps/desktop/src/main/index.ts apps/desktop/src/main/capture/server.test.ts
git commit -m "feat(capture): in-app /pair/request consent dialog"
```

---

## Task 2: Extension — `requestPair` capture-client call

**Files:**

- Modify: `apps/extension/src/lib/capture-client.ts`
- Test: `apps/extension/src/lib/capture-client.test.ts`

**Interfaces:**

- Produces: `requestPair(port: number, fetchFn?): Promise<'already-paired' | 'pending' | 'error'>` and `pairRequestUrl(port)`.

- [ ] **Step 1: Write failing tests** — add to `capture-client.test.ts`:

```ts
import { pairRequestUrl, requestPair } from './capture-client'

describe('requestPair', () => {
  test('maps 200 to already-paired, 202 to pending, else error', async () => {
    const paired = vi.fn(
      async () => new Response(JSON.stringify({ status: 'already-paired' }), { status: 200 })
    )
    expect(await requestPair(7849, paired as unknown as typeof fetch)).toBe('already-paired')
    const pending = vi.fn(
      async () => new Response(JSON.stringify({ status: 'pending' }), { status: 202 })
    )
    expect(await requestPair(7849, pending as unknown as typeof fetch)).toBe('pending')
    const denied = vi.fn(async () => new Response('{}', { status: 403 }))
    expect(await requestPair(7849, denied as unknown as typeof fetch)).toBe('error')
  })
  test('sends the X-Memry-Capture header', async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ status: 'pending' }), { status: 202 })
    )
    await requestPair(7849, fetchFn as unknown as typeof fetch)
    expect(fetchFn).toHaveBeenCalledWith(
      pairRequestUrl(7849),
      expect.objectContaining({ method: 'POST' })
    )
    const opts = (fetchFn.mock.calls[0] as unknown[])[1] as RequestInit
    expect((opts.headers as Record<string, string>)['X-Memry-Capture']).toBe('1')
  })
  test('returns error on network failure', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('refused')
    })
    expect(await requestPair(7849, fetchFn as unknown as typeof fetch)).toBe('error')
  })
})
```

- [ ] **Step 2: Run to confirm RED**

Run: `pnpm --filter @memry/extension test src/lib/capture-client.test.ts`
Expected: FAIL — `requestPair`/`pairRequestUrl` not exported.

- [ ] **Step 3: Implement in `capture-client.ts`**

```ts
export function pairRequestUrl(port: number): string {
  return `http://127.0.0.1:${port}/pair/request`
}

// Ask the desktop app to pair this extension. 200 = origin already allowlisted (a
// pairing window was opened so we can re-claim the token); 202 = the desktop is
// showing an Allow/Deny dialog; error = unreachable/declined-shaped response.
export async function requestPair(
  port: number,
  fetchFn: typeof fetch = fetch
): Promise<'already-paired' | 'pending' | 'error'> {
  try {
    const res = await fetchFn(pairRequestUrl(port), {
      method: 'POST',
      headers: { 'X-Memry-Capture': '1' }
    })
    if (res.status === 200) return 'already-paired'
    if (res.status === 202) return 'pending'
    return 'error'
  } catch {
    return 'error'
  }
}
```

(Use the existing `CAPTURE_HEADER` constant for the header key if it is in scope; otherwise the literal `'X-Memry-Capture'` is fine and matches the rest of the file.)

- [ ] **Step 4: Run to confirm GREEN**

Run: `pnpm --filter @memry/extension test src/lib/capture-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/lib/capture-client.ts apps/extension/src/lib/capture-client.test.ts
git commit -m "feat(extension): requestPair capture-client call"
```

---

## Task 3: Extension — inline pair-then-capture orchestration + reducer simplification

**Files:**

- Modify: `apps/extension/src/entrypoints/background.ts`
- Modify: `apps/extension/src/lib/messages.ts`
- Modify: `apps/extension/src/lib/popup-state.ts`
- Test: `apps/extension/src/lib/popup-state.test.ts`

**Interfaces:**

- Produces (messages): add `PopupMessage` variant `{ type: 'PAIR' }` returning `PairResponse` (`{ ok: boolean }`). `CAPTURE` stays.
- Produces (background): `PAIR` handler runs `requestPair` → poll `claimToken` → `setToken`, returning `{ ok }`. `CAPTURE` handler is unchanged (probe → token → `postCapture`) but now assumes pairing already happened (popup calls `PAIR` first when needed).
- Produces (popup-state): `Phase` becomes `'extracting' | 'app-closed' | 'ready' | 'approving' | 'saving' | 'saved' | 'error'` (drops `needs-pairing`/`pairing`). `action` field gains `'approving'`. New action `{ type: 'APPROVE_START' }` and `{ type: 'APPROVE_DONE'; ok: boolean }`.

- [ ] **Step 1: Update `messages.ts`** — add the `PAIR` message:

```ts
export type PopupMessage =
  | { type: 'GET_STATUS' }
  | { type: 'PAIR' }
  | { type: 'CAPTURE'; capture: ArticleCapture }
```

(Remove the old `START_PAIR` variant.)

- [ ] **Step 2: Write failing reducer tests** — update `popup-state.test.ts`. Replace the `needs-pairing`/`pairing` transition tests with:

```ts
test('ready connection shows ready', () => {
  let s = reducer(initialState, { type: 'DRAFT_READY', draft })
  s = reducer(s, { type: 'STATUS', connection: 'ready', port: 7849 })
  expect(selectPhase(s)).toBe('ready')
})

test('unpaired connection still shows ready (pairing happens inline on save)', () => {
  let s = reducer(initialState, { type: 'DRAFT_READY', draft })
  s = reducer(s, { type: 'STATUS', connection: 'needs-pairing', port: 7849 })
  expect(selectPhase(s)).toBe('ready')
})

test('approve then save lifecycle', () => {
  let s = reducer(initialState, { type: 'DRAFT_READY', draft })
  s = reducer(s, { type: 'STATUS', connection: 'needs-pairing', port: 7849 })
  s = reducer(s, { type: 'APPROVE_START' })
  expect(selectPhase(s)).toBe('approving')
  s = reducer(s, { type: 'APPROVE_DONE', ok: true })
  s = reducer(s, { type: 'SAVE_START' })
  expect(selectPhase(s)).toBe('saving')
  s = reducer(s, { type: 'SAVE_DONE', result: { ok: true, itemId: 'i1' } })
  expect(selectPhase(s)).toBe('saved')
})

test('declined approval surfaces an error', () => {
  let s = reducer(initialState, { type: 'DRAFT_READY', draft })
  s = reducer(s, { type: 'STATUS', connection: 'needs-pairing', port: 7849 })
  s = reducer(s, { type: 'APPROVE_START' })
  s = reducer(s, { type: 'APPROVE_DONE', ok: false })
  expect(selectPhase(s)).toBe('error')
  expect(s.errorMessage).toContain('Memry')
})
```

Keep the existing `app-closed`, `saving→saved`, `save failure→retry`, `EDIT`, and `mapError` tests. Update any test that asserted the removed `needs-pairing`/`pairing` phases.

- [ ] **Step 3: Run to confirm RED**

Run: `pnpm --filter @memry/extension test src/lib/popup-state.test.ts`
Expected: FAIL — `APPROVE_START`/`APPROVE_DONE` unknown; `approving` not produced.

- [ ] **Step 4: Update `popup-state.ts`**

- `Phase`: replace `'needs-pairing' | 'pairing'` with `'approving'`.
- `PopupState.action`: `'idle' | 'approving' | 'saving' | 'saved' | 'error'`.
- `PopupAction`: remove `PAIR_START`/`PAIR_DONE`; add:

```ts
  | { type: 'APPROVE_START' }
  | { type: 'APPROVE_DONE'; ok: boolean }
```

- reducer cases:

```ts
    case 'APPROVE_START':
      return { ...state, action: 'approving', errorMessage: null }
    case 'APPROVE_DONE':
      return action.ok
        ? { ...state, action: 'idle' }
        : { ...state, action: 'error', errorMessage: 'Approve the Memry extension, then try again.' }
```

- `selectPhase`: action overrides come first; add `if (state.action === 'approving') return 'approving'`. The connection-derived branch maps BOTH `'needs-pairing'` and `'ready'` to `'ready'` (pairing is inline now):

```ts
if (state.connection === 'app-closed') return 'app-closed'
return 'ready' // 'ready' and 'needs-pairing' both render the editable miniature
```

- `mapError`: keep as-is (the `bad-token`/`origin-not-allowed`/`invalid-capture`/`payload-too-large` cases still apply to capture failures).

- [ ] **Step 5: Rework `background.ts`**

Replace the old `startPair` (deep-link) handler. Add a `PAIR` handler and keep `CAPTURE` simple (it assumes pairing is done):

```ts
async function pair(): Promise<PairResponse> {
  const found = await probeServer()
  if (!found) return { ok: false }
  const status = await requestPair(found.port)
  if (status === 'error') return { ok: false }
  // 'already-paired' opened a window immediately; 'pending' opens it after the user Allows.
  const timeoutMs = status === 'already-paired' ? 5000 : 120_000
  const token = await pollUntil(() => claimToken(found.port), { intervalMs: 1500, timeoutMs })
  if (!token) return { ok: false }
  await setToken(token)
  return { ok: true }
}

async function capture(body: ArticleCapture): Promise<CaptureResponse> {
  const found = await probeServer()
  if (!found) return { ok: false, error: 'app-closed' }
  const token = await getToken()
  if (!token) return { ok: false, error: 'bad-token' }
  return postCapture(found.port, token, body)
}
```

Update the `onMessage` switch: `GET_STATUS` → `getStatus()`, `PAIR` → `pair()`, `CAPTURE` → `capture(message.capture)`. Import `requestPair` from `@/lib/capture-client`. Remove the `START_PAIR` case and the `window`/deep-link references (the popup owns any deep-link).

- [ ] **Step 6: Run to confirm GREEN + typecheck**

Run:

```bash
pnpm --filter @memry/extension test src/lib/popup-state.test.ts
pnpm --filter @memry/extension typecheck
```

Expected: reducer tests PASS; typecheck 0 (App.tsx may show transient errors about removed phases — Task 4 fixes the popup; if typecheck fails ONLY in App.tsx on the renamed phases, that is expected and resolved in Task 4. Note it in your report rather than editing App.tsx here.)

- [ ] **Step 7: Commit**

```bash
git add apps/extension/src/lib/messages.ts apps/extension/src/lib/popup-state.ts apps/extension/src/lib/popup-state.test.ts apps/extension/src/entrypoints/background.ts
git commit -m "feat(extension): inline pair-then-capture orchestration"
```

---

## Task 4: Extension — single-action popup (drop Pair button), README update

**Files:**

- Modify: `apps/extension/src/entrypoints/popup/App.tsx`
- Modify: `apps/extension/src/components/StatusStrip.tsx`
- Modify: `apps/extension/README.md`

**Interfaces:**

- Consumes: `popup-state` (Task 3) and the `PAIR`/`CAPTURE` messages.

- [ ] **Step 1: Rework `App.tsx` action handlers**

Replace `onPair`/`onSave` with a single `onAdd` that pairs-if-needed then captures. Remove the `window.open('memry://pair')` call and the separate Pair button.

```tsx
const onAdd = async () => {
  if (!state.draft) return
  // Pair inline if this connection isn't ready yet.
  if (state.connection === 'needs-pairing') {
    dispatch({ type: 'APPROVE_START' })
    const pair: PairResponse = await browser.runtime
      .sendMessage({ type: 'PAIR' })
      .catch(() => ({ ok: false }))
    dispatch({ type: 'APPROVE_DONE', ok: pair.ok })
    if (!pair.ok) return
  }
  dispatch({ type: 'SAVE_START' })
  const result: CaptureResponse = await browser.runtime
    .sendMessage({ type: 'CAPTURE', capture: state.draft })
    .catch(() => ({ ok: false, error: 'network' }))
  dispatch({ type: 'SAVE_DONE', result })
}
```

Update the button block:

- `ready` → `<PrimaryButton label="Add to Memry" onClick={onAdd} disabled={!draft} />`
- `approving` → `<PrimaryButton label="Approve in Memry…" disabled />`
- `saving` → `<PrimaryButton label="Adding…" disabled />`
- `saved` → "Added to inbox ✓"
- `app-closed` → keep the disabled button + helper text "Open Memry to save this page." (auto-launch arrives in Task 6)
- `error` → message + "Try again" (`RETRY`)
- Remove the `needs-pairing`/`pairing` button cases. The miniature is editable whenever `phase === 'ready'` (or `error`).

- [ ] **Step 2: Update `StatusStrip.tsx`** — replace the removed-phase labels. Map `approving → 'Approve in Memry…'`, keep `ready → 'Connected'`, `app-closed → "Memry isn't running"`, `saving → 'Saving…'`, `saved → 'Saved'`. The connection dot is "connected" for `ready`/`approving`/`saving`/`saved`.

- [ ] **Step 3: Verify the popup gate**

Run:

```bash
pnpm --filter @memry/extension typecheck
pnpm --filter @memry/extension lint
pnpm --filter @memry/extension test
pnpm --filter @memry/extension build
```

Expected: all green (typecheck now 0 with App.tsx updated).

- [ ] **Step 4: Update `README.md` Manual QA**

Rewrite the pairing step to the in-app flow:

> **Pairing (in-app):** with Memry running (`pnpm dev`), open the popup on an article and click **Add to Memry**. The first time, Memry pops an **"Allow the Memry browser extension to save captures?"** dialog → click **Allow**. The capture then lands in the inbox. Subsequent captures are silent. No `memry://` needed for pairing.

Keep the failed-extraction and Origin-header notes. Add: "If Allow does nothing, check the desktop logs for `/pair/request`."

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/entrypoints/popup/App.tsx apps/extension/src/components/StatusStrip.tsx apps/extension/README.md
git commit -m "feat(extension): single Add-to-Memry action with inline pairing"
```

> **Increment A complete.** Pairing + capture now work end-to-end in `pnpm dev` with no deep-link. This is a good point for a manual QA pass before Increment B.

---

## Task 5: Desktop — protocol registration (`protocols:` + dev) + `memry://open` launch host

**Files:**

- Modify: `apps/desktop/config/electron-builder.yml`
- Modify: `apps/desktop/src/main/index.ts`
- Create: `apps/desktop/scripts/patch-dev-protocol.mjs`
- Modify: `apps/desktop/package.json` (a `dev:protocol` convenience script; optional pre-dev hook)

**Interfaces:** none (build/runtime config + a new deep-link host).

- [ ] **Step 1: Add the `protocols:` block to `electron-builder.yml`**

After the top-level keys (e.g. near `appId`/`productName`), add:

```yaml
protocols:
  - name: Memry
    schemes:
      - memry
```

This makes electron-builder emit `CFBundleURLTypes` (macOS) and register on Windows for the packaged app.

- [ ] **Step 2: Harden dev protocol registration in `index.ts`**

Replace the current block:

```ts
if (!app.isDefaultProtocolClient('memry')) {
  app.setAsDefaultProtocolClient('memry')
}
```

with the dev-aware form (add `import { resolve } from 'node:path'` if not present, or use the existing path import):

```ts
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient('memry', process.execPath, [resolve(process.argv[1])])
} else if (!app.isDefaultProtocolClient('memry')) {
  app.setAsDefaultProtocolClient('memry')
}
```

- [ ] **Step 3: Add the `memry://open` host to `handleDeepLink`**

In `handleDeepLink`, add (the trailing `restore()+focus()` already runs for any `memry://` URL, so the branch can be a no-op marker for clarity/logging):

```ts
if (parsed.hostname === 'open') {
  // launch/focus only — no dialog. Restore+focus happens below for any memry:// url.
  deepLinkLog.info('launch requested via memry://open')
}
```

- [ ] **Step 4: Add the macOS dev Info.plist patch script** `apps/desktop/scripts/patch-dev-protocol.mjs`

```js
// ponytail: macOS dev convenience — declares the `memry` URL scheme in the dev
// Electron bundle's Info.plist so `pnpm dev` can receive browser deep-links.
// Packaged builds get this from electron-builder's `protocols:` block instead.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

if (process.platform !== 'darwin') process.exit(0)

const plist = 'node_modules/electron/dist/Electron.app/Contents/Info.plist'
if (!existsSync(plist)) process.exit(0)

const has = (() => {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleURLTypes', plist], {
      stdio: 'ignore'
    })
    return true
  } catch {
    return false
  }
})()

const cmds = has
  ? []
  : [
      'Add :CFBundleURLTypes array',
      'Add :CFBundleURLTypes:0 dict',
      'Add :CFBundleURLTypes:0:CFBundleURLName string com.memrynote.memry',
      'Add :CFBundleURLTypes:0:CFBundleURLSchemes array',
      'Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string memry'
    ]

for (const c of cmds) execFileSync('/usr/libexec/PlistBuddy', ['-c', c, plist])
console.log(
  has
    ? 'memry scheme already present in dev Electron Info.plist'
    : 'patched dev Electron Info.plist with memry scheme'
)
```

Add a script to `apps/desktop/package.json`:

```json
"dev:protocol": "node scripts/patch-dev-protocol.mjs"
```

- [ ] **Step 5: Verify**

Run:

```bash
pnpm --filter @memry/desktop typecheck:node
node apps/desktop/scripts/patch-dev-protocol.mjs   # macOS: patches dev Electron; other OS: no-op exit 0
```

Expected: typecheck 0; the script runs without error (and on macOS prints the patch/`already present` line). Full deep-link launch is verified in manual QA against a packaged or patched-dev app.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/config/electron-builder.yml apps/desktop/src/main/index.ts apps/desktop/scripts/patch-dev-protocol.mjs apps/desktop/package.json
git commit -m "feat(capture): register memry:// protocol (packaged + dev) and memry://open host"
```

---

## Task 6: Extension — launch Memry when closed, then capture

**Files:**

- Modify: `apps/extension/src/lib/messages.ts`
- Modify: `apps/extension/src/entrypoints/background.ts`
- Modify: `apps/extension/src/lib/popup-state.ts`
- Modify: `apps/extension/src/lib/popup-state.test.ts`
- Modify: `apps/extension/src/entrypoints/popup/App.tsx`
- Modify: `apps/extension/README.md`

**Interfaces:**

- Produces (messages): `{ type: 'WAIT_FOR_SERVER' }` → `{ ok: boolean }` (background polls `/ping` until a memry server answers or times out).
- Produces (popup-state): add `Phase` value `'launching'` + action `'launching'` with `{ type: 'LAUNCH_START' }` / `{ type: 'LAUNCH_DONE'; ok: boolean }`.

- [ ] **Step 1: Add `WAIT_FOR_SERVER` background handler** (`background.ts` + `messages.ts`)

```ts
async function waitForServer(): Promise<{ ok: boolean }> {
  const found = await pollUntil(() => probeServer(), { intervalMs: 800, timeoutMs: 20_000 })
  return { ok: found !== null }
}
```

Wire it into the `onMessage` switch and add `{ type: 'WAIT_FOR_SERVER' }` to `PopupMessage`. (`probeServer` already returns `null` when nothing is listening, so `pollUntil` works directly.)

- [ ] **Step 2: Add the `launching` phase to `popup-state.ts` + tests**

Add `'launching'` to `Phase` and `action`; add actions `LAUNCH_START` (`action:'launching'`) and `LAUNCH_DONE` (`ok` → `idle`, else `error` with message `'Open Memry, then try again.'`). Add `selectPhase` branch `if (state.action === 'launching') return 'launching'`. Add reducer tests for the launch lifecycle (start → launching; done ok → not launching; done fail → error).

- [ ] **Step 3: Wire launch into `App.tsx`**

When `phase === 'app-closed'`, the primary button becomes **"Open Memry & save"**. Its handler opens the launch deep-link from the user gesture, waits for the server, then runs the normal add flow:

```tsx
const onLaunchAndAdd = async () => {
  dispatch({ type: 'LAUNCH_START' })
  // user-gesture navigation to the custom scheme launches/focuses the desktop app
  browser.tabs.create({ url: 'memry://open' }).catch(() => {})
  const up: { ok: boolean } = await browser.runtime
    .sendMessage({ type: 'WAIT_FOR_SERVER' })
    .catch(() => ({ ok: false }))
  dispatch({ type: 'LAUNCH_DONE', ok: up.ok })
  if (!up.ok) return
  dispatch({ type: 'STATUS', connection: 'needs-pairing', port: null })
  await onAdd()
}
```

Button cases: `app-closed` → `<PrimaryButton label="Open Memry & save" onClick={onLaunchAndAdd} />`; `launching` → `<PrimaryButton label="Opening Memry…" disabled />`. (`browser.tabs.create` to a custom scheme triggers Chrome's external-protocol handler — more reliable than `window.open` from a popup.)

- [ ] **Step 4: Verify**

Run:

```bash
pnpm --filter @memry/extension test
pnpm --filter @memry/extension typecheck
pnpm --filter @memry/extension lint
pnpm --filter @memry/extension build
```

Expected: all green.

- [ ] **Step 5: Update `README.md` Manual QA** — add the launch path + the macOS-dev caveat:

  > **Launch when closed:** quit Memry, open the popup, click **Open Memry & save** → Chrome prompts to open Memry → the app starts, you Allow (first time), and the capture lands. **macOS `pnpm dev`:** run `pnpm --filter @memry/desktop dev:protocol` once so the dev Electron registers `memry://`, or test this path against a packaged build.

- [ ] **Step 6: Commit**

```bash
git add apps/extension/src/lib/messages.ts apps/extension/src/entrypoints/background.ts apps/extension/src/lib/popup-state.ts apps/extension/src/lib/popup-state.test.ts apps/extension/src/entrypoints/popup/App.tsx apps/extension/README.md
git commit -m "feat(extension): launch Memry when closed, then capture"
```

---

## Self-Review Notes

- **Spec coverage:** in-app pairing (T1 server + T2/T3 extension + T4 popup); keep token (T1 reuses claim/window/keytar); fold into single action (T3/T4); launch-when-closed (T5 protocol + T6 popup). `/pair/claim` unchanged.
- **Security-model change** (extension-triggered Allow dialog) is called out in Global Constraints and MUST be re-blessed in the final review — single-pending guard, chrome-extension-only origin, mandatory Allow click.
- **Type consistency:** `requestPair` return union (`already-paired`/`pending`/`error`) is produced in T2 and consumed in T3; `PAIR`/`WAIT_FOR_SERVER` messages defined in `messages.ts` and handled in `background.ts`; reducer `Phase`/action names match between `popup-state.ts` and `App.tsx`.
- **Dev-testability:** Increment A (T1–T4) needs no deep-link → testable in `pnpm dev`. Increment B (T5–T6) launch path needs a packaged build or `dev:protocol` patch on macOS.
