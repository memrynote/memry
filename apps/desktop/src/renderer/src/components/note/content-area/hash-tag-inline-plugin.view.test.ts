/**
 * The hash-tag plugin on a real ProseMirror view: typing, and text an input
 * method composes and then commits, the way Korean, Japanese and Chinese
 * keyboards write. ProseMirror marks every transaction it reads from the DOM
 * mid-composition with the `composition` meta, so these tests dispatch the same.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { EditorView } from '@tiptap/pm/view'
import { createHashTagInlinePlugin } from './hash-tag-inline-plugin'

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'inline*', group: 'block', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
    hashTag: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { tag: { default: '' }, color: { default: '' } },
      toDOM: (node) => ['span', { 'data-hash-tag': node.attrs.tag }, `#${node.attrs.tag}`]
    }
  }
})

const views: EditorView[] = []

afterEach(() => {
  for (const view of views.splice(0)) {
    view.dom.remove()
    view.destroy()
  }
})

function createView(): EditorView {
  const place = document.createElement('div')
  document.body.appendChild(place)
  const view = new EditorView(place, {
    state: EditorState.create({ schema, plugins: [createHashTagInlinePlugin(() => '')] })
  })
  views.push(view)
  return view
}

function type(view: EditorView, text: string): void {
  for (const char of text) view.dispatch(view.state.tr.insertText(char))
}

/** One composition: each step replaces the text composed so far, as an IME does. */
function compose(view: EditorView, steps: string[]): void {
  const start = view.state.selection.from
  for (const step of steps) {
    const tr = view.state.tr.insertText(step, start, view.state.selection.from)
    view.dispatch(tr.setMeta('composition', 1))
  }
}

async function endComposition(view: EditorView): Promise<void> {
  view.dom.dispatchEvent(new CompositionEvent('compositionend', { data: '' }))
  await new Promise((resolve) => setTimeout(resolve))
}

/** The paragraph as `[text]` and `{tag}` runs. */
function content(view: EditorView): string {
  let out = ''
  view.state.doc.firstChild!.forEach((node) => {
    out += node.type.name === 'hashTag' ? `{${node.attrs.tag}}` : node.text
  })
  return out
}

describe('hash-tag chips on a real editor', () => {
  it('chips a tag typed in a script without an input method', () => {
    const view = createView()
    type(view, 'see #привет #हिन्दी')
    expect(content(view)).toBe('see {привет} {हिन्दी}')
  })

  it('waits for a letter in a tag that starts with a digit', () => {
    const view = createView()
    type(view, '#2024')
    expect(content(view)).toBe('#2024')
    type(view, 'q')
    expect(content(view)).toBe('{2024q}')
  })

  it('leaves composing text alone and chips the committed tag', async () => {
    const view = createView()
    type(view, '#')
    compose(view, ['ㅍ', '퓨'])
    compose(view, ['ㄹ', '리'])
    expect(content(view)).toBe('#퓨리')

    await endComposition(view)

    expect(content(view)).toBe('{퓨리}')
  })

  it('chips the tag when the commit arrives with the space that ended it', async () => {
    const view = createView()
    type(view, 'x #')
    compose(view, ['タ', 'タグ'])
    type(view, ' ')

    expect(content(view)).toBe('x {タグ} ')
    await endComposition(view)
    expect(content(view)).toBe('x {タグ} ')
  })

  it('extends a chip with committed text', async () => {
    const view = createView()
    type(view, '#a')
    compose(view, ['ㄱ', '가'])
    expect(content(view)).toBe('{a}가')

    await endComposition(view)

    expect(content(view)).toBe('{a가}')
  })
})
