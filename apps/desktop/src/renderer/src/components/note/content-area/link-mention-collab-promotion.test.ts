/**
 * The other half of #1844, and the one that made the mention vanish outright.
 *
 * Main seeds the shared Y.Doc straight from the vault file, and the mention
 * spec has no text `parse` rule, so `((mention:…))` reaches the doc as plain
 * TEXT. The collaborative branch of `useEditorSync` returns before
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

import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BlockNoteEditor, type Block } from '@blocknote/core'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { serializeLinkMentionToken } from '@memry/editor-schema/inline'

vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))

const fetchLinkPreview = vi.fn().mockResolvedValue({ domain: '', title: '', favicon: '' })
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
import { useEditorSync } from './hooks/use-editor-sync'

const mounted: Array<{ editor: BlockNoteEditor; el: HTMLElement; doc: Y.Doc }> = []

afterEach(() => {
  for (const { editor, el, doc } of mounted.splice(0)) {
    ;(editor as unknown as { mount: (element?: HTMLElement) => void }).mount()
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
  renderHook(() =>
    useEditorSync({ editor, noteId: 'link-mention-promotion-note', yjsFragment: fragment })
  )
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

  it('does not fetch site metadata on this path', async () => {
    // #given
    const { editor, fragment } = createCollaborativeEditor()
    seedWithPlainText(editor, serializeLinkMentionToken(URL_))

    // #when
    openNote(editor, fragment)
    await Promise.resolve()

    // #then `hydrateLinkMentionFavicons` writes back a content array captured
    // before its fetch and resolves after the undo history is cleared. On a
    // shared document that is a stale block pushed to every device and an
    // undoable step on open, so the collaborative path leaves the chip with the
    // domain the token carries.
    expect(fetchLinkPreview).not.toHaveBeenCalled()
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
