/**
 * Opening a COLLABORATIVE note turns `| [ ] task |` into a real checkbox.
 *
 * This is the path the feature actually runs on, and it is not the one
 * `normalize-note-blocks.ts` covers: `useEditorSync`'s load effect returns
 * early when a Y.Doc fragment is bound, so `normalizeNoteBlocks` — and every
 * promoter in it — runs on the markdown path only. The collaborative path has
 * its own promotion step, and this file is what says so. Written after the E2E
 * caught the gap: the unit suites were green while the real app opened a
 * hand-written checkbox as four characters of text.
 *
 * Modelled on `wiki-link-collab-promotion.test.ts`, with nothing faked between
 * the editor and the CRDT:
 *
 * - a REAL `BlockNoteEditor` built from the REAL `editorSchema`, mounted,
 * - REAL Yjs collaboration against a REAL `Y.Doc` fragment,
 * - the REAL `useEditorSync` hook, whose real load effect does the promoting.
 *
 * What is stood in for: main's `markdownToYFragment` — the fragment is seeded
 * with the block shape that parser produces for `| [ ] task |` (one plain text
 * run in the cell), because importing `src/main` here would drag `node:crypto`,
 * `electron-log` and both databases into the renderer's jsdom project. That
 * main really leaves the token as plain text, and that its write-back turns the
 * promoted node back into the identical bytes, is asserted on the other side in
 * `src/main/sync/blocknote-converter.test.ts`.
 */

import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BlockNoteEditor, type Block } from '@blocknote/core'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'

// The file block's PDF preview pulls pdf.js, which touches `DOMMatrix` at
// import time and jsdom has none. Everything else in the schema is real.
vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))

vi.mock('@/lib/url-metadata', () => ({
  fetchLinkPreview: vi.fn().mockResolvedValue({ domain: '', title: '', favicon: '' })
}))

import { editorSchema } from './editor-schema'
import { useEditorSync } from './hooks/use-editor-sync'

const mounted: Array<{ editor: BlockNoteEditor; el: HTMLElement; doc: Y.Doc }> = []

afterEach(() => {
  for (const { editor, el, doc } of mounted.splice(0)) {
    ;(editor as unknown as { mount: (element?: HTMLElement) => void }).mount()
    el.remove()
    doc.destroy()
  }
})

function createCollaborativeEditor(): { editor: BlockNoteEditor; fragment: Y.XmlFragment } {
  const doc = new Y.Doc()
  const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)

  // Exactly how ContentArea builds it when `isCollaborationActive(...)` is true.
  const editor = BlockNoteEditor.create({
    schema: editorSchema,
    collaboration: { fragment, user: { name: 'Local User', color: '#3b82f6' } }
  } as never) as unknown as BlockNoteEditor

  const el = document.createElement('div')
  document.body.appendChild(el)
  editor.mount(el)
  mounted.push({ editor, el, doc })

  return { editor, fragment }
}

/** Seed the shared doc the way main's parser leaves it: the token as text. */
function seedTableCell(editor: BlockNoteEditor, text: string): void {
  editor.replaceBlocks(editor.document, [
    {
      type: 'table',
      content: {
        type: 'tableContent',
        columnWidths: [null],
        rows: [
          {
            cells: [
              {
                type: 'tableCell',
                content: text ? [{ type: 'text', text, styles: {} }] : [],
                props: {}
              }
            ]
          }
        ]
      }
    } as never
  ])
}

function nodeNames(fragment: Y.XmlFragment): string[] {
  const names: string[] = []
  const visit = (node: Y.XmlFragment | Y.XmlElement): void => {
    for (const child of node.toArray()) {
      const element = child as Y.XmlElement
      if (typeof element.nodeName !== 'string') continue
      names.push(element.nodeName)
      visit(element)
    }
  }
  visit(fragment)
  return names
}

/** The first cell's inline content, as `{ type }` pairs plus text. */
function cellRuns(editor: BlockNoteEditor): Array<Record<string, unknown>> {
  const table = editor.document[0] as Block
  const content = table.content as unknown as {
    rows: Array<{ cells: Array<{ content: Array<Record<string, unknown>> }> }>
  }
  return content.rows[0].cells[0].content
}

/**
 * Renders the real hook. Rendering it IS opening the note: the load effect is
 * what runs on mount, and that effect is the whole subject here — the returned
 * `handleChange` is deliberately never called.
 */
function openNote(editor: BlockNoteEditor, fragment: Y.XmlFragment): void {
  renderHook(() => useEditorSync({ editor, noteId: 'checkbox-collab-note', yjsFragment: fragment }))
}

describe('opening a collaborative note promotes its cell checkboxes', () => {
  it('turns a cell reading `[ ] task` into a node in the shared Y.Doc', () => {
    // #given a shared doc holding what main's parser leaves behind. `[ ]` in a
    // cell is literal text to every markdown parser, so there is no `<input>`
    // for a `parse` rule to have claimed.
    const { editor, fragment } = createCollaborativeEditor()
    seedTableCell(editor, '[ ] task')
    expect(nodeNames(fragment)).not.toContain('inlineCheckbox')

    // #when the note is opened and nothing else happens — no keystroke
    openNote(editor, fragment)

    // #then the promotion reached the CRDT, not just the local editor state
    expect(nodeNames(fragment)).toContain('inlineCheckbox')
    expect(cellRuns(editor)).toEqual([
      { type: 'inlineCheckbox', props: { checked: false } },
      { type: 'text', text: 'task', styles: {} }
    ])
  })

  it('keeps the ticked state of `[x] done`', () => {
    const { editor, fragment } = createCollaborativeEditor()
    seedTableCell(editor, '[x] done')

    openNote(editor, fragment)

    expect(cellRuns(editor)[0]).toEqual({ type: 'inlineCheckbox', props: { checked: true } })
  })

  it('leaves a cell whose token is not at the head alone', () => {
    // #given the false positive the head-only rule exists to avoid
    const { editor, fragment } = createCollaborativeEditor()
    seedTableCell(editor, 'see [ ] below')

    // #when
    openNote(editor, fragment)

    // #then untouched, and no node was written into the shared doc
    expect(nodeNames(fragment)).not.toContain('inlineCheckbox')
    expect(cellRuns(editor)).toEqual([{ type: 'text', text: 'see [ ] below', styles: {} }])
  })

  it('promotes once and writes nothing on a second open', () => {
    // #given a note opened once already — the shared doc now holds the node
    const { editor, fragment } = createCollaborativeEditor()
    seedTableCell(editor, '[ ] task')
    openNote(editor, fragment)
    expect(nodeNames(fragment)).toContain('inlineCheckbox')

    // #when it is opened again. "Opening a note must not rewrite it" (#1434):
    // a promoted node leaves no `[ ]` text behind, so the pass finds nothing.
    const updates: Uint8Array[] = []
    const doc = fragment.doc as Y.Doc
    doc.on('update', (update: Uint8Array) => updates.push(update))
    openNote(editor, fragment)

    // #then no CRDT update at all — not a no-op update, none
    expect(updates).toEqual([])
    expect(cellRuns(editor)).toEqual([
      { type: 'inlineCheckbox', props: { checked: false } },
      { type: 'text', text: 'task', styles: {} }
    ])
  })
})
