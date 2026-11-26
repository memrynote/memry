/**
 * The hash-tag plugin on a real ProseMirror view: typing, and text an input
 * method composes and then commits, the way Korean, Japanese and Chinese
 * keyboards write. ProseMirror marks most transactions it reads from the DOM
 * mid-composition with the `composition` meta, so these tests dispatch the same.
 * WebKit inserts each committed syllable as a plain input before compositionend
 * (recorded in the Tauri app with the macOS Korean 2-Set keyboard).
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

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 100))

function startComposition(view: EditorView): void {
  view.dom.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }))
}

function fireCompositionEnd(view: EditorView): void {
  view.dom.dispatchEvent(new CompositionEvent('compositionend', { data: '' }))
}

async function endComposition(view: EditorView): Promise<void> {
  fireCompositionEnd(view)
  await settled()
}

/** Replaces the `length` characters before the cursor, as an input method rewriting its text. */
function rewriteBeforeCursor(view: EditorView, length: number, text: string): void {
  const end = view.state.selection.from
  view.dispatch(view.state.tr.insertText(text, end - length, end))
}

/**
 * One Korean syllable as WebKit writes it: composing steps with the meta, then
 * the composed text deleted and the syllable inserted without it, then
 * compositionend.
 */
function composeSyllableAsWebKit(view: EditorView, steps: string[]): void {
  startComposition(view)
  compose(view, steps)
  const syllable = steps[steps.length - 1]
  const end = view.state.selection.from
  const start = end - syllable.length
  view.dispatch(view.state.tr.delete(start, end).setMeta('composition', 1))
  view.dispatch(view.state.tr.insertText(syllable, start))
  fireCompositionEnd(view)
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

  it('reads a WebKit commit only once the word settles', async () => {
    const view = createView()
    type(view, 'x #')
    composeSyllableAsWebKit(view, ['ㅍ', '퓨'])
    composeSyllableAsWebKit(view, ['ㄹ', '리'])
    expect(content(view)).toBe('x #퓨리')

    await settled()

    expect(content(view)).toBe('x {퓨리}')
  })

  it('chips a WebKit commit ended by a space', async () => {
    const view = createView()
    type(view, '#')
    composeSyllableAsWebKit(view, ['ㅍ', '퓨'])
    composeSyllableAsWebKit(view, ['ㄹ', '리'])
    type(view, ' ')

    expect(content(view)).toBe('{퓨리} ')
    await settled()
    expect(content(view)).toBe('{퓨리} ')
  })

  it('leaves a jamo the Korean input method typed as plain text for it to take back', async () => {
    const view = createView()
    type(view, '#')
    // The first jamo arrives as plain text, then the next key composes it into a syllable.
    type(view, 'ㅍ')
    expect(content(view)).toBe('#ㅍ')
    startComposition(view)
    const end = view.state.selection.from
    view.dispatch(view.state.tr.insertText('퓨', end - 1, end).setMeta('composition', 1))
    fireCompositionEnd(view)
    composeSyllableAsWebKit(view, ['ㄹ', '리'])

    await settled()

    expect(content(view)).toBe('{퓨리}')
  })

  it('chips a Korean word the input method rewrites without composing once a space ends it', () => {
    const view = createView()
    type(view, 'x #')
    // Each key rewrites the text before the cursor, with no composition events.
    type(view, 'ㅍ')
    rewriteBeforeCursor(view, 1, '퓨')
    rewriteBeforeCursor(view, 1, '퓰')
    rewriteBeforeCursor(view, 1, '퓨리')
    expect(content(view)).toBe('x #퓨리')

    type(view, ' ')

    expect(content(view)).toBe('x {퓨리} ')
  })

  it('chips a Korean word that Enter ends on the line above', () => {
    const view = createView()
    type(view, '#')
    type(view, 'ㅌ')
    rewriteBeforeCursor(view, 1, '태')
    rewriteBeforeCursor(view, 1, '태그')

    view.dispatch(view.state.tr.split(view.state.selection.from))

    expect(content(view)).toBe('{태그}')
    expect(view.state.doc.childCount).toBe(2)
  })

  it('extends a chip with a Korean word once a space ends it', () => {
    const view = createView()
    type(view, '#fuy')
    type(view, 'ㄱ')
    rewriteBeforeCursor(view, 1, '가')
    expect(content(view)).toBe('{fuy}가')

    type(view, ' ')

    expect(content(view)).toBe('{fuy가} ')
  })

  it('chips a committed tag of jamo alone', async () => {
    const view = createView()
    type(view, '#')
    composeSyllableAsWebKit(view, ['ㅋ'])
    composeSyllableAsWebKit(view, ['ㅋ'])

    await settled()

    expect(content(view)).toBe('{ㅋㅋ}')
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
