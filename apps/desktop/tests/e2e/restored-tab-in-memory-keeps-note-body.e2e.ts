/**
 * A note open as a tab when the app quits comes back with its body after a
 * launch whose CRDT store failed, and after the next launch with the store.
 *
 * The launch with no store restores the tab before the sync runtime wires
 * its merge. The editor open used to seed the doc from the file then, so the
 * server body arrived as a second root and one of the two was deleted, which
 * lost typing or emptied the note on the next launch with the store.
 *
 * One device and one profile, three launches:
 *  a. with the store: write a note with a comment, sync it, quit with it open.
 *  b. with no store (MEMRY_TEST_CRDT_PREFLIGHT_CRASH=1) and the tab restored:
 *     the doc holds only the root a wrote; type a line, quit.
 *  c. with the store and the tab restored: pull the whole body, the way a
 *     launch catches up on what b sent.
 *
 * The root a wrote is read through the NODE_ENV=test `__memryDebug` handle;
 * the relaunches reuse the first process's spawn arguments, as
 * sidebar-open-state.e2e.ts does.
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
import {
  syncAndWait,
  waitForCrdtQueueIdle,
  waitForSyncIdle,
  waitForSyncOnline
} from './utils/network-control'

const EDITOR_SELECTOR =
  '[aria-label="Rich text editor"] [contenteditable="true"], .bn-editor[contenteditable="true"], .bn-editor'
const COMMENT_TARGET = 'review anchor phrase'
const COMMENT_BODY = 'Check this claim before shipping.'
const TYPED = 'typed while the store was missing'
const VOCAB =
  'ledger harbor signal orbit canvas meadow copper lantern quartz river summit thistle violet window yarrow zephyr bramble cinder delta ember'.split(
    ' '
  )
const BODY_WORDS = 300

/** Six paragraphs of about 55 words, one holding the comment target. */
function buildBody(): string {
  const paragraphs: string[] = []
  for (let i = 0; i < 6; i++) {
    const words = Array.from(
      { length: 55 },
      (_, k) => VOCAB[(i * 7 + k * 3 + k * k) % VOCAB.length]
    )
    if (i === 2) words.splice(20, 0, COMMENT_TARGET)
    paragraphs.push(`Paragraph ${i + 1} ${words.join(' ')}.`)
  }
  return paragraphs.join('\n')
}

function countWords(text: string): number {
  return (text.match(/\S+/g) ?? []).length
}

interface RootItem {
  id: string
  deleted: boolean
}

interface MainDoc {
  persisted: boolean
  /** Every root item of the body fragment, deleted ones included. */
  roots: RootItem[] | null
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
    const roots: RootItem[] = []
    for (let item = doc?.getXmlFragment('prosemirror')._start ?? null; item; item = item.right) {
      roots.push({ id: `${item.id.client}:${item.id.clock}`, deleted: item.deleted })
    }
    return { persisted: debug.crdt().hasPersistence(), roots: doc ? roots : null }
  }, noteId)
}

/** Owe the note a whole-body pull, the debt a launch pays on its next sync. */
async function oweBodyPull(app: ElectronApplication, noteId: string): Promise<void> {
  const owed = await app.evaluate((_electron, id) => {
    const engine = (
      globalThis as unknown as {
        __memryDebug?: { syncEngine(): { oweCrdtPull(n: string, r: string): boolean } | null }
      }
    ).__memryDebug?.syncEngine()
    if (!engine) throw new Error('no sync engine')
    return engine.oweCrdtPull(id, 'compaction')
  }, noteId)
  expect(owed).toBe(true)
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

function fileBody(vaultPath: string, relPath: string): { words: number; raw: string } {
  const raw = fs.readFileSync(path.join(vaultPath, relPath), 'utf8')
  const body = raw
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/\{>>[\s\S]*?<<\}/g, '')
    .replace(/\{==|==\}/g, '')
  return { words: countWords(body), raw }
}

function orphanedComments(logDir: string): string[] {
  const log = fs.readFileSync(path.join(logDir, 'main.log'), 'utf8')
  return log.split('\n').filter((line) => line.includes('Comments whose text was deleted'))
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

async function addComment(page: Page): Promise<void> {
  await page.locator(EDITOR_SELECTOR).first().click()
  const selected = await page.evaluate(
    ({ selector, text }) => {
      const root = document.querySelector(selector)
      if (!root) return false
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let node: Node | null
      while ((node = walker.nextNode())) {
        const index = (node.textContent ?? '').indexOf(text)
        if (index === -1) continue
        if (root instanceof HTMLElement) root.focus()
        const range = document.createRange()
        range.setStart(node, index)
        range.setEnd(node, index + text.length)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        root.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
        root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        document.dispatchEvent(new Event('selectionchange', { bubbles: true }))
        return true
      }
      return false
    },
    { selector: EDITOR_SELECTOR, text: COMMENT_TARGET }
  )
  expect(selected).toBe(true)
  await page.locator('[data-test="review-comment"]').last().click()
  const draft = page.locator('.critic-comment-composer').first()
  await draft.getByLabel('Add a comment...').fill(COMMENT_BODY)
  await draft.getByLabel('Send comment').click()
  await expect(page.getByRole('complementary', { name: 'Comments', exact: true })).toContainText(
    COMMENT_BODY
  )
}

test('a tab restored into a launch with no CRDT store keeps the note body', async ({
  syncBootstrap
}) => {
  test.setTimeout(420_000)
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-e2e-restored-tab-in-memory-'))
  for (const dir of ['.memry', 'notes', 'journal']) {
    fs.mkdirSync(path.join(vaultPath, dir), { recursive: true })
  }
  const deviceId = `e2e-${crypto.randomUUID()}-A`

  // a. with the store
  const first = await launchElectronWithWindow({
    testVaultPath: vaultPath,
    deviceId,
    syncServerUrl: syncBootstrap.serverUrl
  })
  const spawned = first.app.process()
  const userDataDirs = [first.userDataDir, first.resolvedUserDataDir]
  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: 'test',
    TEST_VAULT_PATH: vaultPath,
    MEMRY_DEVICE: deviceId,
    SYNC_SERVER_URL: syncBootstrap.serverUrl
  }
  delete env.ELECTRON_RUN_AS_NODE

  const relaunched: ElectronApplication[] = []
  try {
    await bootstrapSyncDevice(first.app, syncBootstrap.deviceA)
    await first.page.reload()
    await first.page.waitForLoadState('domcontentloaded')
    await waitForAppReady(first.page)
    await ready(first.page)
    await ensureDayPanelClosed(first.page)
    await waitForSyncOnline(first.page, 30_000)

    const note = await createNoteWithBody(first.page, `Restored Tab ${Date.now()}`, buildBody())
    await addComment(first.page)
    const relPath = await first.page.evaluate(
      async (id) => (await window.api.notes.get(id))?.path ?? null,
      note.id
    )
    if (!relPath) throw new Error('note has no path')
    await expect.poll(() => fileBody(vaultPath, relPath).raw).toContain('{==')
    await waitForCrdtQueueIdle(first.app, 30_000)
    await syncAndWait(first.page, 30_000)
    const written = await mainDoc(first.app, note.id)
    expect(written.roots).toHaveLength(1)
    const [root] = written.roots ?? []
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
      await waitForSyncOnline(page, 30_000)
      return { app, page, logDir }
    }

    // b. no store, tab restored
    const b = await relaunch('b', { MEMRY_TEST_CRDT_PREFLIGHT_CRASH: '1' })
    await expect
      .poll(async () => countWords(await editorText(b.page)), { timeout: 60_000 })
      .toBeGreaterThan(BODY_WORDS)
    await waitForSyncIdle(b.page, 60_000)
    await waitForCrdtQueueIdle(b.app, 60_000)
    expect(await mainDoc(b.app, note.id)).toEqual({ persisted: false, roots: [root] })

    await appendToNoteBody(b.page, TYPED)
    await expect.poll(() => fileBody(vaultPath, relPath).raw, { timeout: 30_000 }).toContain(TYPED)
    await waitForCrdtQueueIdle(b.app, 60_000)
    await syncAndWait(b.page, 60_000)
    expect(await mainDoc(b.app, note.id)).toEqual({ persisted: false, roots: [root] })
    await quitApp(b.app)

    // c. with the store, tab restored, catching up on what b sent
    const c = await relaunch('c', {})
    await waitForSyncIdle(c.page, 60_000)
    await oweBodyPull(c.app, note.id)
    await syncAndWait(c.page, 60_000)
    await waitForCrdtQueueIdle(c.app, 60_000)
    await expect.poll(() => editorText(c.page), { timeout: 30_000 }).toContain(TYPED)

    expect(await mainDoc(c.app, note.id)).toEqual({ persisted: true, roots: [root] })
    expect(countWords(await editorText(c.page))).toBeGreaterThan(BODY_WORDS)
    const file = fileBody(vaultPath, relPath)
    expect(file.words).toBeGreaterThan(BODY_WORDS)
    expect(file.raw).toContain(TYPED)
    expect(file.raw).toContain(`{==${COMMENT_TARGET}==}{>>`)
    expect(orphanedComments(c.logDir)).toEqual([])
  } finally {
    for (const app of relaunched) await quitApp(app).catch(() => {})
    await destroyElectronApp(first.app, userDataDirs, deviceId).catch(() => {})
    fs.rmSync(vaultPath, { recursive: true, force: true })
  }
})
