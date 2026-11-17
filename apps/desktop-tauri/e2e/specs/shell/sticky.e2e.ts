// A hidden sticky must not keep the app alive (REVIEW-4999). Tauri asks to exit only once no
// window is left, and a tucked sticky is a hidden window with no taskbar entry: off macOS the app
// kept running with the vault open and nothing to reach it by, and a second launch did nothing.
// macOS keeps the app in the Dock with no window, as Electron does, so these run elsewhere.

import { invokeTest } from '../../harness/invoke-test'
import type { TauriApp as App } from '../../harness/tauri-lifecycle'
import { test, expect } from '../../harness/test'
import { pollUntil, readMainLog } from '../../harness/wait'

interface WindowSwitcher {
  switchToWindow(handle: string): Promise<void>
}

interface AppWindow {
  label: string
  visible: boolean
  answersFlush: boolean
}

const dockKeepsApp = process.platform === 'darwin'

async function windows(app: App): Promise<AppWindow[]> {
  return invokeTest<AppWindow[]>(app, 'e2e_windows')
}

async function openSticky(app: App): Promise<void> {
  await invokeTest(app, 'e2e_open_sticky', { unfold: false, draftId: null })
  const shown = await pollUntil(
    async () =>
      (await windows(app)).some((w) => w.label === 'sticky' && w.visible && w.answersFlush) ||
      undefined,
    { timeoutMs: 30_000, intervalMs: 100 }
  )
  expect(shown).toBe(true)
}

// The renderer's own tuck command, from the sticky's page. The reply may not arrive when the
// tuck ends the app.
async function tuckFromSticky(app: App): Promise<void> {
  await (app.executor as unknown as WindowSwitcher).switchToWindow('sticky')
  await app.executor
    .executeAsync(
      `const done = arguments[arguments.length - 1];
       window.__TAURI__.core.invoke('sticky_tuck').then(() => done(null), (e) => done(String(e)))`
    )
    .catch(() => undefined)
}

// The exit code, or 'alive' 15 s on (the quit's 10 s hard backstop plus 5 s to end and reap).
function exitCode(app: App): Promise<number | null | 'alive'> {
  return Promise.race([
    app.exited,
    new Promise<'alive'>((resolve) => setTimeout(() => resolve('alive'), 15_000))
  ])
}

test('closing main with the sticky tucked away quits the app', async ({ app }) => {
  test.skip(dockKeepsApp, 'macOS keeps the app in the Dock')
  await openSticky(app)
  await tuckFromSticky(app)
  await (app.executor as unknown as WindowSwitcher).switchToWindow('main')
  expect((await windows(app)).find((w) => w.label === 'sticky')?.visible).toBe(false)

  await invokeTest(app, 'e2e_close_window', { label: 'main' }).catch(() => undefined)

  expect(await exitCode(app)).toBe(0)
  expect(readMainLog(app.dirs.logDir)).toContain('cleanup complete')
})

test('tucking the sticky after main closed quits the app', async ({ app }) => {
  test.skip(dockKeepsApp, 'macOS keeps the app in the Dock')
  await openSticky(app)
  await invokeTest(app, 'e2e_close_window', { label: 'main' }).catch(() => undefined)
  await (app.executor as unknown as WindowSwitcher).switchToWindow('sticky')
  // The sticky on screen keeps the app running, as Electron's open window does.
  const mainGone = await pollUntil(
    async () => !(await windows(app)).some((w) => w.label === 'main') || undefined,
    { timeoutMs: 15_000, intervalMs: 100 }
  )
  expect(mainGone).toBe(true)

  await tuckFromSticky(app)

  expect(await exitCode(app)).toBe(0)
  expect(readMainLog(app.dirs.logDir)).toContain('cleanup complete')
})
