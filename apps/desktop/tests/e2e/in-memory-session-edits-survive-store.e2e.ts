/**
 * What a launch with no CRDT store typed survives the next launch with the
 * store, once, on every device.
 *
 * The store still holds the doc of the launch before the one with no store.
 * The launch with no store writes its edits to the vault file, and for a
 * synced note pushes them as Yjs updates. The next launch with the store
 * loads the older stored doc, and must neither show it over the file nor
 * take the file in beside the pushed updates, which would show the text
 * twice once both merge.
 *
 * One device and one profile per test, four launches:
 *  a. with the store: write a note, quit with it open.
 *  b. with no store (MEMRY_TEST_CRDT_PREFLIGHT_CRASH=1, never retried) and the
 *     tab restored: type a line, quit.
 *  c. with the store and the tab restored, no forced pull: the editor and the
 *     file hold the line once.
 *  d. a fresh doc of the note: with sync, a launch with no store, whose doc
 *     opens empty and merges the server's state; with none, a launch with the
 *     store, whose doc is the one c stored.
 *
 * Main-process docs are read through the NODE_ENV=test `__memryDebug` handle;
 * the relaunches reuse the first process's spawn arguments, as
 * restored-tab-in-memory-keeps-note-body.e2e.ts does.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { test, expect, bootstrapSyncDevice } from './fixtures/sync-auth-fixtures'
import { ensureDayPanelClosed, SELECTORS, waitForAppReady } from './utils/electron-helpers'
import { ready } from './utils/desktop-test-helpers'
import { destroyElectronApp, launchElectronWithWindow } from './utils/electron-lifecycle'
import { appendToNoteBody, createNoteWithBody } from './utils/note-sync-helpers'
import type { SharedSyncBootstrap } from './utils/sync-backend'
import {
  goOffline,
  syncAndWait,
  waitForCrdtQueueIdle,
  waitForSyncIdle,
  waitForSyncOffline,
  waitForSyncOnline
} from './utils/network-control'

const BODY = 'Written while the store was healthy, before the launch that had none.'
const TYPED = 'typed in the launch with no store'

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1

interface MainDoc {
  persisted: boolean
  /** The body fragment, every root included, as Yjs prints it. */
  fragment: string | null
}

async function mainDoc(app: ElectronApplication, noteId: string): Promise<MainDoc> {
  return app.evaluate((_electron, id) => {
    interface Provider {
      hasPersistence(): boolean
      getDoc(noteId: string): { getXmlFragment(name: string): { toString(): string } } | undefined
    }
    const debug = (globalThis as unknown as { __memryDebug?: { crdt(): Provider } }).__memryDebug
    if (!debug) throw new Error('__memryDebug is not registered')
    const doc = debug.crdt().getDoc(id)
    return {
      persisted: debug.crdt().hasPersistence(),
      fragment: doc ? doc.getXmlFragment('prosemirror').toString() : null
    }
  }, noteId)
}

/** Push every open doc's pending snapshot, as the snapshot scheduler does. */
async function pushSnapshots(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => {
    const debug = (
      globalThis as unknown as {
        __memryDebug?: { crdt(): { pushAllSnapshots(): Promise<number> } }
      }
    ).__memryDebug
    if (!debug) throw new Error('__memryDebug is not registered')
    return debug.crdt().pushAllSnapshots()
  })
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

/** Quit through the app's shutdown, so its write-backs and final pushes run. */
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

type Variant = { sync: false } | { sync: true; offlineWithoutStore: boolean }

async function run(variant: Variant, syncBootstrap: SharedSyncBootstrap | null): Promise<void> {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-e2e-in-memory-edits-'))
  for (const dir of ['.memry', 'notes', 'journal']) {
    fs.mkdirSync(path.join(vaultPath, dir), { recursive: true })
  }
  const deviceId = `e2e-${crypto.randomUUID()}-A`
  const serverUrl = syncBootstrap?.serverUrl

  // a. with the store
  const first = await launchElectronWithWindow({
    testVaultPath: vaultPath,
    deviceId,
    ...(serverUrl ? { syncServerUrl: serverUrl } : {})
  })
  const spawned = first.app.process()
  const userDataDirs = [first.userDataDir, first.resolvedUserDataDir]
  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: 'test',
    TEST_VAULT_PATH: vaultPath,
    MEMRY_DEVICE: deviceId,
    ...(serverUrl ? { SYNC_SERVER_URL: serverUrl } : {})
  }
  delete env.ELECTRON_RUN_AS_NODE

  const relaunched: ElectronApplication[] = []
  try {
    if (syncBootstrap) {
      await bootstrapSyncDevice(first.app, syncBootstrap.deviceA)
      await first.page.reload()
      await first.page.waitForLoadState('domcontentloaded')
    }
    await waitForAppReady(first.page)
    await ready(first.page)
    await ensureDayPanelClosed(first.page)
    if (syncBootstrap) await waitForSyncOnline(first.page, 30_000)

    const note = await createNoteWithBody(first.page, `In Memory Edits ${Date.now()}`, BODY)
    const relPath = await first.page.evaluate(
      async (id) => (await window.api.notes.get(id))?.path ?? null,
      note.id
    )
    if (!relPath) throw new Error('note has no path')
    const file = (): string => fs.readFileSync(path.join(vaultPath, relPath), 'utf8')
    await expect.poll(file).toContain(BODY)
    if (syncBootstrap) {
      await waitForCrdtQueueIdle(first.app, 30_000)
      await syncAndWait(first.page, 30_000)
    }
    expect((await mainDoc(first.app, note.id)).persisted).toBe(true)
    await quitApp(first.app)

    const relaunch = async (
      label: string,
      extraEnv: Record<string, string>
    ): Promise<{ app: ElectronApplication; page: Page }> => {
      const app = await electron.launch({
        executablePath: spawned.spawnfile,
        args: spawned.spawnargs.slice(1),
        env: {
          ...env,
          MEMRY_TEST_LOG_DIR: path.join(first.userDataDir, `logs-${label}`),
          ...extraEnv
        }
      })
      relaunched.push(app)
      const page = await app.firstWindow({ timeout: 45_000 })
      await page.waitForLoadState('domcontentloaded')
      await expect(page.locator(SELECTORS.tab).filter({ hasText: note.title }).first()).toBeVisible(
        { timeout: 45_000 }
      )
      if (syncBootstrap) await waitForSyncOnline(page, 30_000)
      return { app, page }
    }

    // b. no store all session, tab restored
    const b = await relaunch('b', { MEMRY_TEST_CRDT_PREFLIGHT_CRASH: '1' })
    await expect.poll(() => editorText(b.page), { timeout: 60_000 }).toContain(BODY)
    expect((await mainDoc(b.app, note.id)).persisted).toBe(false)
    if (variant.sync && variant.offlineWithoutStore) {
      await goOffline(b.app)
      await waitForSyncOffline(b.page, 30_000)
    }
    await appendToNoteBody(b.page, TYPED)
    await expect.poll(file, { timeout: 30_000 }).toContain(TYPED)
    if (variant.sync && !variant.offlineWithoutStore) {
      await waitForCrdtQueueIdle(b.app, 60_000)
      // The snapshot the scheduler pushes in a longer session, and a later
      // pull past it: the next launch's change feed then holds nothing of b.
      expect(await pushSnapshots(b.app)).toBe(1)
      await syncAndWait(b.page, 60_000)
    }
    expect((await mainDoc(b.app, note.id)).persisted).toBe(false)
    await quitApp(b.app)

    // c. the store again, tab restored, no forced pull
    const c = await relaunch('c', {})
    if (syncBootstrap) {
      await waitForSyncIdle(c.page, 60_000)
      await waitForCrdtQueueIdle(c.app, 60_000)
    }
    await expect.poll(() => editorText(c.page), { timeout: 60_000 }).toContain(TYPED)
    if (syncBootstrap) {
      await syncAndWait(c.page, 60_000)
      await waitForCrdtQueueIdle(c.app, 60_000)
    }
    const shown = await editorText(c.page)
    expect(occurrences(shown, TYPED)).toBe(1)
    expect(occurrences(shown, BODY)).toBe(1)
    const stored = await mainDoc(c.app, note.id)
    expect(stored.persisted).toBe(true)
    expect(occurrences(stored.fragment ?? '', TYPED)).toBe(1)
    await expect.poll(() => occurrences(file(), TYPED), { timeout: 30_000 }).toBe(1)
    expect(occurrences(file(), BODY)).toBe(1)
    await quitApp(c.app)

    // d. a fresh doc: merged from the server, or read back from the store
    const d = await relaunch('d', syncBootstrap ? { MEMRY_TEST_CRDT_PREFLIGHT_CRASH: '1' } : {})
    await expect.poll(() => editorText(d.page), { timeout: 60_000 }).toContain(TYPED)
    if (syncBootstrap) {
      await waitForSyncIdle(d.page, 60_000)
      await waitForCrdtQueueIdle(d.app, 60_000)
    }
    const fresh = await mainDoc(d.app, note.id)
    expect(fresh.persisted).toBe(!syncBootstrap)
    expect(occurrences(fresh.fragment ?? '', TYPED)).toBe(1)
    expect(occurrences(fresh.fragment ?? '', BODY)).toBe(1)
    expect(occurrences(await editorText(d.page), TYPED)).toBe(1)
    expect(occurrences(file(), TYPED)).toBe(1)
  } finally {
    for (const app of relaunched) await quitApp(app).catch(() => {})
    await destroyElectronApp(first.app, userDataDirs, deviceId).catch(() => {})
    fs.rmSync(vaultPath, { recursive: true, force: true })
  }
}

test.describe('edits of a launch with no CRDT store survive the next launch with it', () => {
  test.setTimeout(480_000)

  test('a synced note, online again', async ({ syncBootstrap }) => {
    await run({ sync: true, offlineWithoutStore: false }, syncBootstrap)
  })

  test('a synced note whose edits never left the launch with no store', async ({
    syncBootstrap
  }) => {
    await run({ sync: true, offlineWithoutStore: true }, syncBootstrap)
  })

  test('an install that does not sync', async () => {
    await run({ sync: false }, null)
  })
})
