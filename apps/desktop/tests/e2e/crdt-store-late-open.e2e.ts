/**
 * A launch whose CRDT store answers only after its probe timed out switches to
 * the store once it answers, without a restart, and keeps what was typed while
 * it ran in memory.
 *
 * One profile, no sync, three launches:
 *  a. with the store: write a note, quit with it open.
 *  b. with a slow store (MEMRY_TEST_CRDT_PROBE_DELAY_MS, honoured only under
 *     NODE_ENV=test): the probe times out, the restored tab seeds from the
 *     file in memory, type a line; the store answers and the session switches;
 *     type another line, quit.
 *  c. with the store: the doc loads from the store, with b's root and both
 *     lines. A seed from the file would have minted a new root.
 *
 * The roots are read through the NODE_ENV=test `__memryDebug` handle, and the
 * relaunches reuse the first process's spawn arguments, as
 * sidebar-open-state.e2e.ts does.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { ensureDayPanelClosed, SELECTORS, waitForAppReady } from './utils/electron-helpers'
import { ready } from './utils/desktop-test-helpers'
import { destroyElectronApp, launchElectronWithWindow } from './utils/electron-lifecycle'
import { appendToNoteBody, createNoteWithBody } from './utils/note-sync-helpers'

const BODY = 'Written while the store was healthy.'
const BEFORE = 'typed while the store was slow'
const AFTER = 'typed once the store answered'
/** Past the 15 s probe timeout, with room to type before the store answers. */
const PROBE_DELAY_MS = 40_000
const SWITCHED = 'CRDT store opened late; the session now persists'

interface MainDoc {
  persisted: boolean
  /** Every live root item of the body fragment. */
  roots: string[] | null
}

async function mainDoc(app: ElectronApplication, noteId: string): Promise<MainDoc> {
  return app.evaluate((_electron, id) => {
    interface Item {
      id: { client: number; clock: number }
      deleted: boolean
      right: Item | null
    }
    interface Provider {
      hasPersistence(): boolean
      getDoc(noteId: string): { getXmlFragment(name: string): { _start: Item | null } } | undefined
    }
    const debug = (globalThis as unknown as { __memryDebug?: { crdt(): Provider } }).__memryDebug
    if (!debug) throw new Error('__memryDebug is not registered')
    const doc = debug.crdt().getDoc(id)
    const roots: string[] = []
    for (let item = doc?.getXmlFragment('prosemirror')._start ?? null; item; item = item.right) {
      if (!item.deleted) roots.push(`${item.id.client}:${item.id.clock}`)
    }
    return { persisted: debug.crdt().hasPersistence(), roots: doc ? roots : null }
  }, noteId)
}

async function editorText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const editor = (
      window as unknown as {
        __memryActiveEditor?: { _tiptapEditor?: { state?: { doc?: { textContent: string } } } }
      }
    ).__memryActiveEditor
    return editor?._tiptapEditor?.state?.doc?.textContent ?? ''
  })
}

const mainLog = (logDir: string): string => {
  try {
    return fs.readFileSync(path.join(logDir, 'main.log'), 'utf8')
  } catch {
    return ''
  }
}

/** Quit through the app's shutdown, so its write-backs and store close run. */
async function quitApp(app: ElectronApplication): Promise<void> {
  const child = app.process()
  if (child.exitCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 45_000)),
    app.close().catch(() => {})
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}

test('a store that answers after its probe timed out takes over the session', async () => {
  test.setTimeout(300_000)
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-e2e-late-store-'))
  for (const dir of ['.memry', 'notes', 'journal']) {
    fs.mkdirSync(path.join(vaultPath, dir), { recursive: true })
  }

  // a. with the store
  const first = await launchElectronWithWindow({ testVaultPath: vaultPath })
  const spawned = first.app.process()
  const userDataDirs = [first.userDataDir, first.resolvedUserDataDir]
  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: 'test',
    TEST_VAULT_PATH: vaultPath
  }
  delete env.ELECTRON_RUN_AS_NODE

  const relaunched: ElectronApplication[] = []
  try {
    await waitForAppReady(first.page)
    await ready(first.page)
    await ensureDayPanelClosed(first.page)
    const note = await createNoteWithBody(first.page, `Late Store ${Date.now()}`, BODY)
    const relPath = await first.page.evaluate(
      async (id) => (await window.api.notes.get(id))?.path ?? null,
      note.id
    )
    if (!relPath) throw new Error('note has no path')
    const file = (): string => fs.readFileSync(path.join(vaultPath, relPath), 'utf8')
    await expect.poll(file).toContain(BODY)
    const stored = await mainDoc(first.app, note.id)
    expect(stored).toMatchObject({ persisted: true })
    expect(stored.roots).toHaveLength(1)
    await quitApp(first.app)

    const relaunch = async (
      label: string,
      extraEnv: Record<string, string>
    ): Promise<{ app: ElectronApplication; page: Page; logDir: string }> => {
      const logDir = path.join(first.userDataDir, `logs-${label}`)
      const app = await electron.launch({
        executablePath: spawned.spawnfile,
        args: spawned.spawnargs.slice(1),
        env: { ...env, MEMRY_TEST_LOG_DIR: logDir, ...extraEnv }
      })
      relaunched.push(app)
      const page = await app.firstWindow({ timeout: 45_000 })
      await page.waitForLoadState('domcontentloaded')
      await expect(page.locator(SELECTORS.tab).filter({ hasText: note.title }).first()).toBeVisible(
        { timeout: 45_000 }
      )
      return { app, page, logDir }
    }

    // b. a slow store: in memory first, then switched to the store
    const b = await relaunch('b', { MEMRY_TEST_CRDT_PROBE_DELAY_MS: String(PROBE_DELAY_MS) })
    await expect
      .poll(() => mainLog(b.logDir), { timeout: 30_000 })
      .toContain('CRDT persistence unavailable')
    await expect.poll(() => editorText(b.page), { timeout: 30_000 }).toContain(BODY)
    const seeded = await mainDoc(b.app, note.id)
    expect(seeded.persisted).toBe(false)
    expect(seeded.roots).toHaveLength(1)
    const [root] = seeded.roots ?? []
    expect(root).not.toBe(stored.roots?.[0])

    await appendToNoteBody(b.page, BEFORE)
    await expect.poll(file, { timeout: 30_000 }).toContain(BEFORE)
    // Typed while in memory: the store has not answered yet.
    expect(mainLog(b.logDir)).not.toContain(SWITCHED)
    expect((await mainDoc(b.app, note.id)).persisted).toBe(false)

    await expect.poll(() => mainLog(b.logDir), { timeout: 60_000 }).toContain(SWITCHED)
    expect(await mainDoc(b.app, note.id)).toEqual({ persisted: true, roots: [root] })
    await appendToNoteBody(b.page, AFTER)
    await expect.poll(file, { timeout: 30_000 }).toContain(AFTER)
    await quitApp(b.app)

    // c. the store again: the body comes back from it
    const c = await relaunch('c', {})
    await expect.poll(() => editorText(c.page), { timeout: 30_000 }).toContain(AFTER)
    expect(await mainDoc(c.app, note.id)).toEqual({ persisted: true, roots: [root] })
    const text = await editorText(c.page)
    expect(text).toContain(BODY)
    expect(text).toContain(BEFORE)
    expect(text.split(BODY)).toHaveLength(2)
    expect(file()).toContain(BEFORE)
    expect(file()).toContain(AFTER)
  } finally {
    for (const app of relaunched) await quitApp(app).catch(() => {})
    await destroyElectronApp(first.app, userDataDirs).catch(() => {})
    fs.rmSync(vaultPath, { recursive: true, force: true })
  }
})
