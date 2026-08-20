/**
 * #1642 — "I'll open a page with a list of links and they will all be plain
 * text and not highlighted and can't click on them."
 *
 * The renderer is the only thing that turns `[[X]]` into a chip: main parses a
 * vault file into the shared Y.Doc with a `wikiLink` spec that has no `parse`
 * rule, so the link reaches the doc as plain TEXT. Until this fix the only
 * promoter was `handleChange`, which fires on an EDIT — so a note read and not
 * typed into stayed plain text, and "close and reopen a few times" only helped
 * when the reopen happened to lose the race to the CRDT doc and fell to the
 * markdown load path instead.
 *
 * This is E2E rather than a renderer test because the claim is about the whole
 * chain — a real vault file, main's parser, the CRDT store, a real editor bound
 * to the shared doc — and about a chip a user can actually click. The unit
 * sibling (`src/renderer/.../wiki-link-collab-promotion.test.ts`) drives the
 * same promotion against a real `Y.Doc`, including the two-device case; what it
 * cannot do is prove that main really hands the renderer raw text in the first
 * place, which is the premise the whole bug rests on.
 *
 * Nothing here types into the editor before asserting. A keystroke would
 * trigger `handleChange` and the assertions would say nothing.
 *
 * ## What this suite does and does not prove
 *
 * It passes on the build BEFORE #1642 as well, and that is worth stating rather
 * than discovering later. `handleChange` promotes from a change event, and on
 * every path reachable from a single machine — first open, an edit made to the
 * file from outside, a restart with the tab restored — an event does arrive:
 * y-prosemirror dispatches one when the shared content reaches the editor. The
 * failure the report describes is that event not arriving, which is a race, not
 * a path. So what these tests pin is the OUTCOME a reader cares about — links
 * are chips, and clicking one goes somewhere — on a surface that had no E2E
 * coverage at all. The discriminating tests for the open-path promotion itself
 * are in the renderer suite (`wiki-link-collab-promotion.test.ts`), where
 * mounting the hook is the whole act and no change event exists to lean on.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { ready, uniqueLabel } from './utils/desktop-test-helpers'
import {
  getNoteFileBodyByTitle,
  getNoteHandleByTitle,
  getWritebackDebugById,
  openNoteByTitle
} from './utils/note-sync-helpers'
import { SELECTORS } from './utils/electron-helpers'

interface SeededLinkNote {
  sourceTitle: string
  targets: string[]
  /**
   * The body as it sits in the vault BEFORE the note is opened.
   *
   * Read back rather than assumed: what `notes.create` writes is the baseline
   * this suite measures "did opening it change anything" against, and pinning a
   * hand-written string here would turn any unrelated formatting choice into a
   * failure of the wiki-link path.
   */
  body: string
}

/** A page that is a list of links — the exact shape the report describes. */
async function seedLinkList(page: Page): Promise<SeededLinkNote> {
  const targets = [uniqueLabel('Alpha'), uniqueLabel('Beta'), uniqueLabel('Gamma')]
  const sourceTitle = uniqueLabel('Reading List')
  const body = ['Everything to read:', '', ...targets.map((t) => `- [[${t}]]`), ''].join('\n')

  await page.evaluate(
    async ({ sourceTitle, targets, body }) => {
      for (const title of targets) {
        const created = await window.api.notes.create({ title, content: 'A target.\n' })
        if (!created.success) throw new Error(`failed to seed target "${title}"`)
      }
      const source = await window.api.notes.create({ title: sourceTitle, content: body })
      if (!source.success) throw new Error('failed to seed the link list')
    },
    { sourceTitle, targets, body }
  )

  const stored = await getNoteFileBodyByTitle(page, sourceTitle)
  if (!stored?.includes('[[')) {
    throw new Error(`seeded note does not hold raw wiki links: ${stored}`)
  }

  return { sourceTitle, targets, body: stored }
}

/** The vault file backing a note, found by name rather than assumed. */
function noteFilePath(vaultPath: string, title: string): string {
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

/** How many times CRDT write-back has run for this note so far. */
async function writebackRuns(
  electronApp: ElectronApplication,
  page: Page,
  title: string
): Promise<number> {
  const note = await getNoteHandleByTitle(page, title)
  return (await getWritebackDebugById(electronApp, note.id))?.performedCount ?? 0
}

async function openWithoutTyping(page: Page, title: string): Promise<void> {
  await openNoteByTitle(page, title)
  await page.locator(SELECTORS.noteEditor).first().waitFor({ state: 'visible', timeout: 15_000 })
}

test.describe('Wiki links on open', () => {
  test('a note opened and never typed into shows its links as chips', async ({
    page,
    electronApp
  }) => {
    await ready(page)

    // #given a note whose body is nothing but `[[…]]` links, written to the
    // vault and never opened — so its Y.Doc gets built from those bytes
    const { sourceTitle, targets, body } = await seedLinkList(page)

    // #when it is opened, and that is all that happens
    await openWithoutTyping(page, sourceTitle)

    // #then every link is a chip, not plain text
    const chips = page.locator('[data-wiki-link]')
    await expect(chips).toHaveCount(targets.length)
    for (const target of targets) {
      await expect(page.locator(`[data-wiki-link][data-target="${target}"]`)).toBeVisible()
    }

    // …and once the promotion has genuinely reached disk — write-back runs off
    // a CRDT doc update, so this only settles because the promotion happened —
    // the body is unchanged: a `wikiLink` node serializes back to the same
    // `[[…]]` bytes it was parsed from (#1434)
    await expect
      .poll(() => writebackRuns(electronApp, page, sourceTitle), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(1)
    expect(await getNoteFileBodyByTitle(page, sourceTitle)).toBe(body)
  })

  test('the chip is clickable — it opens the note it points at', async ({ page }) => {
    await ready(page)

    // #given
    const { sourceTitle, targets } = await seedLinkList(page)
    await openWithoutTyping(page, sourceTitle)

    // #when the user clicks the link they came to follow. "Can't click on them"
    // is the half of the report a chip-count assertion does not cover: plain
    // text renders fine and simply does nothing when clicked.
    await page.locator(`[data-wiki-link][data-target="${targets[1]}"]`).click()

    // #then
    await expect(page.locator(SELECTORS.noteTitle).first()).toHaveValue(targets[1])
  })

  /**
   * The case the report is actually made of, and the one `handleChange` cannot
   * reach. `handleChange` promotes on a change EVENT, and it gets one on a
   * first open only because the content arrives after the editor is listening.
   * When the shared doc already holds the text at editor-creation time there is
   * no event at all — and that is exactly the state an edit made outside Memry
   * leaves behind: main feeds the file into the Y.Doc (`feedExternalEditToCrdt`)
   * with no editor mounted, and its `wikiLink` spec has no `parse` rule, so what
   * lands is raw `[[X]]` text. Another device pushing a note is the same shape.
   */
  test('links written into the file from outside are chips when the note is reopened', async ({
    page,
    testVaultPath
  }) => {
    await ready(page)

    // #given a note already known to the app, opened once and then left
    const title = uniqueLabel('External Edit')
    const target = uniqueLabel('External Target')
    await page.evaluate(
      async ({ title, target }) => {
        const seeded = await window.api.notes.create({ title, content: 'Nothing here yet.\n' })
        const linked = await window.api.notes.create({ title: target, content: 'A target.\n' })
        if (!seeded.success || !linked.success) throw new Error('failed to seed the external case')
      },
      { title, target }
    )
    await openWithoutTyping(page, title)
    await expect(page.locator('[data-wiki-link]')).toHaveCount(0)

    // switch away so no editor is bound to the note while it changes on disk
    await openWithoutTyping(page, target)

    // #when the file grows a link behind the app's back — Obsidian, a script,
    // a sync client, anything that is not this editor
    const absPath = noteFilePath(testVaultPath, title)
    const before = fs.readFileSync(absPath, 'utf8')
    fs.writeFileSync(absPath, `${before.trimEnd()}\n\n- [[${target}]]\n`, 'utf8')
    await expect
      .poll(() => getNoteFileBodyByTitle(page, title), { timeout: 30_000 })
      .toContain(`[[${target}]]`)

    // …and the note is opened again, still without a keystroke
    await openWithoutTyping(page, title)

    // #then the link is a chip. Before #1642 it was plain text here, and stayed
    // plain until the user typed into the note — which is the whole report.
    await expect(page.locator(`[data-wiki-link][data-target="${target}"]`)).toBeVisible()
  })

  test('the chips survive a reload, and the second open rewrites nothing', async ({ page }) => {
    await ready(page)

    // #given a note opened once, so the promotion has already run and reached
    // the CRDT store
    const { sourceTitle, targets, body } = await seedLinkList(page)
    await openWithoutTyping(page, sourceTitle)
    await expect(page.locator('[data-wiki-link]')).toHaveCount(targets.length)

    // #when the app restarts and the note is opened cold, with the shared doc
    // rebuilt from the store rather than from markdown
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await ready(page)
    await openWithoutTyping(page, sourceTitle)

    // #then the chips are there because the doc already holds the nodes —
    // nothing to promote, so nothing is written and the file still matches
    await expect(page.locator('[data-wiki-link]')).toHaveCount(targets.length)
    expect(await getNoteFileBodyByTitle(page, sourceTitle)).toBe(body)
  })
})
