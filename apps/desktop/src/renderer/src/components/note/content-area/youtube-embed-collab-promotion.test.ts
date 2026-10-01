/**
 * Opening a COLLABORATIVE note turns a stored YouTube image back into an embed.
 *
 * Older builds parsed another app's `![alt](youtube-url)` line as an `image`
 * block, which renders broken, and the shared Y.Doc kept it: a better parser
 * never sees that block again. `useEditorSync` promotes it on open
 * (`normalizeYoutubeImages`). Same harness as `date-mention-collab-promotion`:
 * a real editor, real Yjs collaboration, the real hook.
 */

import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'
import * as Y from 'yjs'
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

const VIDEO_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'

const mounted: Array<{ editor: BlockNoteEditor; el: HTMLElement; doc: Y.Doc }> = []

afterEach(() => {
  for (const { editor, el, doc } of mounted.splice(0)) {
    editor.unmount()
    el.remove()
    doc.destroy()
  }
})

/** A collaborative editor whose shared doc holds the image an older build stored. */
function openNoteHoldingYoutubeImage(): { editor: BlockNoteEditor; fragment: Y.XmlFragment } {
  const doc = new Y.Doc()
  const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
  const editor = BlockNoteEditor.create(
    withCollaborationIfLive(fragment, { schema: editorSchema })
  ) as unknown as BlockNoteEditor
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor.mount(el)
  mounted.push({ editor, el, doc })

  editor.replaceBlocks(editor.document, [
    { type: 'image', props: { url: VIDEO_URL, name: 'Embedded YouTube video' } } as never
  ])
  return { editor, fragment }
}

function open(editor: BlockNoteEditor, fragment: Y.XmlFragment): void {
  renderHook(() => useEditorSync({ editor, noteId: 'yt-collab-note', yjsFragment: fragment }))
}

describe('opening a collaborative note promotes a stored YouTube image', () => {
  it('replaces the image with an embed in the shared Y.Doc, keeping its alt', () => {
    const { editor, fragment } = openNoteHoldingYoutubeImage()

    // #when the note is opened and nothing else happens
    open(editor, fragment)

    // #then the CRDT holds the embed, so every device and the vault file get it
    // Y.XmlElement#toString lowercases node names.
    expect(fragment.toString()).toContain('<youtubeembed alt="Embedded YouTube video"')
    expect(fragment.toString()).not.toContain('<image')
    expect(editor.document[0]).toMatchObject({
      type: 'youtubeEmbed',
      props: { videoId: 'dQw4w9WgXcQ', videoUrl: VIDEO_URL, alt: 'Embedded YouTube video' }
    })
  })

  it('writes nothing on a second open', () => {
    const { editor, fragment } = openNoteHoldingYoutubeImage()
    open(editor, fragment)

    // #when it is opened again ("opening a note must not rewrite it", #1434)
    const updates: Uint8Array[] = []
    ;(fragment.doc as Y.Doc).on('update', (update: Uint8Array) => updates.push(update))
    open(editor, fragment)

    // #then no CRDT update at all
    expect(updates).toEqual([])
  })
})
