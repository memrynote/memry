import { afterEach, describe, expect, it } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'
import * as Y from 'yjs'
import { withCollaborationIfLive } from './collaboration-options'

/**
 * The BlockNote 0.52 Yjs decoupling is a silent break, not a compile error:
 * `collaboration` left `BlockNoteEditorOptions`, but both editor constructors
 * infer their argument into a generic type parameter, so an options object
 * still carrying the old key satisfies the constraint and skips excess
 * property checking. It compiles, and the ySync plugin is simply never
 * installed — edits stay in the local ProseMirror doc and never become Y
 * updates, so the note's CRDT (the source of truth for a synced vault) keeps
 * its old content and the next load throws the edits away.
 *
 * Type-level assertions cannot catch that, so these tests go through a real
 * editor and read the Y.Doc.
 *
 * Uses the default BlockNote schema on purpose: the desktop schema's block
 * specs drag react-pdf into jsdom, and the binding under test is schema
 * independent.
 */

const mounted: Array<{ editor: BlockNoteEditor; el: HTMLElement }> = []

afterEach(() => {
  for (const { editor, el } of mounted.splice(0)) {
    editor.unmount()
    el.remove()
  }
})

function mount(options: Partial<Parameters<typeof BlockNoteEditor.create>[0]>): BlockNoteEditor {
  const editor = BlockNoteEditor.create(options)
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor.mount(el)
  mounted.push({ editor, el })
  return editor
}

describe('withCollaborationIfLive', () => {
  it('writes editor changes through to the Y.Doc', () => {
    // #given a note whose local CRDT doc is live, so the fragment is the
    // source of truth for the body.
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment('document-store')
    const editor = mount(withCollaborationIfLive(fragment, {}))

    // #when the user types.
    editor.insertBlocks(
      [{ type: 'paragraph', content: 'kaan was here' }],
      editor.document[0],
      'before'
    )

    // #then the text is in the CRDT, not only in the editor. Asserted on the
    // encoded state as well as the fragment so a fragment that merely holds a
    // detached node cannot pass.
    expect(fragment.toString()).toContain('kaan was here')
    const replica = new Y.Doc()
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc))
    expect(replica.getXmlFragment('document-store').toString()).toContain('kaan was here')
  })

  it('binds the same fragment a second editor already populated', () => {
    // #given the fragment a previous session left behind. ContentArea holds
    // the render until the doc is ready precisely so this content is present
    // at construction time.
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment('document-store')
    const seed = mount(withCollaborationIfLive(fragment, {}))
    seed.insertBlocks([{ type: 'paragraph', content: 'from disk' }], seed.document[0], 'before')

    // #when a fresh editor binds to it.
    const editor = mount(withCollaborationIfLive(fragment, {}))

    // #then it opens on that content rather than on an empty document. This is
    // the half that would look like data loss to a user: an unbound editor
    // starts blank and then writes the blank back over the note.
    expect(editor.document.map((block) => JSON.stringify(block.content)).join(' ')).toContain(
      'from disk'
    )
  })

  it('leaves the options untouched when no Y.Doc is live', () => {
    // #given a note with no local CRDT doc — a free, sync-off install. It must
    // still get a working editor, just an unbound one.
    const options = { setIdAttribute: true as const }

    // #when
    const result = withCollaborationIfLive(undefined, options)

    // #then no Y extensions and no forced `initialContent`, both of which
    // `withCollaboration` would have added.
    expect(result).toBe(options)
    expect(result).not.toHaveProperty('collaboration')
    expect(result).not.toHaveProperty('initialContent')
  })

  it('keeps extensions the caller already passed', () => {
    // #given `withCollaboration` builds the extension list by appending to the
    // caller's. ContentArea relies on that to keep syntax highlighting, which
    // is itself an extension from 0.51 on.
    const marker = (() => undefined) as never

    // #when
    const result = withCollaborationIfLive(new Y.Doc().getXmlFragment('document-store'), {
      extensions: [marker]
    })

    // #then
    expect(result.extensions).toContain(marker)
    expect(result.extensions!.length).toBeGreaterThan(1)
  })
})
