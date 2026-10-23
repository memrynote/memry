// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { Schema } from 'prosemirror-model'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { ySyncPlugin } from 'y-prosemirror'

// `leaf` exists in the schema but fits nowhere in a doc, so rebuilding the
// editor from the Y fragment drops it: the Y side counts positions the editor
// does not have. A selection near the end of the note then maps past the end.
const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*', toDOM: () => ['p', 0] },
    leaf: {},
    text: {}
  }
})

function paragraph(text: string): Y.XmlElement {
  const element = new Y.XmlElement('paragraph')
  element.insert(0, [new Y.XmlText(text)])
  return element
}

describe('y-prosemirror remote update (BBF-120)', () => {
  let view: EditorView | null = null
  afterEach(() => view?.destroy())

  it('applies a remote update when the restored selection maps past the end of the doc', async () => {
    const remote = new Y.Doc()
    const remoteFragment = remote.getXmlFragment('prosemirror')
    remoteFragment.insert(0, [paragraph('hi'), paragraph('x'.repeat(300))])
    const local = new Y.Doc()
    Y.applyUpdate(local, Y.encodeStateAsUpdate(remote))

    view = new EditorView(document.createElement('div'), {
      state: EditorState.create({
        schema,
        plugins: [ySyncPlugin(local.getXmlFragment('prosemirror'))]
      })
    })
    // ySyncPlugin renders the fragment on a timeout.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const end = view.state.doc.content.size - 1
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)))

    remote.transact(() => {
      remoteFragment.insert(0, [
        new Y.XmlElement('leaf'),
        new Y.XmlElement('leaf'),
        new Y.XmlElement('leaf')
      ])
      ;((remoteFragment.get(3) as Y.XmlElement).get(0) as Y.XmlText).insert(2, '!')
    })

    expect(() =>
      Y.applyUpdate(local, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(local)), 'remote')
    ).not.toThrow()
    expect(view.state.doc.firstChild?.textContent).toBe('hi!')
    expect(view.state.selection.anchor).toBeLessThanOrEqual(view.state.doc.content.size)
  })
})
