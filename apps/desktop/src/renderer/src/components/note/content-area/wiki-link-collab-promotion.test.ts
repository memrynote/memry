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

function createCollaborativeEditor(): CollabEditor {
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

/** Renders the real hook and hands back its real `handleChange`. */
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
