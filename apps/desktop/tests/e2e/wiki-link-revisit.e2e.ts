/**
 * Wiki links on a note that is revisited, or changed from outside while open.
 *
 * Main builds a note's Y.Doc from markdown with `[[X]]` as plain TEXT; only the
 * renderer turns it into a chip. Two ways that text reaches the editor:
 *
 * - On open. Where the CRDT store is unavailable (most Windows installs, #1583)
 *   every revisit rebuilds the doc from the file, so this runs every time.
 * - As a remote update to an editor that is already open: an external file
 *   edit fed into the doc, or a sync pull. y-prosemirror renders that inside
 *   its binding mutex, and a promotion written from BlockNote's `onChange` in
 *   that render reached ProseMirror but not the Y.Doc. The next Y change then
 *   re-rendered the paragraph from the doc and the user read `[[a]] [[b]]`
 *   until they clicked into it.
 *
 * Each case launches its own app so the CRDT store state is controlled:
 * `store` uses whatever this machine gives it; `no-store` forces the preflight
 * failure that Windows installs hit.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import {
  destroyElectronApp,
  launchElectronWithWindow,
  type LaunchedElectron
} from './utils/electron-lifecycle'
import { ready, uniqueLabel } from './utils/desktop-test-helpers'
import { openNoteByTitle } from './utils/note-sync-helpers'
import { SELECTORS } from './utils/electron-helpers'

type StoreMode = 'store' | 'no-store'

interface App {
  launched: LaunchedElectron
  page: Page
  vaultPath: string
}

async function launch(mode: StoreMode): Promise<App> {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-e2e-revisit-'))
  for (const dir of ['.memry', 'notes', 'journal']) {
    fs.mkdirSync(path.join(vaultPath, dir), { recursive: true })
  }
  const launched = await launchElectronWithWindow({
    testVaultPath: vaultPath,
    extraEnv: mode === 'no-store' ? { MEMRY_TEST_CRDT_PREFLIGHT_CRASH: '1' } : {}
  })
  await ready(launched.page)

  // Printed so a CI log says which path this run actually exercised.
  const health = await launched.page.evaluate(() => window.api.syncCrdt.getHealth())
  console.log(`[wiki-link-revisit] mode=${mode} platform=${process.platform}`, health)
  return { launched, page: launched.page, vaultPath }
}

async function close(app: App): Promise<void> {
  await destroyElectronApp(app.launched.app, [
    app.launched.userDataDir,
    app.launched.resolvedUserDataDir
  ])
  fs.rmSync(app.vaultPath, { recursive: true, force: true })
}

async function createNotes(page: Page, notes: Array<{ title: string; content: string }>) {
  await page.evaluate(async (notes) => {
    for (const note of notes) {
      const created = await window.api.notes.create(note)
      if (!created.success) throw new Error(`failed to seed "${note.title}"`)
    }
  }, notes)
}

function noteFile(vaultPath: string, title: string): string {
  const stack = [vaultPath]
  while (stack.length) {
    const dir = stack.pop() as string
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== '.memry') stack.push(full)
      } else if (entry.name === `${title}.md`) {
        return full
      }
    }
  }
  throw new Error(`no vault file for "${title}"`)
}

/** What the reader sees: chips rendered, and any `[[` left as text. */
async function editorState(page: Page): Promise<{ chips: number; rawBrackets: boolean }> {
  const editor = page.locator(SELECTORS.noteEditor).first()
  return {
    chips: await page.locator('[data-wiki-link]:visible').count(),
    rawBrackets: (await editor.innerText()).includes('[[')
  }
}

async function open(page: Page, title: string): Promise<void> {
  await openNoteByTitle(page, title)
  await page.locator(SELECTORS.noteEditor).first().waitFor({ state: 'visible', timeout: 15_000 })
}

for (const mode of ['store', 'no-store'] as const) {
  test.describe(`wiki links on revisit (${mode})`, () => {
    test('a note left and reopened still shows its links as chips', async () => {
      const app = await launch(mode)
      try {
        const [a, b, src, other] = ['Alpha', 'Beta', 'Revisit', 'Elsewhere'].map(uniqueLabel)
        await createNotes(app.page, [
          { title: a, content: 'A.\n' },
          { title: b, content: 'B.\n' },
          { title: other, content: 'Somewhere else.\n' },
          { title: src, content: `[[${a}]] [[${b}]]\n\nMore text [[${a}]] here.\n` }
        ])

        for (let round = 0; round < 4; round++) {
          await open(app.page, src)
          await expect
            .poll(() => editorState(app.page), { message: `round ${round}` })
            .toEqual({ chips: 3, rawBrackets: false })
          // Stay long enough for write-back and any follow-up update to land.
          await app.page.waitForTimeout(1500)
          expect(await editorState(app.page), `round ${round}, settled`).toEqual({
            chips: 3,
            rawBrackets: false
          })
          await open(app.page, other)
        }
      } finally {
        await close(app)
      }
    })

    test('links written into the file while the note is open become chips and stay chips', async () => {
      const app = await launch(mode)
      try {
        const [target, src] = ['Target', 'Open Edit'].map(uniqueLabel)
        await createNotes(app.page, [
          { title: target, content: 'A target.\n' },
          { title: src, content: 'Nothing linked yet.\n' }
        ])
        await open(app.page, src)
        await expect.poll(() => editorState(app.page)).toEqual({ chips: 0, rawBrackets: false })

        // #when another app adds links to the file while it is open here
        const file = noteFile(app.vaultPath, src)
        const base = fs.readFileSync(file, 'utf8').trimEnd()
        fs.writeFileSync(file, `${base}\n\n[[${target}]] [[${target}]]\n`, 'utf8')

        await expect
          .poll(() => editorState(app.page), { timeout: 30_000 })
          .toEqual({ chips: 2, rawBrackets: false })

        // #and a later, unrelated change arrives the same way
        fs.writeFileSync(
          file,
          `${fs.readFileSync(file, 'utf8').trimEnd()}\n\nAn unrelated line.\n`,
          'utf8'
        )
        await expect
          .poll(async () => await app.page.locator(SELECTORS.noteEditor).first().innerText())
          .toContain('An unrelated line.')

        // #then the links are still chips
        await app.page.waitForTimeout(1000)
        expect(await editorState(app.page)).toEqual({ chips: 2, rawBrackets: false })
      } finally {
        await close(app)
      }
    })
  })
}
