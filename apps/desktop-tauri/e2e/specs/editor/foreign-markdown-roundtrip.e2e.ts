// Markdown Memry did not author survives being opened, saved and closed (#1909, #1915, #2615),
// ported from Electron's `foreign-markdown-roundtrip.e2e.ts` (Step 14z, #3531).
//
// A user pointed Memry at an Obsidian vault and got the files back in Memry's own dialect. A
// two-space hard line break came back as a paragraph break, a reference-style link came back
// inlined with its definition deleted, and an untagged code fence came back tagged
// ```javascript, which broke an Obsidian Kanban board: the plugin JSON-parses everything between
// the opening fence's backticks and the closing fence. The bytes are seeded on disk, the note is
// opened in the real editor and saved, and the `.md` is read back with `fs`: `noteBody` and the
// write-back's `lastMarkdown` normalize exactly the bytes under test.
//
// Electron needed a signed-in sync pair to put the save on the write-back path; the Tauri editor
// always edits the app's document, so these specs need no sync. Each case reads the file and the
// UI in one poll, so a failure names the layer that gave way. Electron's third layer, the shared
// doc's markdown (`getCrdtDocMarkdown`), and its source-record probes (`getCrdtMarkdownSourceState`,
// `sourceRestore`) have no Tauri command: `e2e_writeback_debug_state` reports `sourceRestore` as
// null because the app keeps the author's spelling without a separate restore step. "Closed"
// means the tab closed and the app quit: the quit runs every scheduled pass, so a final
// write-back cannot land after the read.
import * as fs from 'node:fs'

import { NOTE_EDITOR, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import {
  closeNoteTab,
  indexedBaseline,
  nudgeDocument,
  openInEditor,
  readWithMtime,
  seedVaultFile,
  waitForWritebackToSettle,
  writebackDebug
} from '../../harness/seeded-note'
import { gracefulClose, type TauriApp } from '../../harness/tauri-lifecycle'
import { test, expect } from '../../harness/test'

/** Built by concatenation so no source line here ends in whitespace. */
const HARD_BREAK = '  \n'
const HARD_BREAK_BODY = `Line one${HARD_BREAK}Line two`

/** One definition, referenced twice, which is the case inlining cannot fake. */
const REFERENCE_BODY = 'See [a][d] and [b][d].\n\n[d]: https://example.com'
const REFERENCE_DESTINATION = 'https://example.com'

/**
 * The tail of an Obsidian Kanban board. The lanes are left out on purpose: a `- [ ]` card pulls
 * in the task-id stamper, whose write would race the one under test.
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

const KANBAN_COMMENT = KANBAN_BODY.slice(KANBAN_BODY.indexOf('%%'))

/**
 * Every spelling #1915 is about, in one body: a setext heading, `*` bullets, a four-space nested
 * indent, a list glued to its paragraph, underscore emphasis and a dash rule. The document
 * re-derives all of it in house style; the file must not.
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

/**
 * A Windows note in every spelling Memry does not write, with CRLF line endings. The parse used
 * to read each `\r` as a space, so one edited paragraph wrote the whole file in house style
 * (#2615).
 */
const CRLF_EDIT_LINE = 'Middle paragraph to edit.'
const CRLF_FOREIGN_BODY = [
  'Broad Title',
  '===========',
  '',
  `Intro with __bold__ and *em* text.   `,
  'Second line after a hard break.',
  '',
  '',
  '',
  '* star one',
  '* star two',
  '    * nested star',
  '',
  '+ plus one',
  '+ plus two',
  '',
  '***',
  '',
  CRLF_EDIT_LINE,
  '',
  'Sub Heading',
  '-----------',
  '',
  '<div align="center">',
  '<b>html block</b>',
  '</div>',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '',
  '    indented code line 1',
  '    indented code line 2',
  '',
  `Tail paragraph with a break.  `,
  'Final line.',
  ''
].join('\r\n')

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

interface LooseBlock {
  type: string
  props?: { language?: string; source?: string }
  content?: unknown
  children?: unknown
}

/**
 * The blocks a reader can see, as `{type, language, text}`. Whitespace runs are collapsed: the
 * file carries the byte-level claim, and what the UI adds is whether the two halves of a hard
 * break are one block or two. Empty blocks are dropped so the trailing paragraph need not be
 * predicted.
 */
function visibleBlocks(
  page: Page
): Promise<Array<{ type: string; language: string; text: string }>> {
  return page.evaluate(() => {
    const editor = (window as unknown as { __memryActiveEditor?: { document: LooseBlock[] } })
      .__memryActiveEditor
    if (!editor) throw new Error('window.__memryActiveEditor not exposed')
    const readInline = (content: unknown): string =>
      Array.isArray(content)
        ? content
            .map((part: { text?: unknown; content?: unknown }) =>
              typeof part?.text === 'string' ? part.text : readInline(part?.content)
            )
            .join('')
        : ''
    return editor.document
      .map((block) => ({
        type: block.type,
        language: block.props?.language ?? '',
        text: readInline(block.content).replace(/\s+/g, ' ').trim()
      }))
      .filter((block) => block.text !== '')
  })
}

/** The source of every `%%` comment marker the editor holds. */
function editorCommentSources(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const editor = (window as unknown as { __memryActiveEditor?: { document: LooseBlock[] } })
      .__memryActiveEditor
    if (!editor) throw new Error('window.__memryActiveEditor not exposed')
    const sources: string[] = []
    const walk = (parts: unknown): void => {
      if (!Array.isArray(parts)) return
      for (const part of parts as LooseBlock[]) {
        if (part?.type === 'htmlComment') sources.push(part.props?.source ?? '')
        walk(part?.content)
        walk(part?.children)
      }
    }
    walk(editor.document)
    return sources
  })
}

/** Every anchor the editor painted, which is what "a working link" means here. */
function editorLinks(page: Page): Promise<Array<{ text: string; href: string }>> {
  return page.evaluate(
    (selector: string) =>
      Array.from(document.querySelector(selector)?.querySelectorAll('a[href]') ?? []).map(
        (node) => ({
          text: (node.textContent ?? '').trim(),
          href: node.getAttribute('href') ?? ''
        })
      ),
    NOTE_EDITOR
  )
}

/** Seeds the note, waits for the app to index it, opens it and checks the indexer left it. */
async function seedAndOpen(
  page: Page,
  testVaultPath: string,
  title: string,
  body: string
): Promise<{ id: string; bytes: string; absPath: string }> {
  await vaultOpen(page)
  const absPath = seedVaultFile(testVaultPath, title, body)
  const baseline = await indexedBaseline(page, title, absPath)
  // The indexer left the seeded bytes alone.
  expect(baseline.bytes).toContain(body)
  await openInEditor(page, title)
  return { id: baseline.id, bytes: baseline.bytes, absPath }
}

/** Closes the tab, quits the app and answers the file as the quit left it. */
async function closeAndQuit(app: TauriApp, page: Page, title: string, absPath: string) {
  await closeNoteTab(page, title)
  await gracefulClose(app)
  return readWithMtime(absPath)
}

test.describe('Foreign markdown round-trip', () => {
  test('a two-space hard line break is still a hard line break after a save (#1909)', async ({
    app,
    page,
    testVaultPath
  }) => {
    const title = `Foreign Hard Break ${Date.now()}`
    const note = await seedAndOpen(page, testVaultPath, title, HARD_BREAK_BODY)
    await nudgeDocument(page)
    await waitForWritebackToSettle(app, note.id)

    await expect
      .poll(
        async () => ({
          file: fs.readFileSync(note.absPath, 'utf8'),
          ui: (await visibleBlocks(page)).map((block) => block.text)
        }),
        { timeout: 30_000 }
      )
      .toEqual({ file: note.bytes, ui: ['Line one Line two'] })
    expect((await writebackDebug(app, note.id))?.lastError).toBeNull()

    const settled = readWithMtime(note.absPath)
    expect(await closeAndQuit(app, page, title, note.absPath)).toEqual(settled)
  })

  test('a reference link and the definition it points at both survive a save (#1909)', async ({
    app,
    page,
    testVaultPath
  }) => {
    const title = `Foreign Reference Link ${Date.now()}`
    const note = await seedAndOpen(page, testVaultPath, title, REFERENCE_BODY)
    await nudgeDocument(page)
    await waitForWritebackToSettle(app, note.id)

    await expect
      .poll(
        async () => {
          const file = fs.readFileSync(note.absPath, 'utf8')
          return {
            file,
            definition: file.includes(`[d]: ${REFERENCE_DESTINATION}`),
            inlined: file.includes(`](${REFERENCE_DESTINATION})`),
            ui: await editorLinks(page)
          }
        },
        { timeout: 30_000 }
      )
      .toEqual({
        file: note.bytes,
        definition: true,
        inlined: false,
        ui: [
          { text: 'a', href: REFERENCE_DESTINATION },
          { text: 'b', href: REFERENCE_DESTINATION }
        ]
      })
    expect((await writebackDebug(app, note.id))?.lastError).toBeNull()

    const settled = readWithMtime(note.absPath)
    expect(await closeAndQuit(app, page, title, note.absPath)).toEqual(settled)
  })

  test('an Obsidian Kanban settings fence stays untagged through a save (#1909)', async ({
    app,
    page,
    testVaultPath
  }) => {
    const title = `Foreign Kanban Settings ${Date.now()}`
    const note = await seedAndOpen(page, testVaultPath, title, KANBAN_BODY)
    await nudgeDocument(page)
    await waitForWritebackToSettle(app, note.id)

    // The info string and the JSON are what the plugin cannot tolerate, so they are asserted
    // directly. Since #2835 the editor holds the whole `%%` comment, fence included, as one
    // htmlComment marker, not as a code block.
    await expect
      .poll(
        async () => {
          const file = fs.readFileSync(note.absPath, 'utf8')
          return {
            fileFenceTag: openingFenceInfo(file),
            fileFenced: fencedBody(file),
            taggedJavascript: file.includes('```javascript'),
            ui: await editorCommentSources(page)
          }
        },
        { timeout: 30_000 }
      )
      .toEqual({
        fileFenceTag: '',
        fileFenced: KANBAN_SETTINGS_JSON,
        taggedJavascript: false,
        ui: [KANBAN_COMMENT]
      })
    expect((await writebackDebug(app, note.id))?.lastError).toBeNull()

    const settled = readWithMtime(note.absPath)
    const afterClose = await closeAndQuit(app, page, title, note.absPath)
    // Closing the note wrote nothing further, and the closed file still opens a bare fence.
    expect(afterClose).toEqual(settled)
    expect(openingFenceInfo(afterClose.bytes)).toBe('')
  })

  test('a file spelled the way Memry never spells comes back byte-identical after a save (#1915)', async ({
    app,
    page,
    testVaultPath
  }) => {
    const title = `Foreign Spelling ${Date.now()}`
    const note = await seedAndOpen(page, testVaultPath, title, FOREIGN_SPELLING_BODY)
    // Insert-then-remove: the document ends where it started, which is the case the author's
    // spelling is kept for: a note opened, touched, and not changed.
    await nudgeDocument(page)
    await waitForWritebackToSettle(app, note.id)

    await expect
      .poll(
        async () => ({
          file: fs.readFileSync(note.absPath, 'utf8'),
          lastError: (await writebackDebug(app, note.id))?.lastError
        }),
        { timeout: 30_000 }
      )
      .toEqual({ file: note.bytes, lastError: null })
    // The editor read a heading, a paragraph and a list, not literal underline and bullets.
    expect((await visibleBlocks(page)).map((block) => block.type).slice(0, 3)).toEqual([
      'heading',
      'paragraph',
      'bulletListItem'
    ])

    // Closing the note wrote nothing further.
    expect((await closeAndQuit(app, page, title, note.absPath)).bytes).toBe(note.bytes)
  })

  test('editing one paragraph of a CRLF note changes only that line (#2615)', async ({
    app,
    page,
    testVaultPath
  }) => {
    const title = `Foreign CRLF ${Date.now()}`
    const note = await seedAndOpen(page, testVaultPath, title, CRLF_FOREIGN_BODY)
    await page.evaluate((line: string) => {
      const editor = (
        window as unknown as {
          __memryActiveEditor?: {
            document: Array<{ id: string; content?: unknown }>
            updateBlock(id: string, update: unknown): unknown
          }
        }
      ).__memryActiveEditor
      if (!editor) throw new Error('window.__memryActiveEditor not exposed')
      const target = editor.document.find((block) =>
        JSON.stringify(block.content ?? '').includes(line)
      )
      if (!target) throw new Error(`no block holds ${line}`)
      editor.updateBlock(target.id, {
        content: [{ type: 'text', text: `${line} EDITED`, styles: {} }]
      })
    }, CRLF_EDIT_LINE)
    await waitForWritebackToSettle(app, note.id)

    await expect
      .poll(
        async () => ({
          file: fs.readFileSync(note.absPath, 'utf8'),
          lastError: (await writebackDebug(app, note.id))?.lastError
        }),
        { timeout: 30_000 }
      )
      .toEqual({
        file: note.bytes.replace(CRLF_EDIT_LINE, `${CRLF_EDIT_LINE} EDITED`),
        lastError: null
      })

    const settled = readWithMtime(note.absPath)
    expect(await closeAndQuit(app, page, title, note.absPath)).toEqual(settled)
  })
})
