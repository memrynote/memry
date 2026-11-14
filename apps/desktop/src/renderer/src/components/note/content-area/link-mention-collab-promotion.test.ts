/**
 * The other half of #1844, and the one that made the mention vanish outright.
 *
 * Main seeded the shared Y.Doc straight from the vault file, and the mention
 * spec has no text `parse` rule, so `((mention:…))` reached the doc as plain
 * TEXT. Main's seed builds the node now (#3871); docs an older build seeded
 * still hold the text. The collaborative branch of `useEditorSync` returns before
 * `normalizeNoteBlocks` ever runs, so nothing on either side turned that text
 * back into a chip: a mention survived until the Y.Doc was thrown away, and
 * came back as literal `((mention:…))` after a restart or a vault switch.
 *
 * Built the same way `wiki-link-collab-promotion.test.ts` is, with nothing
 * faked between the editor and the CRDT: a REAL `BlockNoteEditor` on the REAL
 * `editorSchema`, REAL Yjs collaboration, the REAL `useEditorSync` hook. Only
 * main's `markdownToYFragment` is stood in for — the fragment is seeded with
 * the one plain text run that parser produces.
 */

import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BlockNoteEditor, type Block } from '@blocknote/core'
import { yUndoPluginKey } from 'y-prosemirror'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { serializeLinkMentionToken } from '@memry/editor-schema/inline'

vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))

const PREVIEW = {
  domain: 'eksisozluk.com',
  title: 'Entry 184233570',
  favicon: 'https://eksisozluk.com/favicon.ico',
  siteName: 'Eksi Sozluk'
}
const fetchLinkPreview = vi.fn().mockResolvedValue(PREVIEW)
vi.mock('@/lib/url-metadata', () => ({
  fetchLinkPreview: (url: string) => fetchLinkPreview(url),
  extractDomain: (url: string) => {
    try {
      return new URL(url).hostname.replace('www.', '')
    } catch {
      return url
    }
  }
}))

import { editorSchema } from './editor-schema'
import { withCollaborationIfLive } from './collaboration-options'
import { useEditorSync } from './hooks/use-editor-sync'

const mounted: Array<{ editor: BlockNoteEditor; el: HTMLElement; doc: Y.Doc }> = []

afterEach(() => {
  for (const { editor, el, doc } of mounted.splice(0)) {
    editor.unmount()
    el.remove()
    doc.destroy()
  }
  fetchLinkPreview.mockClear()
})

function createCollaborativeEditor(): {
  editor: BlockNoteEditor
  doc: Y.Doc
  fragment: Y.XmlFragment
} {
  const doc = new Y.Doc()
  const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
  const editor = BlockNoteEditor.create(
    // The production helper, not a copy of it: `collaboration` stopped being
    // an editor option in BlockNote 0.52 and passing it raw still compiles,
    // so a hand-rolled options object here would bind to nothing and these
    // tests would pass against an editor that never touches the Y.Doc.
    withCollaborationIfLive(fragment, { schema: editorSchema })
  ) as unknown as BlockNoteEditor

  const el = document.createElement('div')
  document.body.appendChild(el)
  editor.mount(el)
  mounted.push({ editor, el, doc })

  return { editor, doc, fragment }
}

/** Seed the shared doc the way main's parser leaves it: the token as plain text. */
function seedWithPlainText(editor: BlockNoteEditor, text: string): void {
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: [{ type: 'text', text, styles: {} }] } as never
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

/** Rendering the hook IS opening the note: its load effect is the subject. */
function openNote(editor: BlockNoteEditor, fragment: Y.XmlFragment): void {
  const { result } = renderHook(() =>
    useEditorSync({ editor, noteId: 'link-mention-promotion-note', yjsFragment: fragment })
  )
  // What `BlockNoteView`'s `onChange` does in ContentArea.
  editor.onChange(() => result.current.handleChange())
}

/** Every mention in the document, table cells and nested blocks included. */
function mentionProps(editor: BlockNoteEditor): Array<Record<string, string>> {
  const props: Array<Record<string, string>> = []
  editor._tiptapEditor.state.doc.descendants((node) => {
    if (node.type.name === 'linkMention') props.push({ ...node.attrs })
  })
  return props
}

async function settlePreviews(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const URL_ = 'https://eksisozluk.com/entry/184233570?debe=true'

describe('the renderer promotes ((mention:…)) inside a collaborative document', () => {
  it('writes a linkMention node into the shared Y.Doc on open', () => {
    // #given a shared doc holding what main's parser produces for a saved mention
    const { editor, fragment } = createCollaborativeEditor()
    seedWithPlainText(editor, `See ${serializeLinkMentionToken(URL_)} for details.`)
    expect(nodeNames(fragment)).not.toContain('linkMention')

    // #when the note is opened — no edit, no change event
    openNote(editor, fragment)

    // #then the promotion reached the CRDT, not just the local editor state
    expect(nodeNames(fragment)).toContain('linkMention')
    const content = (editor.document[0] as Block).content as Array<{
      type: string
      props?: { url?: string; domain?: string }
    }>
    expect(content.map((run) => run.type)).toEqual(['text', 'linkMention', 'text'])
    expect(content[1].props?.url).toBe(URL_)
    expect(content[1].props?.domain).toBe('eksisozluk.com')
  })

  it('promotes once and then stops — a second open writes nothing', async () => {
    // #given a note opened once
    const { editor, doc, fragment } = createCollaborativeEditor()
    seedWithPlainText(editor, `See ${serializeLinkMentionToken(URL_)} for details.`)
    openNote(editor, fragment)
    await settlePreviews()

    // #when it is opened again against the already-promoted document. Awaited
    // so any queued microtask lands inside the window being asserted on.
    const updates: Uint8Array[] = []
    doc.on('update', (update: Uint8Array) => updates.push(update))
    openNote(editor, fragment)
    openNote(editor, fragment)
    await Promise.resolve()

    // #then nothing more is written. A promoted `linkMention` carries its URL
    // in props, so `((mention:` is gone from the document and the normalizer
    // stops matching — which is what keeps "opening a note must not rewrite
    // it" (#1434) true.
    expect(updates).toEqual([])
    expect(nodeNames(fragment).filter((name) => name === 'linkMention')).toHaveLength(1)
  })

  it('heals a token a previous build mangled', () => {
    // #given the shape sitting in real vaults: a stray space before the `))`
    const { editor, fragment } = createCollaborativeEditor()
    seedWithPlainText(editor, '((mention:https%3A%2F%2Fx.test%2Fpage ))')

    // #when
    openNote(editor, fragment)

    // #then
    const content = (editor.document[0] as Block).content as Array<{
      type: string
      props?: { url?: string }
    }>
    expect(content[0].type).toBe('linkMention')
    expect(content[0].props?.url).toBe('https://x.test/page')
  })

  it('fills in the title and favicon on open, into the shared doc, with no undo step', async () => {
    // #given
    const { editor, fragment } = createCollaborativeEditor()
    seedWithPlainText(editor, serializeLinkMentionToken(URL_))

    // #when
    openNote(editor, fragment)
    await settlePreviews()

    // #then the chip is rich, other devices get it, and Cmd+Z has nothing to undo
    expect(mentionProps(editor)).toEqual([{ url: URL_, ...PREVIEW }])
    expect(fragment.toJSON()).toContain(`title="${PREVIEW.title}"`)
    const undoManager = yUndoPluginKey.getState(editor._tiptapEditor.state)?.undoManager
    expect(undoManager?.undoStack).toHaveLength(0)
  })

  it('fills in a bare mention that arrives while the note is open (#3871)', async () => {
    // #given an open note, and a restore on another replica that leaves the
    // mention as the token carries it: the URL and its domain, nothing else
    const { editor, doc, fragment } = createCollaborativeEditor()
    seedWithPlainText(editor, 'Links')
    openNote(editor, fragment)
    const remote = createCollaborativeEditor()
    Y.applyUpdate(remote.doc, Y.encodeStateAsUpdate(doc))
    remote.editor.replaceBlocks(remote.editor.document, [
      {
        type: 'paragraph',
        content: [{ type: 'linkMention', props: { url: URL_, domain: 'eksisozluk.com' } }]
      } as never
    ])

    // #when the edit reaches this replica
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote.doc))
    await settlePreviews()

    // #then
    expect(mentionProps(editor)).toEqual([{ url: URL_, ...PREVIEW }])
  })

  it('fills in again a mention an outside edit rebuilt bare for a URL it already filled (#4475)', async () => {
    // #given an open note whose chip already has its preview
    const { editor, doc, fragment } = createCollaborativeEditor()
    seedWithPlainText(editor, `Fresh: ${serializeLinkMentionToken(URL_)} one.`)
    openNote(editor, fragment)
    await settlePreviews()
    expect(mentionProps(editor)).toEqual([{ url: URL_, ...PREVIEW }])

    // #when a restore on another replica rebuilds the paragraph from the
    // token, which carries only the URL and its domain
    const remote = createCollaborativeEditor()
    Y.applyUpdate(remote.doc, Y.encodeStateAsUpdate(doc))
    remote.editor.replaceBlocks(remote.editor.document, [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Fresh: ', styles: {} },
          { type: 'linkMention', props: { url: URL_, domain: 'eksisozluk.com' } },
          { type: 'text', text: ' two.', styles: {} }
        ]
      } as never
    ])
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote.doc))
    await settlePreviews()

    // #then the chip is rich again, into the shared doc, with no undo step
    expect(mentionProps(editor)).toEqual([{ url: URL_, ...PREVIEW }])
    expect(fragment.toJSON()).toContain(`title="${PREVIEW.title}"`)
    const undoManager = yUndoPluginKey.getState(editor._tiptapEditor.state)?.undoManager
    expect(undoManager?.undoStack).toHaveLength(0)
  })

  it('writes the preview over the current content, not a copy taken before the fetch', async () => {
    // #given a preview that resolves only after the user has typed
    let resolvePreview: (value: typeof PREVIEW) => void = () => {}
    fetchLinkPreview.mockReturnValueOnce(new Promise((resolve) => (resolvePreview = resolve)))
    const { editor, fragment } = createCollaborativeEditor()
    seedWithPlainText(editor, `See ${serializeLinkMentionToken(URL_)}`)
    openNote(editor, fragment)
    editor.insertInlineContent(' typed meanwhile')

    // #when
    resolvePreview(PREVIEW)
    await settlePreviews()

    // #then
    const block = editor.document[0] as Block
    const text = (block.content as Array<{ type: string; text?: string }>)
      .map((run) => run.text ?? '')
      .join('')
    expect(text).toContain('typed meanwhile')
    expect(mentionProps(editor)).toEqual([{ url: URL_, ...PREVIEW }])
  })

  it('fills in mentions in a table cell and a nested block on the markdown path', async () => {
    // #given a note with no shared doc
    const editor = BlockNoteEditor.create({ schema: editorSchema }) as unknown as BlockNoteEditor
    const el = document.createElement('div')
    document.body.appendChild(el)
    editor.mount(el)
    const token = serializeLinkMentionToken(URL_)
    const markdown = `| Link |\n| --- |\n| ${token} |\n\n- Parent\n  - ${token}\n`

    // #when
    renderHook(() =>
      useEditorSync({
        editor,
        noteId: 'markdown-note',
        initialContent: markdown,
        contentType: 'markdown'
      })
    )

    // #then
    await waitFor(() =>
      expect(mentionProps(editor)).toEqual([
        { url: URL_, ...PREVIEW },
        { url: URL_, ...PREVIEW }
      ])
    )
    editor.unmount()
    el.remove()
  })

  it('leaves a note without a mention untouched', () => {
    // #given
    const { editor, doc, fragment } = createCollaborativeEditor()
    seedWithPlainText(editor, 'Nothing to promote here.')

    // #when
    const updates: Uint8Array[] = []
    doc.on('update', (update: Uint8Array) => updates.push(update))
    openNote(editor, fragment)

    // #then
    expect(updates).toEqual([])
  })
})
