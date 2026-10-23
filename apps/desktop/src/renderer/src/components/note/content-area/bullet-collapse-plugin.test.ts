import { afterEach, describe, expect, it } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'
import {
  BULLET_COLLAPSE_PLUGIN_KEY,
  BULLET_TOGGLE_CLASS,
  COLLAPSED_CHILDREN_CLASS,
  createBulletCollapsePlugin,
  findCollapsibleBlocks
} from './bullet-collapse-plugin'

// Against a real mounted editor, for the same reason
// `list-type-conversion.integration.test.ts` is: the whole feature is a widget
// decoration plus a DOM event handler, and neither exists without a view. The
// default schema is enough — `bulletListItem` and `blockGroup` are BlockNote's
// own nodes, not Memry's.

const mounted: Array<{ editor: BlockNoteEditor; el: HTMLElement }> = []

afterEach(() => {
  for (const { editor, el } of mounted.splice(0)) {
    editor.unmount()
    el.remove()
  }
})

const LABELS = {
  expand: 'Expand nested items',
  collapse: 'Collapse nested items',
  expandSection: 'Expand section',
  collapseSection: 'Collapse section'
}

type Content = NonNullable<Parameters<typeof BlockNoteEditor.create>[0]>['initialContent']

function mountEditor(
  initialContent: Content = [
    {
      type: 'bulletListItem',
      content: 'Parent',
      children: [
        { type: 'bulletListItem', content: 'Child one' },
        { type: 'bulletListItem', content: 'Child two' }
      ]
    },
    { type: 'bulletListItem', content: 'Leaf' },
    { type: 'paragraph', content: 'Prose', children: [{ type: 'paragraph', content: 'Nested' }] }
  ]
): BlockNoteEditor {
  const editor = BlockNoteEditor.create({ initialContent })
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor.mount(el)
  // oxlint-disable-next-line typescript/no-explicit-any
  ;(editor as any)._tiptapEditor.registerPlugin(createBulletCollapsePlugin(LABELS))
  mounted.push({ editor, el })
  return editor
}

function toggles(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>(`.${BULLET_TOGGLE_CLASS}`)]
}

function view(editor: BlockNoteEditor) {
  // oxlint-disable-next-line typescript/no-explicit-any
  return (editor as any)._tiptapEditor.view
}

function collapsedIds(editor: BlockNoteEditor): string[] {
  return [...(BULLET_COLLAPSE_PLUGIN_KEY.getState(view(editor).state)?.collapsed ?? [])]
}

function click(button: HTMLElement): void {
  button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
}

describe('findCollapsibleBlocks', () => {
  it('finds bullets with children and nothing else', () => {
    const editor = mountEditor()
    const found = findCollapsibleBlocks(view(editor).state.doc)

    // The nested paragraph has children too — only bullets fold.
    expect(found).toHaveLength(1)
    expect(found[0].id).toBe(editor.document[0].id)
  })
})

describe('bullet collapse plugin', () => {
  it('renders one chevron, on the bullet that has children', () => {
    const editor = mountEditor()
    const buttons = toggles(mounted[0].el)

    expect(buttons).toHaveLength(1)
    expect(buttons[0].getAttribute('data-block-id')).toBe(editor.document[0].id)
    expect(buttons[0].getAttribute('data-collapsed')).toBe('false')
    expect(buttons[0].getAttribute('aria-label')).toBe(LABELS.collapse)
  })

  it('hides the nested group on mousedown and shows it again on the next one', () => {
    const editor = mountEditor()
    const parentId = editor.document[0].id

    click(toggles(mounted[0].el)[0])
    expect(collapsedIds(editor)).toEqual([parentId])
    expect(mounted[0].el.querySelectorAll(`.${COLLAPSED_CHILDREN_CLASS}`)).toHaveLength(1)
    expect(toggles(mounted[0].el)[0].getAttribute('data-collapsed')).toBe('true')
    expect(toggles(mounted[0].el)[0].getAttribute('aria-label')).toBe(LABELS.expand)

    click(toggles(mounted[0].el)[0])
    expect(collapsedIds(editor)).toEqual([])
    expect(mounted[0].el.querySelectorAll(`.${COLLAPSED_CHILDREN_CLASS}`)).toHaveLength(0)
  })

  it('never writes the fold to the document', () => {
    const editor = mountEditor()
    const before = JSON.stringify(editor.document)

    click(toggles(mounted[0].el)[0])

    expect(JSON.stringify(editor.document)).toBe(before)
  })

  it('forgets a fold once the bullet has no children left', () => {
    const editor = mountEditor()
    const parentId = editor.document[0].id
    click(toggles(mounted[0].el)[0])
    expect(collapsedIds(editor)).toEqual([parentId])

    for (const child of editor.document[0].children) editor.removeBlocks([child])

    expect(collapsedIds(editor)).toEqual([])
    expect(toggles(mounted[0].el)).toHaveLength(0)
  })
})

// The issue's own example (#3198): H1, text, H2, text, H1.
function mountSections(): BlockNoteEditor {
  return mountEditor([
    { type: 'heading', props: { level: 1 }, content: 'One' },
    { type: 'paragraph', content: 'Text one' },
    { type: 'heading', props: { level: 2 }, content: 'Two' },
    { type: 'paragraph', content: 'Text two' },
    { type: 'heading', props: { level: 1 }, content: 'Three' }
  ])
}

function visibleText(el: HTMLElement): string[] {
  return [...el.querySelectorAll<HTMLElement>('.bn-block-outer')]
    .filter((outer) => !outer.closest(`.${COLLAPSED_CHILDREN_CLASS}`))
    .map((outer) => outer.querySelector('.bn-inline-content')?.textContent ?? '')
}

describe('heading section fold', () => {
  it('folds everything up to the next heading of the same level', () => {
    const editor = mountSections()
    const el = mounted[0].el
    const [h1, , h2] = editor.document

    // H1 and H2 have sections; the trailing H1 has none.
    expect(toggles(el).map((b) => b.getAttribute('data-block-id'))).toEqual([h1.id, h2.id])
    expect(toggles(el)[0].getAttribute('aria-label')).toBe(LABELS.collapseSection)

    click(toggles(el)[0])
    expect(visibleText(el)).toEqual(['One', 'Three'])
    expect(toggles(el)[0].getAttribute('aria-label')).toBe(LABELS.expandSection)

    click(toggles(el)[0])
    expect(visibleText(el)).toEqual(['One', 'Text one', 'Two', 'Text two', 'Three'])
  })

  it('folds a lower heading without touching the higher one after it', () => {
    const editor = mountSections()
    const el = mounted[0].el

    click(
      el.querySelector<HTMLElement>(
        `[data-block-id="${editor.document[2].id}"].${BULLET_TOGGLE_CLASS}`
      )!
    )

    expect(visibleText(el)).toEqual(['One', 'Text one', 'Two', 'Three'])
  })

  it('never writes the fold to the document', () => {
    const editor = mountSections()
    const before = JSON.stringify(editor.document)

    click(toggles(mounted[0].el)[0])

    expect(JSON.stringify(editor.document)).toBe(before)
  })

  it('moves the caret out of a section it hides', () => {
    const editor = mountSections()
    const [h1, text] = editor.document
    editor.setTextCursorPosition(text.id, 'end')

    click(toggles(mounted[0].el)[0])

    expect(editor.getTextCursorPosition().block.id).toBe(h1.id)
  })

  it('skips toggleable headings, which fold through their own prop', () => {
    mountEditor([
      { type: 'heading', props: { level: 1, isToggleable: true }, content: 'Toggle' },
      { type: 'paragraph', content: 'After' }
    ])

    expect(toggles(mounted[0].el)).toHaveLength(0)
  })
})
