// Links in a note opened and never typed into are chips a user can click (#1642), ported from
// Electron's `wiki-link-open-promotion.e2e.ts` (Step 14k, #3531). Nothing here types into the
// editor before asserting: a keystroke would promote the links through the change handler and
// the assertions would say nothing about the open path.
//
// Two of Electron's main-process probes have no Tauri command yet, so those steps read the same
// outcome another way:
// - Electron waits for the write-back counter. Here the spec schedules a write-back pass of the
//   promoted note and quits; the quit runs every scheduled pass, so once the app is gone the
//   file holds whatever the promoted document serializes to.
// - Electron waits for main to unload the note's document before the outside edit. The Tauri
//   host unloads a released document on its sweep, and no command reports that, so the outside
//   edit may reach a document still in memory. The reopen assertion is the same.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { noteBody } from '../../harness/editor'
import { invokeTest } from '../../harness/invoke-test'
import { openNoteByTitle } from '../../harness/note-sync-helpers'
import { createNote, NOTE_EDITOR, NOTE_TITLE, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { gracefulClose } from '../../harness/tauri-lifecycle'
import { test, expect } from '../../harness/test'
import { sleep } from '../../harness/wait'

const unique = (label: string): string => `${label} ${Math.random().toString(36).slice(2, 8)}`

interface SeededLinkNote {
  id: string
  path: string
  sourceTitle: string
  targets: string[]
  /** The body as `notes_get` reads it before the note is opened, the baseline of "unchanged". */
  body: string
}

/** A page that is a list of links, the shape the report describes. */
async function seedLinkList(page: Page): Promise<SeededLinkNote> {
  const targets = [unique('Alpha'), unique('Beta'), unique('Gamma')]
  const sourceTitle = unique('Reading List')
  for (const title of targets) await createNote(page, { title, content: 'A target.\n' })
  const content = ['Everything to read:', '', ...targets.map((t) => `- [[${t}]]`), ''].join('\n')
  const source = await createNote(page, { title: sourceTitle, content })
  const body = await noteBody(page, source.id)
  if (!body?.includes('[[')) throw new Error(`seeded note does not hold raw wiki links: ${body}`)
  return { id: source.id, path: source.path, sourceTitle, targets, body }
}

async function openWithoutTyping(page: Page, title: string): Promise<void> {
  await openNoteByTitle(page, title)
  await page.locator(NOTE_EDITOR).first().waitFor({ state: 'visible', timeout: 15_000 })
}

const chipFor = (page: Page, target: string) =>
  page.locator(`[data-wiki-link][data-target="${target}"]`)

test.describe('Wiki links on open', () => {
  test('a note opened and never typed into shows its links as chips', async ({
    page,
    app,
    testVaultPath
  }) => {
    await vaultOpen(page)
    const { id, path, sourceTitle, targets } = await seedLinkList(page)
    const file = join(testVaultPath, path)
    const before = readFileSync(file, 'utf8')

    await openWithoutTyping(page, sourceTitle)

    await expect(page.locator('[data-wiki-link]')).toHaveCount(targets.length)
    for (const target of targets) await expect(chipFor(page, target)).toBeVisible()

    // A wikiLink node serializes back to the `[[…]]` bytes it was parsed from (#1434): a pass
    // over the promoted note writes nothing new.
    await invokeTest(app, 'e2e_note_schedule', { noteIds: [id] })
    await gracefulClose(app)
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  test('the chip is clickable, it opens the note it points at', async ({ page }) => {
    await vaultOpen(page)
    const { sourceTitle, targets } = await seedLinkList(page)
    await openWithoutTyping(page, sourceTitle)

    await chipFor(page, targets[1]).click()

    await expect(page.locator(NOTE_TITLE).first()).toHaveValue(targets[1])
  })

  // The regression 52c6cd07f shipped: a person holds the button for 80-150 ms, and in that
  // window the caret syncs beside the chip and the edit plugin paints the raw `[[Target]]` in
  // its place. The editor is read while the button is still down, then released, then asserted,
  // so a failure does not leave the button held.
  test('a click held like a human click still follows the link', async ({ page }) => {
    await vaultOpen(page)
    const { sourceTitle, targets } = await seedLinkList(page)
    await openWithoutTyping(page, sourceTitle)

    const chip = chipFor(page, targets[1])
    await expect(chip).toBeVisible()

    await chip.hover()
    await page.mouse.down()
    await sleep(150)

    const heldText = await page.locator(NOTE_EDITOR).first().innerText()
    const paintedRuns = await page.locator('[data-wiki-link-source]').count()
    const chipStillRendered = await chip.isVisible()

    await page.mouse.up()

    expect(paintedRuns).toBe(0)
    expect(heldText).not.toContain('[[')
    expect(chipStillRendered).toBe(true)
    await expect(page.locator(NOTE_TITLE).first()).toHaveValue(targets[1])
  })

  // An edit made outside Memry reaches the note's document with no editor mounted, so the
  // editor is created over text that is already there and gets no change event to promote from.
  test('links written into the file from outside are chips when the note is reopened', async ({
    page,
    testVaultPath
  }) => {
    await vaultOpen(page)
    const title = unique('External Edit')
    const target = unique('External Target')
    const note = await createNote(page, { title, content: 'Nothing here yet.\n' })
    await createNote(page, { title: target, content: 'A target.\n' })
    await openWithoutTyping(page, title)
    await expect(page.locator('[data-wiki-link]')).toHaveCount(0)

    // Switch away so no editor is bound to the note while it changes on disk.
    await openWithoutTyping(page, target)

    const file = join(testVaultPath, note.path)
    const before = readFileSync(file, 'utf8')
    writeFileSync(file, `${before.trimEnd()}\n\n- [[${target}]]\n`, 'utf8')
    await expect.poll(() => noteBody(page, note.id), { timeout: 30_000 }).toContain(`[[${target}]]`)

    await openWithoutTyping(page, title)

    // Both ends in one read, so a failure names the one that gave way: the file is what the other
    // program wrote, the chip is what the editor made of the document. The document itself has no
    // markdown probe yet (`e2e_crdt_doc_markdown`); `e2e_note_body` reads run text only, and a
    // promoted wikiLink node carries its target outside the text.
    await expect
      .poll(
        async () => ({
          file: (await noteBody(page, note.id))?.includes(`[[${target}]]`) ?? false,
          chips: await chipFor(page, target).count()
        }),
        { timeout: 60_000 }
      )
      .toEqual({ file: true, chips: 1 })
  })

  test('the chips survive a reload, and the second open rewrites nothing', async ({ page }) => {
    await vaultOpen(page)
    const { id, sourceTitle, targets, body } = await seedLinkList(page)
    await openWithoutTyping(page, sourceTitle)
    await expect(page.locator('[data-wiki-link]')).toHaveCount(targets.length)

    await page.reload()
    await vaultOpen(page)
    await openWithoutTyping(page, sourceTitle)

    await expect(page.locator('[data-wiki-link]')).toHaveCount(targets.length)
    expect(await noteBody(page, id)).toBe(body)
  })
})
