/**
 * Opening a note turns each plain checkbox in it into a task. The line the
 * file keeps must be the line it had, plus `{task:<id>}`: a note that arrives
 * from another device is converted on open, and whatever the conversion drops
 * is dropped from the note on every device it syncs to.
 *
 * The note is seeded as bytes on disk, opened in the real editor, and the
 * `.md` read back with `fs`, for the reason `obsidian-tasks-import.e2e.ts`
 * gives: only `fs` reports the bytes the app actually wrote.
 */

import * as fs from 'fs'
import * as path from 'path'
import { test, expect } from './fixtures'
import { getNoteHandleByTitle, openNoteByTitle } from './utils/note-sync-helpers'
import { ready } from './utils/desktop-test-helpers'
import { SELECTORS } from './utils/electron-helpers'

const LINE = '- [ ] **Dune: Part Two** — bumped because [[Dune (2021)]] was so good'

test('converting a checkbox on open keeps its bold text and wiki link', async ({
  page,
  testVaultPath
}) => {
  await ready(page)

  const title = `Watchlist ${Date.now()}`
  const absPath = path.join(testVaultPath, 'notes', `${title}.md`)
  fs.mkdirSync(path.dirname(absPath), { recursive: true })
  fs.writeFileSync(absPath, `${LINE}\n`, 'utf8')
  await getNoteHandleByTitle(page, title)

  await openNoteByTitle(page, title)
  await page.locator(SELECTORS.noteEditor).first().waitFor({ state: 'visible', timeout: 15_000 })

  const stamped = (): string | undefined =>
    fs
      .readFileSync(absPath, 'utf8')
      .split('\n')
      .find((line) => line.includes('{task:'))
  await expect.poll(stamped, { timeout: 30_000 }).toBeTruthy()

  expect(stamped()?.replace(/ \{task:[^}]+\}$/, '')).toBe(LINE)
})
