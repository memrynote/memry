/**
 * Opening a COLLABORATIVE note turns `((date:…))` back into a date pill (#1845).
 *
 * The same gap `wiki-link-collab-promotion.test.ts` and
 * `inline-checkbox-collab-promotion.test.ts` cover, for the node where it costs
 * the user the most. `useEditorSync`'s load effect returns early once a Y.Doc
 * fragment is bound, so `normalizeNoteBlocks` runs on the markdown path only —
 * and a date token carries no readable fallback, so a note whose CRDT doc was
 * rebuilt from disk opened showing a base64 run where the date had been.
 *
 * Nothing is faked between the editor and the CRDT: a REAL `BlockNoteEditor` on
 * the REAL `editorSchema`, mounted, with REAL Yjs collaboration against a REAL
 * `Y.Doc`, and the REAL hook whose load effect does the promoting. Only main's
 * `markdownToYFragment` is stood in for — the fragment is seeded with the shape
 * that parser produces (one plain text run), because importing `src/main` here
 * would drag `node:crypto`, `electron-log` and both databases into jsdom.
 */

import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BlockNoteEditor, type Block } from '@blocknote/core'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { serializeDateMentionToken, type DateMentionData } from '@memry/shared/date-mention'

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

const reminder: DateMentionData = {
  anchorId: 'dm_5a0b9c1e-2d3f-4a5b-8c7d-9e0f1a2b3c4d',
  dateISO: '2026-06-20T09:00:00.000Z',
  hasTime: true,
  dateFormat: 'full',
  remind: '1h',
  timeFormat: '24h'
}

const legacyEncode = (obj: unknown): string =>
  btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** A base64url run as a markdown escaper would have left it. */
const markdownEscaped = (run: string): string =>
  [...run].map((c) => (c === '_' || c === '-' ? `\\${c}` : c)).join('')

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
function seedParagraph(editor: BlockNoteEditor, text: string): void {
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

function runs(editor: BlockNoteEditor): Array<Record<string, unknown>> {
  return (editor.document[0] as Block).content as unknown as Array<Record<string, unknown>>
}

function openNote(editor: BlockNoteEditor, fragment: Y.XmlFragment): void {
  renderHook(() => useEditorSync({ editor, noteId: 'date-collab-note', yjsFragment: fragment }))
}

describe('opening a collaborative note promotes its date pills', () => {
  it('turns a token back into a pill in the shared Y.Doc', () => {
    // #given the shared doc as main leaves it: the reminder is text, and its
    // text is base64 — the reported "I have no idea what the date was"
    const { editor, fragment } = createCollaborativeEditor()
    seedParagraph(editor, `Ship it ${serializeDateMentionToken(reminder)} please`)
    expect(nodeNames(fragment)).not.toContain('dateMention')

    // #when the note is opened and nothing else happens — no keystroke
    openNote(editor, fragment)

    // #then the promotion reached the CRDT, not just the local editor state
    expect(nodeNames(fragment)).toContain('dateMention')
    expect(runs(editor)).toEqual([
      { type: 'text', text: 'Ship it ', styles: {} },
      { type: 'dateMention', props: reminder },
      { type: 'text', text: ' please', styles: {} }
    ])
  })

  it('promotes a token written by the old base64url writer', () => {
    // #given the bytes a vault written before the alphabet closed still holds
    const { editor, fragment } = createCollaborativeEditor()
    const legacy = { ...reminder, anchorId: 'dm_0?x' }
    seedParagraph(editor, `((date:${legacyEncode(legacy)}))`)

    openNote(editor, fragment)

    expect(runs(editor)).toEqual([{ type: 'dateMention', props: legacy }])
  })

  it('promotes a token a markdown escaper backslashed', () => {
    const { editor, fragment } = createCollaborativeEditor()
    const legacy = { ...reminder, anchorId: 'dm_0?x' }
    const escaped = markdownEscaped(legacyEncode(legacy))
    seedParagraph(editor, `((date:${escaped}))`)

    openNote(editor, fragment)

    expect(runs(editor)).toEqual([{ type: 'dateMention', props: legacy }])
  })

  it('degrades a token the parser refuses to a readable date', () => {
    // #given a pre-`remind`-enum token: it arms nothing and never has, but the
    // date it was scheduled for is still in there
    const { editor, fragment } = createCollaborativeEditor()
    const preEnum = {
      anchorId: 'dm_old',
      dateISO: '2026-06-20T09:00:00.000Z',
      hasTime: true,
      dateFormat: 'full',
      remind: true,
      lead: '1h'
    }
    seedParagraph(editor, `((date:${legacyEncode(preEnum)}))`)

    openNote(editor, fragment)

    // #then a plain date pill, not two hundred characters of base64
    expect(runs(editor)).toEqual([
      {
        type: 'dateMention',
        props: {
          anchorId: 'dm_old',
          dateISO: '2026-06-20T09:00:00.000Z',
          hasTime: true,
          dateFormat: 'full',
          remind: 'none',
          timeFormat: 'system'
        }
      }
    ])
  })

  it('leaves a token with no recoverable date exactly as the user has it', () => {
    // #given bytes nothing can be made of. Destroying them would be worse than
    // showing them, so the pass declines.
    const { editor, fragment } = createCollaborativeEditor()
    seedParagraph(editor, '((date:notavalidpayload))')

    openNote(editor, fragment)

    expect(nodeNames(fragment)).not.toContain('dateMention')
    expect(runs(editor)).toEqual([{ type: 'text', text: '((date:notavalidpayload))', styles: {} }])
  })

  it('promotes once and writes nothing on a second open', () => {
    // #given a note opened once already — the shared doc now holds the node
    const { editor, fragment } = createCollaborativeEditor()
    seedParagraph(editor, serializeDateMentionToken(reminder))
    openNote(editor, fragment)
    expect(nodeNames(fragment)).toContain('dateMention')

    // #when it is opened again. "Opening a note must not rewrite it" (#1434):
    // a promoted node leaves no `((date:` text behind, so the pass finds nothing.
    const updates: Uint8Array[] = []
    const doc = fragment.doc as Y.Doc
    doc.on('update', (update: Uint8Array) => updates.push(update))
    openNote(editor, fragment)

    // #then no CRDT update at all — not a no-op update, none
    expect(updates).toEqual([])
  })
})
