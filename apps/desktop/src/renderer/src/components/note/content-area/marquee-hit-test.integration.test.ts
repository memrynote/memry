import { afterEach, describe, expect, it } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'
import { hasSelectableTextAt, shouldStartMarquee } from './marquee-hit-test'

/**
 * The marquee start rule reads BlockNote's own markup, so the fixtures in
 * `use-block-marquee-selection.test.tsx` are only as true as our reading of it.
 * These run the predicates against a real mounted editor instead, which is what
 * turns the TRIPWIRE note in `marquee-hit-test.ts` from a comment into a test:
 * rename `.bn-inline-content` upstream, or change how a cell renders, and this
 * file fails rather than text selection quietly dying in the app.
 *
 * Uses the default BlockNote schema — it already carries paragraphs and tables,
 * and the custom schema's extra specs drag react-pdf into jsdom.
 */

const mounted: Array<{ editor: BlockNoteEditor; el: HTMLElement }> = []

afterEach(() => {
  for (const { editor, el } of mounted.splice(0)) {
    editor.unmount()
    el.remove()
  }
})

const DEFAULT_CONTENT = [
  { type: 'paragraph', content: 'Intro' },
  {
    type: 'table',
    content: {
      type: 'tableContent',
      headerRows: 1,
      rows: [{ cells: ['Task', 'Owner'] }, { cells: ['Ship it', 'Kaan'] }]
    }
  }
]

function mountEditor(initialContent: unknown[] = DEFAULT_CONTENT): HTMLElement {
  const editor = BlockNoteEditor.create({ initialContent: initialContent as never })
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor.mount(el)
  mounted.push({ editor, el })
  return el
}

function query(root: HTMLElement, selector: string): Element {
  const found = root.querySelector(selector)
  if (!found) throw new Error(`the editor rendered no ${selector}`)
  return found
}

describe('marquee hit-testing against real BlockNote markup', () => {
  it('reads a paragraph line as text', () => {
    const root = mountEditor()
    const line = query(root, '.bn-block-content[data-content-type="paragraph"] .bn-inline-content')

    expect(line.textContent).toBe('Intro')
    expect(hasSelectableTextAt(line)).toBe(true)
  })

  it('reads a table cell as text even though it carries no inline-content class', () => {
    const root = mountEditor()
    const cell = query(root, 'td')
    const cellParagraph = query(root, 'td p')

    // The markup this rule exists for. If either assertion starts failing, the
    // cell rule in `hasSelectableTextAt` may have become unnecessary — or may
    // have started missing cells. Check before deleting it.
    expect(cellParagraph.className).toBe('')
    expect(cell.querySelector('.bn-inline-content')).toBeNull()

    for (const target of [cell, cellParagraph, query(root, 'th')]) {
      expect(hasSelectableTextAt(target)).toBe(true)
    }
  })

  it('still lets a marquee start beside the table', () => {
    const root = mountEditor()
    const table = query(root, '.bn-block-content[data-content-type="table"]')

    // The block box outside any cell — the margin the table is selected from.
    // A table has to stay marquee-selectable as a whole block.
    expect(hasSelectableTextAt(table)).toBe(false)
    expect(shouldStartMarquee(table)).toBe(true)
  })

  it('leaves a drag on an image resize handle to the resize, top-level or nested', () => {
    const url = 'memry-file://local/v/attachments/n/diagram.png'
    const image = { type: 'image', props: { url, previewWidth: 600 } }
    const root = mountEditor([
      image,
      { type: 'bulletListItem', content: 'Screenshots', children: [image] }
    ])
    const images = root.querySelectorAll('.bn-block-content[data-content-type="image"]')
    expect(images).toHaveLength(2)

    for (const block of images) {
      const handles = block.querySelectorAll('.bn-resize-handle')
      expect(handles).toHaveLength(2)
      for (const handle of handles) {
        expect(hasSelectableTextAt(handle)).toBe(false)
        expect(shouldStartMarquee(handle)).toBe(false)
      }
      // The picture itself still starts one: that is how an image is
      // marquee-selected as a block.
      expect(shouldStartMarquee(query(block as HTMLElement, 'img'))).toBe(true)
    }
  })

  it('leaves a press on a portaled menu or listbox option to that menu', () => {
    // The drag-handle menu, its Turn into submenu and the toolbar's block type
    // dropdown all portal into the editor's portal element, inside the marquee
    // zone. Starting a marquee there cleared the block selection Turn into
    // reads when its item runs.
    const root = document.createElement('div')
    root.innerHTML = `
      <div role="menu"><div role="menuitem"><span>Heading 2</span></div></div>
      <div class="bn-menu-dropdown"><span>Duplicate</span></div>
      <div role="listbox"><div role="option"><span>Heading 5</span></div></div>
    `
    document.body.appendChild(root)
    try {
      for (const span of root.querySelectorAll('span')) {
        expect(shouldStartMarquee(span)).toBe(false)
      }
    } finally {
      root.remove()
    }
  })
})
