/**
 * Markdown Memry did not author survives being opened and closed (#1909).
 *
 * A user pointed Memry at an Obsidian vault and got the files back in Memry's
 * own dialect. Three of those rewrites lost information rather than style. A
 * two-space hard line break came back as a paragraph break. A reference-style
 * link came back with its destination inlined and its definition deleted. An
 * untagged code fence came back tagged ```javascript.
 *
 * The fence row is the one that cost a user their board. Obsidian Kanban does
 * not read its settings off an AST: it scans the raw file backwards from EOF
 * and JSON-parses everything between the opening fence's third backtick and
 * the closing fence, so an invented info string lands inside the slice, the
 * parse throws, and every lane and card is replaced by a stack trace.
 *
 * The converter pair is pinned function by function in
 * `src/main/sync/foreign-markdown-roundtrip.test.ts`. What only an E2E can show
 * is that the RUNNING app wires that pair to the vault: the bytes are seeded on
 * disk, the note is opened in the real editor, and the `.md` is read back with
 * `fs`.
 *
 * `getNoteFileBodyById` is deliberately not the reader. Its `normalizeBodyText`
 * trims the end of the body and collapses blank-line runs, and the two spaces
 * that spell a hard line break are exactly the bytes under test, so that helper
 * would report the bug as already fixed. `fs` is the only honest reader for a
 * claim about bytes.
 *
 * The sync-auth fixture is here for the reason
 * `toggle-writeback-byte-stability.e2e.ts` gives: collaboration has to be live
 * for the editor to bind the shared Y.Doc, which is what puts the save on the
 * CRDT write-back path (`blocknote-converter.ts`) and hands the suite a
 * write-back counter. Without that counter a "the bytes did not change" test
 * passes even when nothing ever saved.
 *
 * Each case reads the file, the shared doc and the UI in one poll. Any one of
 * those layers can be the one that gave way, and a single-layer assertion
 * leaves which one to a screenshot; one object names it in the diff.
 *
 * The first-run tour is dismissed by `waitForAppReady`, which the `pageA`
 * fixture already runs before handing the page over, so nothing here fights the
 * driver.js overlay.
 *
 * Run with `BUILD_BEFORE_TEST=1`.
 */

import * as fs from 'fs'
import * as path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures/sync-auth-fixtures'
import {
  getCrdtDocBodyById,
  getNoteHandleByTitle,
  getCrdtMarkdownSourceById,
  getWritebackDebugById,
  openNoteByTitle
} from './utils/note-sync-helpers'
import { waitForSyncOnline } from './utils/network-control'
import { SELECTORS } from './utils/electron-helpers'

/** Built by concatenation so no source line here ends in whitespace. */
const HARD_BREAK = '  \n'
const HARD_BREAK_BODY = `Line one${HARD_BREAK}Line two`

/** One definition, referenced twice, which is the case inlining cannot fake. */
const REFERENCE_BODY = 'See [a][d] and [b][d].\n\n[d]: https://example.com'
const REFERENCE_DESTINATION = 'https://example.com'

/**
 * The tail of an Obsidian Kanban board.
 *
 * The lanes are left out on purpose. A `- [ ]` card pulls in the task-id
 * stamper, which writes `{task:id}` back into the file from a pipeline that has
 * nothing to do with this issue, and its write would race the one under test.
 */
const KANBAN_SETTINGS_JSON = '{"kanban-plugin":"basic"}'
const KANBAN_BODY = [
  '## Todo',
  '',
  '%% kanban:settings',
  '```',
  KANBAN_SETTINGS_JSON,
  '```',
  '%%'
].join('\n')

/**
 * Every spelling #1915 is about, in one body: a setext heading, `*` bullets, a
 * four-space nested indent, a list glued to its paragraph, underscore emphasis
 * and a dash rule. The document re-derives all of it in house style; the file
 * must not.
 */
const FOREIGN_SPELLING_BODY = [
  'Title',
  '=====',
  '',
  'Text:',
  '* One',
  '* Two',
  '    * Nested',
  '',
  '_em_ and __strong__ here.',
  '',
  '---',
  '',
  'Below'
].join('\n')

const FENCE_LINE = /^ {0,3}(?:`{3,}|~{3,})(.*)$/

/** The info string on the first opening fence, `''` when it carries none. */
function openingFenceInfo(markdown: string): string | null {
  for (const line of markdown.split('\n')) {
    const match = line.match(FENCE_LINE)
    if (match) return match[1].trim()
  }
  return null
}

/** The lines the first fence encloses. */
function fencedBody(markdown: string): string {
  const lines = markdown.split('\n')
  const open = lines.findIndex((line) => FENCE_LINE.test(line))
  if (open === -1) return ''
  const close = lines.findIndex((line, index) => index > open && FENCE_LINE.test(line))
  return lines.slice(open + 1, close === -1 ? undefined : close).join('\n')
}

function seedVaultFile(vaultPath: string, title: string, body: string): string {
  const absPath = path.join(vaultPath, 'notes', `${title}.md`)
  fs.mkdirSync(path.dirname(absPath), { recursive: true })
  fs.writeFileSync(absPath, body, 'utf8')
  return absPath
}

/**
 * The bytes the file settles on once the indexer has claimed it.
 *
 * Indexing a file that has never been seen stamps frontmatter on it before any
 * editor exists, which is not what these tests are about. Taking the baseline
 * after the file stops moving makes the later comparison mean exactly "did
 * SAVING it change anything".
 */
async function indexedBaseline(
  page: Page,
  title: string,
  absPath: string
): Promise<{ id: string; bytes: string }> {
  const note = await getNoteHandleByTitle(page, title)
  let bytes = fs.readFileSync(absPath, 'utf8')
  await expect
    .poll(
      () => {
        const next = fs.readFileSync(absPath, 'utf8')
        const settled = next === bytes
        bytes = next
        return settled
      },
      { timeout: 20_000, intervals: [1000] }
    )
    .toBe(true)
  return { id: note.id, bytes }
}

async function openInEditor(page: Page, title: string): Promise<void> {
  await openNoteByTitle(page, title)
  await page.locator(SELECTORS.noteEditor).first().waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForFunction(() => Boolean((window as any).__memryEditor), undefined, {
    timeout: 30_000
  })
}

/**
 * An edit and its immediate undo, at the end of the document.
 *
 * Write-back only runs from a doc update — `onDocUpdate` is `scheduleWriteback`'s
 * one production caller — so a test that only opened the note would assert on a
 * file the app never saved. The insert and removal go through the editor API
 * rather than a click and a keystroke because a click lands a caret somewhere,
 * and where the caret sits changes what a fence or a hard break serializes to.
 */
async function nudgeDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    const editor = (window as any).__memryEditor
    if (!editor) throw new Error('window.__memryEditor not exposed')

    const before = (editor.document as any[]).map((block) => block.id)
    editor.insertBlocks(
      [{ type: 'paragraph', content: [{ type: 'text', text: 'nudge', styles: {} }] }],
      before[before.length - 1],
      'after'
    )
    const added = (editor.document as any[]).filter((block) => !before.includes(block.id))
    editor.removeBlocks(added.map((block) => block.id))
  })
}

/** Block until the debounced write-back has run for this note and gone quiet. */
async function waitForWritebackToSettle(
  electronApp: ElectronApplication,
  noteId: string
): Promise<void> {
  await expect
    .poll(
      async () => {
        const debug = await getWritebackDebugById(electronApp, noteId)
        return { performed: (debug?.performedCount ?? 0) >= 1, pending: debug?.pending ?? true }
      },
      { timeout: 30_000 }
    )
    .toEqual({ performed: true, pending: false })
}

/**
 * The blocks a reader can see, as `{type, language, text}`.
 *
 * Whitespace runs are collapsed because the file and the doc already carry the
 * byte-level claim; what the UI adds is whether the two halves of a hard break
 * are one block or two. Empty blocks are dropped so BlockNote's trailing
 * paragraph does not have to be predicted.
 */
async function visibleBlocks(
  page: Page
): Promise<Array<{ type: string; language: string; text: string }>> {
  return page.evaluate(() => {
    const editor = (window as any).__memryEditor
    if (!editor) throw new Error('window.__memryEditor not exposed')

    const readInline = (content: any): string => {
      if (!Array.isArray(content)) return ''
      return content
        .map((part: any) =>
          typeof part?.text === 'string' ? part.text : readInline(part?.content)
        )
        .join('')
    }

    return (editor.document as any[])
      .map((block) => ({
        type: block.type as string,
        language: (block.props?.language as string) ?? '',
        text: readInline(block.content).replace(/\s+/g, ' ').trim()
      }))
      .filter((block) => block.text !== '')
  })
}

/** Every anchor the editor painted, which is what "a working link" means here. */
async function editorLinks(page: Page): Promise<Array<{ text: string; href: string }>> {
  return page
    .locator(SELECTORS.noteEditor)
    .first()
    .locator('a[href]')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        text: (node.textContent ?? '').trim(),
        href: node.getAttribute('href') ?? ''
      }))
    )
}

/**
 * Close the note and wait until main has really let its Y.Doc go.
 *
 * The acceptance on #1909 is place the file, open it, close it, and find it
 * unchanged. Polling the doc to null is what makes "closed" mean closed: while
 * a live doc is still bound, a final write-back can land after the assertion
 * has already read the file.
 */
async function closeNote(
  page: Page,
  electronApp: ElectronApplication,
  title: string,
  noteId: string
): Promise<void> {
  const tab = page.locator(SELECTORS.tab).filter({ hasText: title }).first()
  await expect(tab).toBeVisible()
  await tab.hover()
  const closeButton = tab.locator('button[aria-label^="Close"]').first()
  if (await closeButton.isVisible().catch(() => false)) {
    await closeButton.click()
  } else {
    await tab.click({ button: 'middle' })
  }
  await expect(tab).toBeHidden()
  await expect.poll(() => getCrdtDocBodyById(electronApp, noteId), { timeout: 30_000 }).toBeNull()
}

test.describe('Foreign markdown round-trip', () => {
  test('a two-space hard line break is still a hard line break after a save (#1909)', async ({
    pageA,
    electronAppA,
    vaultPathA,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair
    await waitForSyncOnline(pageA)

    const title = `Foreign Hard Break ${Date.now()}`
    const absPath = seedVaultFile(vaultPathA, title, HARD_BREAK_BODY)
    const baseline = await indexedBaseline(pageA, title, absPath)
    expect(baseline.bytes, 'the indexer left the two spaces alone').toContain(HARD_BREAK_BODY)

    await openInEditor(pageA, title)
    await nudgeDocument(pageA)
    await waitForWritebackToSettle(electronAppA, baseline.id)

    await expect
      .poll(
        async () => ({
          file: fs.readFileSync(absPath, 'utf8'),
          doc: await getCrdtDocBodyById(electronAppA, baseline.id),
          ui: (await visibleBlocks(pageA)).map((block) => block.text)
        }),
        { timeout: 30_000 }
      )
      .toEqual({
        file: baseline.bytes,
        doc: HARD_BREAK_BODY,
        ui: ['Line one Line two']
      })
    expect((await getWritebackDebugById(electronAppA, baseline.id))?.lastError).toBeNull()

    const settled = fs.readFileSync(absPath, 'utf8')
    await closeNote(pageA, electronAppA, title, baseline.id)
    await expect.poll(() => fs.readFileSync(absPath, 'utf8'), { timeout: 20_000 }).toBe(settled)
  })

  test('a reference link and the definition it points at both survive a save (#1909)', async ({
    pageA,
    electronAppA,
    vaultPathA,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair
    await waitForSyncOnline(pageA)

    const title = `Foreign Reference Link ${Date.now()}`
    const absPath = seedVaultFile(vaultPathA, title, REFERENCE_BODY)
    const baseline = await indexedBaseline(pageA, title, absPath)
    expect(baseline.bytes, 'the indexer left the definition alone').toContain(REFERENCE_BODY)

    await openInEditor(pageA, title)
    await nudgeDocument(pageA)
    await waitForWritebackToSettle(electronAppA, baseline.id)

    await expect
      .poll(
        async () => {
          const file = fs.readFileSync(absPath, 'utf8')
          return {
            file,
            definition: file.includes(`[d]: ${REFERENCE_DESTINATION}`),
            inlined: file.includes(`](${REFERENCE_DESTINATION})`),
            doc: await getCrdtDocBodyById(electronAppA, baseline.id),
            ui: await editorLinks(pageA)
          }
        },
        { timeout: 30_000 }
      )
      .toEqual({
        file: baseline.bytes,
        definition: true,
        inlined: false,
        doc: REFERENCE_BODY,
        ui: [
          { text: 'a', href: REFERENCE_DESTINATION },
          { text: 'b', href: REFERENCE_DESTINATION }
        ]
      })
    expect((await getWritebackDebugById(electronAppA, baseline.id))?.lastError).toBeNull()

    const settled = fs.readFileSync(absPath, 'utf8')
    await closeNote(pageA, electronAppA, title, baseline.id)
    await expect.poll(() => fs.readFileSync(absPath, 'utf8'), { timeout: 20_000 }).toBe(settled)
  })

  test('an Obsidian Kanban settings fence stays untagged through a save (#1909)', async ({
    pageA,
    electronAppA,
    vaultPathA,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair
    await waitForSyncOnline(pageA)

    const title = `Foreign Kanban Settings ${Date.now()}`
    const absPath = seedVaultFile(vaultPathA, title, KANBAN_BODY)
    const baseline = await indexedBaseline(pageA, title, absPath)
    expect(baseline.bytes, 'the indexer left the bare fence alone').toContain(KANBAN_BODY)

    await openInEditor(pageA, title)
    await nudgeDocument(pageA)
    await waitForWritebackToSettle(electronAppA, baseline.id)

    // Whole-file byte identity is the wrong assertion for this row. The round
    // trip inserts a blank line after `%% kanban:settings` and before the
    // closing `%%`, which is pinned as canonical in the unit sibling and is
    // harmless: the plugin's backwards scan tolerates blank lines. The info
    // string and the JSON are what it cannot tolerate.
    await expect
      .poll(
        async () => {
          const file = fs.readFileSync(absPath, 'utf8')
          const doc = (await getCrdtDocBodyById(electronAppA, baseline.id)) ?? ''
          return {
            fileFenceTag: openingFenceInfo(file),
            fileFenced: fencedBody(file),
            taggedJavascript: file.includes('```javascript'),
            docFenceTag: openingFenceInfo(doc),
            docFenced: fencedBody(doc),
            ui: (await visibleBlocks(pageA))
              .filter((block) => block.type === 'codeBlock')
              .map((block) => ({ language: block.language, text: block.text }))
          }
        },
        { timeout: 30_000 }
      )
      .toEqual({
        fileFenceTag: '',
        fileFenced: KANBAN_SETTINGS_JSON,
        taggedJavascript: false,
        docFenceTag: '',
        docFenced: KANBAN_SETTINGS_JSON,
        ui: [{ language: '', text: KANBAN_SETTINGS_JSON }]
      })
    expect((await getWritebackDebugById(electronAppA, baseline.id))?.lastError).toBeNull()

    const settled = fs.readFileSync(absPath, 'utf8')
    await closeNote(pageA, electronAppA, title, baseline.id)
    const afterClose = fs.readFileSync(absPath, 'utf8')
    expect(afterClose, 'closing the note wrote nothing further').toBe(settled)
    expect(openingFenceInfo(afterClose), 'the closed file still opens a bare fence').toBe('')
  })

  test('a file spelled the way Memry never spells comes back byte-identical after a save (#1915)', async ({
    pageA,
    electronAppA,
    vaultPathA,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair
    await waitForSyncOnline(pageA)

    const title = `Foreign Spelling ${Date.now()}`
    const absPath = seedVaultFile(vaultPathA, title, FOREIGN_SPELLING_BODY)
    const baseline = await indexedBaseline(pageA, title, absPath)
    expect(baseline.bytes, 'the indexer left the spelling alone').toContain(FOREIGN_SPELLING_BODY)

    await openInEditor(pageA, title)
    // Insert-then-remove: the document ends where it started, which is the
    // case the record exists for — a note opened, touched, and not changed.
    await nudgeDocument(pageA)
    await waitForWritebackToSettle(electronAppA, baseline.id)

    // Read with `fs`: the debug state's `lastMarkdown` runs through
    // `normalizeBodyText`, and these bytes are exactly what it would smooth.
    // The record and the restore outcome ride along so a failure names the
    // layer: no record after seed, a write-back that never read it, or a
    // merge the proof refused.
    await expect
      .poll(
        async () => {
          const record = await getCrdtMarkdownSourceById(electronAppA, baseline.id)
          const debug = await getWritebackDebugById(electronAppA, baseline.id)
          return {
            file: fs.readFileSync(absPath, 'utf8'),
            recordPresent: record !== null,
            // The open editor keeps an empty trailing paragraph, so the live
            // doc serializes to the seed's house style plus a trailing gap and
            // nothing else; anything more is the renderer reshaping the doc.
            canonicalDrift:
              record && record.current?.replace(/\n+$/, '') !== record.canonical
                ? { seed: record.canonical, now: record.current }
                : null,
            sourceRestore: debug?.sourceRestore,
            lastError: debug?.lastError
          }
        },
        { timeout: 30_000 }
      )
      .toEqual({
        file: baseline.bytes,
        recordPresent: true,
        canonicalDrift: null,
        sourceRestore: 'source',
        lastError: null
      })
    expect(
      (await visibleBlocks(pageA)).map((block) => block.type).slice(0, 3),
      'the editor read a heading, a paragraph and a list, not literal underline and bullets'
    ).toEqual(['heading', 'paragraph', 'bulletListItem'])

    await closeNote(pageA, electronAppA, title, baseline.id)
    expect(fs.readFileSync(absPath, 'utf8'), 'closing the note wrote nothing further').toBe(
      baseline.bytes
    )
  })
})
