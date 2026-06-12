# Plan 008: Restrict `shell.openExternal` to safe URL schemes and set explicit webPreferences hardening flags on both BrowserWindows

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report. When done, update the status row in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 86ee0cd1..HEAD -- apps/desktop/src/main/index.ts`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `86ee0cd1`, 2026-06-12
- **Issue**: https://github.com/memrynote/memry/issues/549

## Why this matters

Two Electron hardening gaps in the main process:

1. **Unrestricted `shell.openExternal`.** The main window's `setWindowOpenHandler` hands **any** URL — whatever scheme — straight to the OS via `shell.openExternal(details.url)`. The handler correctly denies opening a child Electron window (`{ action: 'deny' }`), but `openExternal` on an arbitrary scheme (e.g. `file:`, `smb:`, a custom protocol) is exactly the primitive that turns "renderer was tricked into calling `window.open(...)`" into "the OS launched something." Renderer content should only ever cause `https:`, `http:`, or `mailto:` links to open externally.

2. **Implicit security flags.** Both `BrowserWindow`s set only `preload` + `sandbox: false` and rely on Electron's defaults for `contextIsolation`, `nodeIntegration`, and `webSecurity`. Those defaults are currently safe (context isolation on, node integration off), but depending on defaults across Electron upgrades is fragile and hides the security posture from reviewers. Setting them explicitly is a low-risk, defense-in-depth improvement.

This plan does **not** flip `sandbox` to `true` — the preload may rely on Node APIs unavailable under the sandbox, so that change needs separate validation (called out as a follow-up, not done here).

## Current state

Main window (`apps/desktop/src/main/index.ts:405`):

```ts
const mainWindow = new BrowserWindow({
  width: initialSize.width,
  height: initialSize.height,
  show: false,
  autoHideMenuBar: true,
  icon: join(__dirname, '../../build/icon.png'),
  ...(process.platform === 'darwin'
    ? { titleBarStyle: 'hidden', trafficLightPosition: { x: -100, y: -100 } }
    : {}),
  webPreferences: {
    preload: join(__dirname, '../preload/index.js'),
    sandbox: false
  }
})
```

The window-open handler (`apps/desktop/src/main/index.ts:448`):

```ts
mainWindow.webContents.setWindowOpenHandler((details) => {
  void shell.openExternal(details.url)
  return { action: 'deny' }
})
```

Quick-capture window (`apps/desktop/src/main/index.ts:1003`):

```ts
quickCaptureWindow = new BrowserWindow({
  width: windowWidth,
  height: windowHeight,
  x,
  y,
  alwaysOnTop: true,
  frame: false,
  resizable: false,
  skipTaskbar: true,
  show: false,
  transparent: false,
  hasShadow: true,
  vibrancy: process.platform === 'darwin' ? 'popover' : undefined,
  webPreferences: {
    preload: join(__dirname, '../preload/index.js'),
    sandbox: false
  }
})
```

`shell` is already imported in this file (it's used at line 449). Logging uses `createLogger(...)`; the file already has loggers (e.g. `quickCaptureLog`). There is also a `setAsDefaultProtocolClient('memry')` deep-link registration at line 604 — **out of scope** here, but related (see Maintenance notes).

## Commands you will need

| Purpose                 | Command                                                                              | Expected on success               |
| ----------------------- | ------------------------------------------------------------------------------------ | --------------------------------- |
| Typecheck (node side)   | `pnpm --filter @memry/desktop typecheck:node`                                        | exit 0                            |
| Lint                    | `pnpm lint`                                                                          | exit 0                            |
| Main-process unit tests | `pnpm --filter @memry/desktop exec vitest run --config config/vitest.main.config.ts` | pass (or your new test's project) |

(If the main vitest config path differs, find it: `ls apps/desktop/config/vitest*` — the repo runs main tests via a dedicated config. Use whatever the existing main-process tests use.)

## Scope

**In scope** (modify):

- `apps/desktop/src/main/index.ts` — add a scheme allowlist to the window-open handler; add explicit `contextIsolation`/`nodeIntegration`/`webSecurity` flags to both windows' `webPreferences`.
- A small unit test for the URL-scheme allowlist helper (see Test plan) — extract the predicate into a testable function.

**Out of scope** (do NOT touch):

- `sandbox: false` → leave as-is (flipping it needs preload validation; see Maintenance notes).
- The `memry://` deep-link handler / `setAsDefaultProtocolClient` — separate surface.
- Any renderer code or navigation behavior beyond external-link opening.
- `will-navigate` handlers (none present for these windows in scope) — do not add new navigation interception in this plan.

## Git workflow

- Branch: `security/electron-openexternal-allowlist` (from `origin/main`).
- Commit message: `security(desktop): allowlist openExternal schemes and set explicit window hardening flags`.
- Do NOT push or open a PR unless instructed. No `Co-Authored-By` trailers.

## Steps

### Step 1: Add a testable scheme-allowlist helper

Near the top of `index.ts` (module scope, after imports), add:

```ts
const EXTERNAL_URL_ALLOWED_SCHEMES = new Set(['https:', 'http:', 'mailto:'])

export function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    return EXTERNAL_URL_ALLOWED_SCHEMES.has(new URL(rawUrl).protocol)
  } catch {
    return false
  }
}
```

(If `index.ts` does not currently export anything testable and exporting from it is awkward, instead place `isAllowedExternalUrl` in a small sibling module `apps/desktop/src/main/lib/external-url.ts` and import it. Prefer the sibling module if `index.ts` has heavy import-time side effects that would make it hard to import in a unit test.)

**Verify**: `pnpm --filter @memry/desktop typecheck:node` → exit 0.

### Step 2: Gate `openExternal` behind the allowlist

Replace the handler at line 448:

```ts
mainWindow.webContents.setWindowOpenHandler((details) => {
  if (isAllowedExternalUrl(details.url)) {
    void shell.openExternal(details.url)
  } else {
    log.warn('Blocked external open for disallowed URL scheme', { url: details.url })
  }
  return { action: 'deny' }
})
```

Use the logger already available in this scope (find the nearest `createLogger(...)` instance in the file; if the main window code has no logger in scope, add `const log = createLogger('MainWindow')` at module scope alongside the other loggers). Do not log at a level that would spam; `warn` on a blocked open is appropriate.

**Verify**: `pnpm --filter @memry/desktop typecheck:node` → exit 0 and `pnpm lint` → exit 0.

### Step 3: Set explicit hardening flags on both windows

In **both** `webPreferences` objects (main window line ~418 and quick-capture line ~1016), add the explicit flags alongside the existing `preload`/`sandbox`:

```ts
webPreferences: {
  preload: join(__dirname, '../preload/index.js'),
  sandbox: false,
  contextIsolation: true,
  nodeIntegration: false,
  webSecurity: true
}
```

These equal Electron's current defaults, so behavior is unchanged; they make the posture explicit and upgrade-proof.

**Verify**: `pnpm --filter @memry/desktop typecheck:node` → exit 0.

### Step 4: Add the unit test (see Test plan) and run it

**Verify**: the main-process test command (from the table) → the new allowlist test passes.

## Test plan

Add a unit test for `isAllowedExternalUrl` (in `apps/desktop/src/main/index.test.ts` if it exists, else `apps/desktop/src/main/lib/external-url.test.ts` next to the helper if you used the sibling module). Cases:

- `https://example.com` → `true`
- `http://example.com` → `true`
- `mailto:hi@memrynote.com` → `true`
- `file:///etc/passwd` → `false`
- `smb://host/share` → `false`
- `javascript:alert(1)` → `false`
- `''` and `'not a url'` → `false`

Model the test file structure after any existing main-process unit test (they use Vitest). Do not attempt to instantiate a real `BrowserWindow` in the test — only the pure helper is unit-tested; the wiring is verified by typecheck + manual smoke.

**Verify**: main-process test command → all pass, 7 new assertions.

## Done criteria

ALL must hold:

- [ ] `setWindowOpenHandler` calls `shell.openExternal` only when `isAllowedExternalUrl(details.url)` is true; otherwise logs and denies.
- [ ] Both `webPreferences` objects explicitly set `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`.
- [ ] `sandbox: false` is unchanged (this plan does not flip it).
- [ ] `isAllowedExternalUrl` has a unit test covering allowed and blocked schemes; it passes.
- [ ] `pnpm --filter @memry/desktop typecheck:node` exits 0; `pnpm lint` exits 0.
- [ ] `git status` shows only `index.ts` (and the optional `lib/external-url.ts`) + the test file (plus `plans/README.md`) modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:

- The app legitimately needs to open a non-http(s)/mailto scheme externally (you find existing calls relying on, say, `tel:` or a custom scheme) — widen the allowlist deliberately and note it, or report for a decision; don't silently break a real link type.
- Setting `contextIsolation: true` / `nodeIntegration: false` explicitly causes any existing main-process or e2e test to fail — that would mean the app was relying on the _opposite_ of the documented default; stop and report (do not "fix" by removing the flags).
- `shell` is not actually imported in `index.ts` (the excerpt is stale) — re-read before editing.

## Maintenance notes

- **Deferred follow-up (separate plan):** evaluate `sandbox: true`. It requires auditing the preload for Node API usage and likely moving privileged work fully behind IPC; do it with its own test pass, not bundled here.
- **Related surface:** the `memry://` deep-link handler (`setAsDefaultProtocolClient('memry')`, line ~604) parses external input; a future hardening pass should validate its parsed path/params against a schema. Out of scope here.
- A reviewer should confirm the allowlist is applied to the _main_ window handler and that the explicit flags match defaults (no behavior change intended beyond external-link gating).
