/**
 * The renderer half of "opening a note must not rewrite it" (#1434).
 *
 * Main parses the vault file into the shared Y.Doc with a `wikiLink` spec that
 * has no `parse` rule, so `[[X]]` reaches the doc as plain TEXT. This side then
 * promotes it: `use-editor-sync.ts`'s `handleChange` runs `normalizeWikiLinks`
 * on every change — it is NOT gated on collaboration — and replaces the
 * document when anything changed. That write lands in the shared Y.Doc through
 * y-prosemirror, and main serializes it back to `[[X]]` text. The loop only
 * exists because this step exists, so this file drives it with nothing faked
 * between the editor and the CRDT:
 *
 * - a REAL `BlockNoteEditor` built from the REAL `editorSchema`, mounted,
 * - REAL Yjs collaboration against a REAL `Y.Doc` fragment,
 * - the REAL `useEditorSync` hook, whose real `handleChange` does the promoting.
 *
 * What is stood in for: main's `markdownToYFragment` — the fragment is seeded
 * with the block shape that parser produces for `[[X]]` (one plain text run),
 * because importing `src/main` here would drag `node:crypto`, `electron-log`
 * and both databases into the renderer's jsdom project. That main really leaves
 * `[[X]]` as plain text, and that its write-back turns the promoted node back
 * into the identical bytes, is asserted on the other side in
 * `src/main/sync/note-open-byte-stability.test.ts`.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BlockNoteEditor, type Block } from '@blocknote/core'
import * as Y from 'yjs'
import { TextSelection } from '@tiptap/pm/state'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'

// The file block's PDF preview pulls pdf.js, which touches `DOMMatrix` at
// import time and jsdom has none. Everything else in the schema is real.
vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))

// `hydrateLinkMentionFavicons` fires on the load path; no fixture here has a
// link mention, but the module is imported either way.
vi.mock('@/lib/url-metadata', () => ({
  fetchLinkPreview: vi.fn().mockResolvedValue({ domain: '', title: '', favicon: '' })
}))

import { editorSchema } from './editor-schema'
import { useEditorSync } from './hooks/use-editor-sync'

const mounted: Array<{ editor: BlockNoteEditor; el: HTMLElement; doc: Y.Doc }> = []

afterEach(() => {
  for (const { editor, el, doc } of mounted.splice(0)) {
    // `mount()` with no element is BlockNote's unmount; its type only admits an
    // element, so the call has to say so.
    ;(editor as unknown as { mount: (element?: HTMLElement) => void }).mount()
    el.remove()
    doc.destroy()
  }
})

interface CollabEditor {
  editor: BlockNoteEditor
  doc: Y.Doc
  fragment: Y.XmlFragment
}

function createCollaborativeEditor(existingDoc?: Y.Doc): CollabEditor {
  const doc = existingDoc ?? new Y.Doc()
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

  return { editor, doc, fragment }
}

/** Seed the shared doc the way main's parser leaves it: `[[X]]` as plain text. */
function seedWithPlainText(editor: BlockNoteEditor, text: string): void {
  editor.replaceBlocks(editor.document, [
    {
      type: 'paragraph',
      content: [{ type: 'text', text, styles: {} }]
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

/**
 * Renders the real hook and hands back its real `handleChange`.
 *
 * Rendering it IS opening the note: the hook's load effect is what runs on
 * mount, and for the #1642 tests below that effect is the whole subject —
 * `handleChange` is deliberately never called there.
 */
function mountEditorSync(editor: BlockNoteEditor, fragment: Y.XmlFragment): () => void {
  const { result } = renderHook(() =>
    useEditorSync({
      editor,
      noteId: 'collab-promotion-note',
      yjsFragment: fragment
    })
  )
  return result.current.handleChange
}

/** The `target` of every `wikiLink` run in one block, in order. */
function wikiLinkTargets(editor: BlockNoteEditor, blockIndex = 0): string[] {
  const content = (editor.document[blockIndex] as Block).content as Array<{
    type: string
    props?: { target?: string }
  }>
  return content.filter((run) => run.type === 'wikiLink').map((run) => run.props?.target ?? '')
}

/** Park the caret inside the raw `[[…]]` run of the first paragraph. */
function putCaretInsideRawRun(editor: BlockNoteEditor, text: string): void {
  const tiptap = (editor as unknown as { _tiptapEditor: any })._tiptapEditor
  const offset = text.indexOf('[[') + 3
  const { state, dispatch } = tiptap.view
  dispatch(state.tr.setSelection(TextSelection.create(state.doc, 1 + offset)))
}

describe('the renderer promotes [[X]] inside a collaborative document', () => {
  it('writes a wikiLink node into the shared Y.Doc', () => {
    // #given a shared doc holding what main's parser produces for `[[X]]`
    const { editor, fragment } = createCollaborativeEditor()
    seedWithPlainText(editor, 'See [[Wiki Link]] for details.')
    expect(nodeNames(fragment)).not.toContain('wikiLink')

    // #when the editor fires its first change
    const handleChange = mountEditorSync(editor, fragment)
    act(() => handleChange())

    // #then the promotion reached the CRDT, not just the local editor state
    expect(nodeNames(fragment)).toContain('wikiLink')
    const paragraph = editor.document[0] as Block
    const content = paragraph.content as Array<{ type: string; props?: { target?: string } }>
    expect(content.map((run) => run.type)).toEqual(['text', 'wikiLink', 'text'])
    expect(content[1].props?.target).toBe('Wiki Link')
  })

  it('promotes once and then stops — the loop terminates', () => {
    // #given
    const { editor, doc, fragment } = createCollaborativeEditor()
    seedWithPlainText(editor, 'See [[Wiki Link]] for details.')
    const handleChange = mountEditorSync(editor, fragment)
    act(() => handleChange())

    // #when every later change event runs the same normalizer
    const updates: Uint8Array[] = []
    doc.on('update', (update: Uint8Array) => updates.push(update))
    act(() => handleChange())
    act(() => handleChange())
    act(() => handleChange())

    // #then nothing more is written: a `wikiLink` node carries its target in
    // props, so `[[` never reappears in the document and `normalizeWikiLinks`
    // stops matching. This is what makes the round trip a fixed point rather
    // than a rewrite on every open.
    expect(updates).toEqual([])
    expect(nodeNames(fragment).filter((name) => name === 'wikiLink')).toHaveLength(1)
  })

  it('keeps the block around the link — a list item stays a list item', () => {
    // #given the shape a text-matching `parse` rule destroys: the whole element
    // reads `[[A]]`, so a rule that promotes "any element whose text is a wiki
    // link" swallows the `<li>` with it (#1428)
    const { editor, fragment } = createCollaborativeEditor()
    editor.replaceBlocks(editor.document, [
      { type: 'bulletListItem', content: [{ type: 'text', text: '[[A]]', styles: {} }] } as never,
      { type: 'bulletListItem', content: [{ type: 'text', text: '[[B]]', styles: {} }] } as never
    ])

    // #when
    const handleChange = mountEditorSync(editor, fragment)
    act(() => handleChange())

    // #then — the trailing empty paragraph is BlockNote's own, not ours
    const authored = editor.document.filter(
      (block) => (block.content as unknown[] | undefined)?.length
    )
    expect(authored.map((block) => block.type)).toEqual(['bulletListItem', 'bulletListItem'])
    expect(
      authored.map(
        (block) => (block.content as Array<{ props?: { target?: string } }>)[0].props?.target
      )
    ).toEqual(['A', 'B'])
    expect(nodeNames(fragment).filter((name) => name === 'wikiLink')).toHaveLength(2)
  })

  it('leaves a hash tag and a date mention token as plain text', () => {
    // #given — neither has a promoter on the collaborative path
    // (`normalizeHashTags` runs only in the non-collaborative load branch, and
    // the hash-tag plugin is keystroke-driven), so both must survive untouched
    const { editor, doc, fragment } = createCollaborativeEditor()
    seedWithPlainText(editor, 'Tagged #hashtag on ((date:eyJhbmNob3JJZCI6ImExIn0)).')
    const handleChange = mountEditorSync(editor, fragment)

    // #when
    const updates: Uint8Array[] = []
    doc.on('update', (update: Uint8Array) => updates.push(update))
    act(() => handleChange())

    // #then
    expect(updates).toEqual([])
    expect(nodeNames(fragment)).not.toContain('hashTag')
    expect(nodeNames(fragment)).not.toContain('dateMention')
  })
})

/**
 * #1642. The tests above drive `handleChange`, which fires on an EDIT. That was
 * the ONLY promoter on the collaborative path, and it is the whole bug: a note
 * whose Y.Doc holds raw `[[X]]` — pulled from another device, seeded from a
 * file written outside Memry, or written by a pre-#1457 build — opened as
 * plain, unclickable text and stayed that way until the user typed into it.
 *
 * Nothing below ever calls `handleChange`. Mounting the hook is the whole act:
 * that is what opening a note does.
 */
describe('opening a collaborative note promotes its links without an edit', () => {
  it('turns raw [[X]] into a chip on open', () => {
    // #given a shared doc holding what main's parser leaves behind
    const { editor, fragment } = createCollaborativeEditor()
    seedWithPlainText(editor, 'See [[Wiki Link]] for details.')
    expect(nodeNames(fragment)).not.toContain('wikiLink')

    // #when the note is opened and nothing else happens — no keystroke
    mountEditorSync(editor, fragment)

    // #then the link is a node, in the editor and in the shared doc
    expect(wikiLinkTargets(editor)).toEqual(['Wiki Link'])
    expect(nodeNames(fragment).filter((name) => name === 'wikiLink')).toHaveLength(1)
  })

  it('shows the chip on a device that never touched the note', () => {
    // #given device A, which wrote the raw text, and its update on the wire
    const deviceA = createCollaborativeEditor()
    seedWithPlainText(deviceA.editor, 'See [[Wiki Link]] for details.')
    const fromA = Y.encodeStateAsUpdate(deviceA.doc)

    // #when device B receives it and opens the note — the reported case: the
    // user reads a page of links they did not write
    const docB = new Y.Doc()
    Y.applyUpdate(docB, fromA)
    const deviceB = createCollaborativeEditor(docB)
    expect(nodeNames(deviceB.fragment)).not.toContain('wikiLink')

    mountEditorSync(deviceB.editor, deviceB.fragment)

    // #then B sees a chip…
    expect(wikiLinkTargets(deviceB.editor)).toEqual(['Wiki Link'])

    // …and the promotion converges back onto A as one node rather than
    // clobbering A's body, because it went in as an ordinary CRDT mutation and
    // not as a whole-document replace
    Y.applyUpdate(deviceA.doc, Y.encodeStateAsUpdate(docB))
    expect(nodeNames(deviceA.fragment).filter((name) => name === 'wikiLink')).toHaveLength(1)
    expect(wikiLinkTargets(deviceA.editor)).toEqual(['Wiki Link'])
  })

  it('promotes every link in the document, not just the first block', () => {
    // #given the shape the report describes: a page that is a list of links
    const { editor, fragment } = createCollaborativeEditor()
    editor.replaceBlocks(editor.document, [
      { type: 'bulletListItem', content: [{ type: 'text', text: '[[A]]', styles: {} }] } as never,
      { type: 'bulletListItem', content: [{ type: 'text', text: '[[B]]', styles: {} }] } as never,
      { type: 'paragraph', content: [{ type: 'text', text: 'and [[C]]', styles: {} }] } as never
    ])

    // #when
    mountEditorSync(editor, fragment)

    // #then all three, and the blocks around them are untouched
    const authored = editor.document.filter(
      (block) => (block.content as unknown[] | undefined)?.length
    )
    expect(authored.map((block) => block.type)).toEqual([
      'bulletListItem',
      'bulletListItem',
      'paragraph'
    ])
    expect(
      authored.map(
        (block) => (block.content as Array<{ props?: { target?: string } }>).at(-1)?.props?.target
      )
    ).toEqual(['A', 'B', 'C'])
  })

  it('reopening a doc that already holds the node writes nothing', () => {
    // #given a note opened once, so the promotion has happened
    const { editor, doc, fragment } = createCollaborativeEditor()
    seedWithPlainText(editor, 'See [[Wiki Link]] for details.')
    mountEditorSync(editor, fragment)
    expect(nodeNames(fragment)).toContain('wikiLink')

    // #when it is opened again — the cold reopen, doc rebuilt from the store
    const updates: Uint8Array[] = []
    doc.on('update', (update: Uint8Array) => updates.push(update))
    mountEditorSync(editor, fragment)
    mountEditorSync(editor, fragment)

    // #then no CRDT update at all. Opening a note must not rewrite it (#1434),
    // and a promotion that ran on every open would push a doc update — and a
    // write-back — to every device, every time anyone read the note.
    expect(updates).toEqual([])
    expect(nodeNames(fragment).filter((name) => name === 'wikiLink')).toHaveLength(1)
  })

  it('leaves a hash tag and a date mention token as plain text', () => {
    // #given the same guarantee the edit path carries: only wiki links have a
    // promoter here, and the open path must not quietly acquire more
    const { editor, doc, fragment } = createCollaborativeEditor()
    seedWithPlainText(editor, 'Tagged #hashtag on ((date:eyJhbmNob3JJZCI6ImExIn0)).')
    const updates: Uint8Array[] = []
    doc.on('update', (update: Uint8Array) => updates.push(update))

    // #when
    mountEditorSync(editor, fragment)

    // #then
    expect(updates).toEqual([])
    expect(nodeNames(fragment)).not.toContain('hashTag')
    expect(nodeNames(fragment)).not.toContain('dateMention')
  })

  it('leaves the block whose raw run holds the caret alone, and promotes the rest', () => {
    // #given a caret parked inside a raw `[[…]]` run — what un-promoting a chip
    // to edit it leaves behind (`wiki-link-edit-plugin.ts`). Re-promoting under
    // that caret is the one case normalization must decline, and the open path
    // carries the same exemption the edit path does.
    const caretText = 'See [[Wiki Link]] and [[Sibling Run]].'
    const { editor, fragment } = createCollaborativeEditor()
    editor.replaceBlocks(editor.document, [
      { type: 'paragraph', content: [{ type: 'text', text: caretText, styles: {} }] } as never,
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Also [[Other Block]].', styles: {} }]
      } as never
    ])
    putCaretInsideRawRun(editor, caretText)

    // #when
    mountEditorSync(editor, fragment)

    // #then the caret's whole block is skipped — the sibling run inside it too,
    // which is what makes this exemption coarse and safe rather than clever…
    expect(wikiLinkTargets(editor, 0)).toEqual([])
    // …while every other block promotes as usual, so the exemption is a skip
    // and not an excuse to do nothing
    expect(wikiLinkTargets(editor, 1)).toEqual(['Other Block'])
    expect(nodeNames(fragment).filter((name) => name === 'wikiLink')).toHaveLength(1)
  })
})
