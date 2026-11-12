// Opening and closing a note writes nothing to its file (#1434, #1454), ported from Electron's
// `note-open-byte-stability.e2e.ts` (Step 14z, #3531). The note is seeded as bytes on disk, not
// through the app, because the claim is about bytes the user (or Obsidian) wrote.
//
// Electron needed a signed-in sync pair to bind the editor to the shared document. The Tauri
// editor always edits the app's document, so these specs need no sync. Electron's probes differ:
// - Electron waited for the shared doc to be seeded and the write-back to go quiet. Here the
//   readiness is what the editor shows (the promoted wiki-link chips, the tagged text), and
//   `passOverDocument` runs one write-back pass over the open document and waits for it, so a byte
//   check cannot pass because nothing saved.
// - Electron slept 3 s after the cold reopen before it read the file. Here the reopened document
//   gets a pass of its own, and the bytes and mtime are read after it.
// - "Close" quits the app after the tab closes: the quit runs every scheduled pass, so the file
//   read after it holds whatever opening and closing the note did. Bytes and mtime unchanged is
//   the zero-write proof; `performedCount` alone is not, since it also counts a pass that found
//   the file already holding the body.
import * as fs from 'node:fs'

import { getNote, NOTE_EDITOR, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import {
  closeNoteTab,
  indexedBaseline,
  openInEditor,
  passOverDocument,
  readWithMtime,
  seedVaultFile,
  writebackDebug
} from '../../harness/seeded-note'
import { gracefulClose } from '../../harness/tauri-lifecycle'
import { test, expect } from '../../harness/test'

/** Everything the issue names, in one note. */
const BODY = [
  '# Weekly',
  '',
  'See [[Wiki Link]] and #hashtag on ((date:eyJhbmNob3JJZCI6ImExIn0)).',
  '',
  '- [[A]]',
  '- [[B]]',
  '',
  '> [!info]',
  '> Heads up'
].join('\n')

/** The same note with no inline hash tag, so nothing touches its frontmatter. */
const BODY_WITHOUT_HASH_TAG = BODY.replace(' and #hashtag', '')

/** The `[[…]]` links of BODY, which the editor promotes to chips on open. */
const WIKI_LINKS = 3

/** Drop the YAML frontmatter block, leaving the body this loop owns. */
function stripFrontmatter(markdown: string): string {
  const match = markdown.match(/^---\n[\s\S]*?\n---\n?/)
  return match ? markdown.slice(match[0].length) : markdown
}

/** Opens the note and waits until the editor has promoted its wiki links: the loop under test. */
async function openPromoted(page: Page, title: string): Promise<void> {
  await openInEditor(page, title)
  await expect(page.locator('[data-wiki-link]')).toHaveCount(WIKI_LINKS)
}

test.describe('Note open byte stability', () => {
  test('opening a seeded note leaves its body untouched', async ({ app, page, testVaultPath }) => {
    await vaultOpen(page)

    // #given a vault note written straight to disk
    const title = `Byte Stability ${Date.now()}`
    const absPath = seedVaultFile(testVaultPath, title, BODY)
    const baseline = await indexedBaseline(page, title, absPath)
    expect(baseline.bytes).toContain('[[Wiki Link]]')

    // #when it is opened in the real editor and the open document is saved
    await openPromoted(page, title)
    await passOverDocument(app, baseline.id)

    // #then the body is byte-identical: the wiki links the renderer promoted to nodes came back
    // as the same `[[…]]` text, in the same blocks, and the callout and date-mention token were
    // never parsed at all
    expect(stripFrontmatter(fs.readFileSync(absPath, 'utf8'))).toBe(
      stripFrontmatter(baseline.bytes)
    )
    expect((await writebackDebug(app, baseline.id))?.lastError ?? null).toBeNull()
  })

  test('opening and closing a note with no inline tag writes nothing, frontmatter included', async ({
    app,
    page,
    testVaultPath
  }) => {
    await vaultOpen(page)

    // #given
    const title = `Byte Stability Whole File ${Date.now()}`
    const absPath = seedVaultFile(testVaultPath, title, BODY_WITHOUT_HASH_TAG)
    const baseline = await indexedBaseline(page, title, absPath)

    // #when it is opened, saved, closed, and the app quits
    await openPromoted(page, title)
    await passOverDocument(app, baseline.id)
    expect(fs.readFileSync(absPath, 'utf8')).toBe(baseline.bytes)
    await closeNoteTab(page, title)
    await gracefulClose(app)

    // #then nothing about the file changed at all: same bytes, and never rewritten
    expect(readWithMtime(absPath)).toEqual({ bytes: baseline.bytes, mtimeMs: baseline.mtimeMs })
  })

  test('a second open -> write-back cycle produces the same bytes', async ({
    app,
    page,
    testVaultPath
  }) => {
    await vaultOpen(page)

    // #given a note that has already been opened once, so whatever the first open was going to
    // do to it has happened
    const title = `Byte Stability Twice ${Date.now()}`
    const absPath = seedVaultFile(testVaultPath, title, BODY)
    const first = await indexedBaseline(page, title, absPath)
    await openPromoted(page, title)
    await passOverDocument(app, first.id)
    await expect
      .poll(() => stripFrontmatter(fs.readFileSync(absPath, 'utf8')), { timeout: 20_000 })
      .toBe(stripFrontmatter(first.bytes))
    const afterFirstOpen = readWithMtime(absPath)

    // #when the page is reloaded and the note opened again: a cold open of the editor
    await page.reload()
    await vaultOpen(page)
    await openPromoted(page, title)
    await passOverDocument(app, first.id)

    // #then the file is not touched at all, and that IS the convergence proof: the pass over the
    // reopened document serialized the same bytes and left the file alone
    expect(readWithMtime(absPath)).toEqual(afterFirstOpen)
  })

  test('an inline #hashtag does not add a tags: block on open', async ({
    app,
    page,
    testVaultPath
  }) => {
    await vaultOpen(page)

    // #given a note with no frontmatter and one inline hash tag in its body: an Obsidian user
    // who keeps tags in the body and not in frontmatter
    const title = `Inline Tag Frontmatter ${Date.now()}`
    const absPath = seedVaultFile(testVaultPath, title, 'Tagged #hashtag here.')
    const baseline = await indexedBaseline(page, title, absPath)
    expect(baseline.bytes).not.toContain('tags:')

    // #when it is opened and the editor shows it
    await openInEditor(page, title)
    await expect(page.locator(NOTE_EDITOR).first()).toContainText('Tagged')

    // #then a hash tag is never promoted, so the open changes nothing in the document. Electron
    // asserted that no write-back pass ran; on WebKitGTK the editor's open sends the document an
    // update and one pass runs, which finds the file already holding the body. The claim that
    // survives every engine is the one asserted below: the file is never rewritten.
    expect((await writebackDebug(app, baseline.id))?.lastError ?? null).toBeNull()

    // #and the note really does carry the tag, through the index (#1454), so this is not a lost
    // feature. The index projects it on its own schedule, so it is polled.
    await expect
      .poll(async () => (await getNote(page, baseline.id))?.tags ?? [])
      .toContain('hashtag')

    // #and after closing it and quitting, the whole file is byte-identical and never rewritten:
    // the tag stays where the user put it
    await closeNoteTab(page, title)
    await gracefulClose(app)
    const after = readWithMtime(absPath)
    expect(after).toEqual({ bytes: baseline.bytes, mtimeMs: baseline.mtimeMs })
    expect(after.bytes).not.toContain('tags:')
  })
})
