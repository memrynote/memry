// The sticky's edge tab (Step 31, #3548): a tab on the screen edge stands for the drafts while
// the sticky is away (`apps/desktop/src/main/stickies/edge-tab.ts`).

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
  width: number
  height: number
}

interface Draft {
  id: string
}

const dockKeepsApp = process.platform === 'darwin'

async function window(app: App, label: string): Promise<AppWindow | undefined> {
  const windows = await invokeTest<AppWindow[]>(app, 'e2e_windows')
  return windows.find((w) => w.label === label)
}

async function until(app: App, label: string, check: (w: AppWindow | undefined) => boolean) {
  const reached = await pollUntil(async () => check(await window(app, label)) || undefined, {
    timeoutMs: 30_000,
    intervalMs: 100
  })
  expect(reached).toBe(true)
}

// A product command, called from the main window's page as the renderer calls it.
async function invokeApp<T = null>(
  app: App,
  name: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const outcome = (await app.executor.executeAsync(
    `const [name, args, done] = arguments;
     window.__TAURI__.core.invoke(name, args).then(
       (value) => done({ ok: true, value: value === undefined ? null : value }),
       (failure) => done({ ok: false, failure: String(failure) })
     )`,
    name,
    args
  )) as { ok: boolean; value?: T; failure?: string }
  if (!outcome.ok) throw new Error(`${name} failed: ${outcome.failure}`)
  return outcome.value as T
}

async function saveDraft(app: App, content: string): Promise<Draft> {
  return invokeApp<Draft>(app, 'sticky_save_draft', { input: { id: null, content, kind: 'note' } })
}

const shown = (w: AppWindow | undefined): boolean => w?.visible === true
const away = (w: AppWindow | undefined): boolean => w?.visible !== true

test('a draft shows the tab, the open sticky hides it and a tuck brings it back', async ({
  app
}) => {
  expect(await window(app, 'sticky-tab')).toBeUndefined()
  const draft = await saveDraft(app, 'Buy oat milk\nand bread')
  await until(app, 'sticky-tab', shown)
  const collapsed = await window(app, 'sticky-tab')
  expect([collapsed?.width, collapsed?.height]).toEqual([44, 84])

  await invokeApp(app, 'sticky_unfold', { draftId: draft.id })
  await until(app, 'sticky', shown)
  await until(app, 'sticky-tab', away)

  await invokeApp(app, 'sticky_tuck')
  await until(app, 'sticky', away)
  await until(app, 'sticky-tab', shown)
})

test('hovering fans the draft list out and leaving folds it', async ({ app }) => {
  await saveDraft(app, 'First')
  await saveDraft(app, 'Second')
  await until(app, 'sticky-tab', shown)

  await invokeApp(app, 'sticky_peek', { open: true })
  await until(app, 'sticky-tab', (w) => w?.width === 300 && w.height === 64 + 2 * 52)
  await invokeApp(app, 'sticky_peek', { open: false })
  await until(app, 'sticky-tab', (w) => w?.width === 44 && w.height === 84)
})

// The tab's page hears drafts-changed only when its capability is enabled (tauri.conf.json).
test('the shown tab counts a draft saved after it appeared', async ({ app }) => {
  const windows = app.executor as unknown as WindowSwitcher
  const count = async (expected: string): Promise<void> => {
    await windows.switchToWindow('sticky-tab')
    const reached = await pollUntil(
      async () =>
        (await app.executor.executeAsync(
          `const done = arguments[arguments.length - 1]
           done(document.querySelector('button span')?.textContent ?? null)`
        )) === expected || undefined,
      { timeoutMs: 30_000, intervalMs: 100 }
    )
    await windows.switchToWindow('main')
    expect(reached).toBe(true)
  }
  await saveDraft(app, 'First')
  await until(app, 'sticky-tab', shown)
  await count('1')

  await saveDraft(app, 'Second')
  await count('2')
})

test('deleting the last draft hides the tab', async ({ app }) => {
  const draft = await saveDraft(app, 'Only one')
  await until(app, 'sticky-tab', shown)
  await invokeApp(app, 'sticky_delete_draft', { id: draft.id })
  await until(app, 'sticky-tab', away)
})

// The tab is a window: off macOS, left open it would keep the app running with no app window
// (`closeEdgeTabWithLastAppWindow`, `edge-tab.ts:160-165`).
test('closing main with the tab shown quits the app', async ({ app }) => {
  test.skip(dockKeepsApp, 'macOS keeps the app in the Dock')
  await saveDraft(app, 'Keep me')
  await until(app, 'sticky-tab', shown)
  await (app.executor as unknown as WindowSwitcher).switchToWindow('main')

  await invokeTest(app, 'e2e_close_window', { label: 'main' }).catch(() => undefined)

  const code = await Promise.race([
    app.exited,
    new Promise<'alive'>((resolve) => setTimeout(() => resolve('alive'), 15_000))
  ])
  expect(code).toBe(0)
  expect(readMainLog(app.dirs.logDir)).toContain('cleanup complete')
})
