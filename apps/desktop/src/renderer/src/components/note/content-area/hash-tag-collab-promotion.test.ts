/**
 * Opening a COLLABORATIVE note turns `#tag` text back into a hash-tag chip.
 *
 * The same gap `date-mention-collab-promotion.test.ts` covers: a `hashTag` node
 * serializes to plain `#tag` in the vault file, main seeds the shared Y.Doc
 * from that file, and `useEditorSync`'s load effect returns before the markdown
 * path's `normalizeHashTags` once a fragment is bound. A journal entry reopened
 * after its doc was rebuilt from disk showed its inline tags as plain text.
 *
 * Nothing is faked between the editor and the CRDT: a REAL `BlockNoteEditor` on
 * the REAL `editorSchema`, mounted, with REAL Yjs collaboration against a REAL
 * `Y.Doc`, and the REAL hook whose load effect does the promoting. Main's
 * `markdownToYFragment` is stood in for by the renderer's own markdown parser,
 * which leaves `#tag` as text for the same reason: markdown has no hash-tag
 * element for the spec's `parse` rule to claim.
 */

import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BlockNoteEditor, type Block } from '@blocknote/core'
import * as Y from 'yjs'
import { yUndoPluginKey } from 'y-prosemirror'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'

vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))

vi.mock('@/lib/url-metadata', () => ({
  fetchLinkPreview: vi.fn().mockResolvedValue({ domain: '', title: '', favicon: '' })
}))

import { editorSchema } from './editor-schema'
import { withCollaborationIfLive } from './collaboration-options'
import { useEditorSync } from './hooks/use-editor-sync'
import { parseMarkdownPreservingBlanks, serializeBlocksPreservingBlanks } from './markdown-utils'

const mounted: Array<{ editor: BlockNoteEditor; el: HTMLElement; doc: Y.Doc }> = []

afterEach(() => {
  for (const { editor, el, doc } of mounted.splice(0)) {
    editor.unmount()
    el.remove()
    doc.destroy()
  }
})

function createCollaborativeEditor(): { editor: BlockNoteEditor; fragment: Y.XmlFragment } {
  const doc = new Y.Doc()
  const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)

  // The production helper, so the editor really binds to the Y.Doc.
  const editor = BlockNoteEditor.create(
    withCollaborationIfLive(fragment, { schema: editorSchema })
  ) as unknown as BlockNoteEditor

  const el = document.createElement('div')
  document.body.appendChild(el)
  editor.mount(el)
  mounted.push({ editor, el, doc })

  return { editor, fragment }
}

/** Seed the shared doc from vault markdown, as main does on a fresh doc. */
async function seedFromMarkdown(editor: BlockNoteEditor, markdown: string): Promise<void> {
  const blocks = await parseMarkdownPreservingBlanks(editor, markdown)
  editor.replaceBlocks(editor.document, blocks as never)
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

function runs(editor: BlockNoteEditor, blockIndex = 0): Array<Record<string, unknown>> {
  return (editor.document[blockIndex] as Block).content as unknown as Array<Record<string, unknown>>
}

const TAG_COLORS = new Map([['work', 'blue']])

function openNote(
  editor: BlockNoteEditor,
  fragment: Y.XmlFragment,
  tags: { noteTags?: string[]; tagColorMap?: Map<string, string> } = {
    noteTags: ['work'],
    tagColorMap: TAG_COLORS
  }
): void {
  renderHook(() =>
    useEditorSync({ editor, noteId: 'hash-tag-collab-note', yjsFragment: fragment, ...tags })
  )
}

describe('opening a collaborative note promotes its hash tags', () => {
  it('turns #tag text seeded from markdown into a hashTag node in the shared Y.Doc', async () => {
    // #given the shared doc as main leaves it: the tag is text
    const { editor, fragment } = createCollaborativeEditor()
    const markdown = 'Tagged #work here.'
    await seedFromMarkdown(editor, markdown)
    expect(nodeNames(fragment)).not.toContain('hashTag')

    // #when the note is opened and nothing else happens
    openNote(editor, fragment)

    // #then the chip reached the CRDT, not just the local editor state
    expect(nodeNames(fragment)).toContain('hashTag')
    expect(runs(editor)).toEqual([
      { type: 'text', text: 'Tagged ', styles: {} },
      { type: 'hashTag', props: { tag: 'work', color: 'blue', icon: '' } },
      { type: 'text', text: ' here.', styles: {} }
    ])
    // #and the file format is unchanged: the node serializes to the same bytes
    expect(await serializeBlocksPreservingBlanks(editor, editor.document as Block[])).toBe(markdown)
  })

  it('keeps the promotion off the undo stack', async () => {
    const { editor, fragment } = createCollaborativeEditor()
    await seedFromMarkdown(editor, 'Tagged #work')

    openNote(editor, fragment)

    const tiptap = (editor as unknown as { _tiptapEditor: any })._tiptapEditor
    const undoManager = yUndoPluginKey.getState(tiptap.state)?.undoManager
    expect(nodeNames(fragment)).toContain('hashTag')
    expect(undoManager?.undoStack ?? []).toHaveLength(0)
  })

  it('leaves code, marked runs and tags the note does not carry as text', async () => {
    // #given every run a chip could not round-trip, plus an unknown tag
    const { editor, fragment } = createCollaborativeEditor()
    const markdown = [
      'a `#work` b',
      '',
      '**Nested #work** x',
      '',
      '```',
      '#work',
      '```',
      '',
      '#other'
    ].join('\n')
    await seedFromMarkdown(editor, markdown)
    // Compared against the seeded doc rather than the source: the serializer
    // spells an unlabelled fence as ```javascript, which is not this change.
    const seeded = await serializeBlocksPreservingBlanks(editor, editor.document as Block[])

    // #when
    openNote(editor, fragment)

    // #then nothing was promoted, so the doc still serializes the same way
    expect(nodeNames(fragment)).not.toContain('hashTag')
    expect(runs(editor, 0)).toContainEqual({
      type: 'text',
      text: '#work',
      styles: { code: true }
    })
    expect(await serializeBlocksPreservingBlanks(editor, editor.document as Block[])).toBe(seeded)
  })

  it('promotes nothing without the note tag list and colour map', async () => {
    // The markdown path's restriction: an owner that passes no tags opts out.
    const { editor, fragment } = createCollaborativeEditor()
    await seedFromMarkdown(editor, 'Tagged #work')

    openNote(editor, fragment, {})

    expect(nodeNames(fragment)).not.toContain('hashTag')
  })

  it('promotes once and writes nothing on a second open', async () => {
    // #given a note opened once already: the shared doc now holds the node
    const { editor, fragment } = createCollaborativeEditor()
    await seedFromMarkdown(editor, 'Tagged #work here.')
    openNote(editor, fragment)
    expect(nodeNames(fragment)).toContain('hashTag')

    // #when it is opened again. "Opening a note must not rewrite it" (#1434).
    const updates: Uint8Array[] = []
    const doc = fragment.doc as Y.Doc
    doc.on('update', (update: Uint8Array) => updates.push(update))
    openNote(editor, fragment)

    // #then no CRDT update at all
    expect(updates).toEqual([])
  })
})
