// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GuestMsg, HostMsg } from '@memry/contracts/webview-bridge'

import { createMobileEditorSchema } from '../../editor-web/src/schema'
import type { SchemaLikeForCaps } from '../../editor-web/src/block-capabilities'
import type { ActionBlockLike } from '../../editor-web/src/block-actions'
import {
  installBlockMenu,
  type BlockMenuBridge,
  type BlockMenuController,
  type BlockMenuEditorSurface
} from '../../editor-web/src/block-menu'
import {
  installBlockActionsPanel,
  type BlockActionsPanelController
} from '../../editor-web/src/block-actions-panel'

/**
 * The two entry points, the highlight, and the move round trip (#2100).
 *
 * Driven through the REAL panel, the guest's own block-actions sheet, because
 * a fake one would assert wiring the design chose not to write. The editor and
 * the bridge are stubs; the schema is the real one, so the capabilities the
 * panel draws from are the app's.
 */

const DOC_ID = 'note-1'

interface StubBlock extends ActionBlockLike {
  content: unknown
  children?: readonly unknown[]
}

function paragraph(id: string, text: string): StubBlock {
  return {
    id,
    type: 'paragraph',
    props: { textColor: 'default', backgroundColor: 'default', textAlignment: 'left' },
    content: [{ type: 'text', text, styles: {} }]
  }
}

function image(id: string): StubBlock {
  return {
    id,
    type: 'image',
    props: { url: 'attachments/note-1/a.png', backgroundColor: 'default' },
    content: undefined
  }
}

/**
 * The block DOM BlockNote lays out, verified against a mounted editor in
 * `block-menu-real-editor.test.ts`: ProseMirror's editable ROOT carries
 * `contenteditable="true"` and nothing below it carries the attribute at all —
 * an image's content div included. Fabricating a `contenteditable="false"` on
 * the atom here would let a gate that rejects every real press look correct.
 */
function mountBlocks(root: HTMLElement, blocks: readonly StubBlock[]): void {
  const editable = document.createElement('div')
  editable.className = 'bn-editor'
  editable.setAttribute('contenteditable', 'true')
  for (const block of blocks) {
    const outer = document.createElement('div')
    outer.className = 'bn-block-outer'
    outer.dataset.id = block.id
    const inner = document.createElement('div')
    inner.className = 'bn-block'
    inner.dataset.id = block.id
    const content = document.createElement('div')
    content.className = 'bn-block-content'
    content.dataset.contentType = block.type
    if (block.type === 'image') content.appendChild(document.createElement('img'))
    else content.appendChild(document.createTextNode('Text'))
    inner.appendChild(content)
    outer.appendChild(inner)
    editable.appendChild(outer)
  }
  root.replaceChildren(editable)
}

function contentOf(root: HTMLElement, id: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(
    `.bn-block-outer[data-id="${id}"] .bn-block-content`
  )
  if (!element) throw new Error(`Missing block content: ${id}`)
  return element
}

function press(target: HTMLElement, x = 100, y = 100): void {
  target.dispatchEvent(
    new PointerEvent('pointerdown', { button: 0, clientX: x, clientY: y, bubbles: true })
  )
}

function move(target: HTMLElement, x: number, y: number): void {
  target.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true }))
}

function button(name: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find(
    (candidate) => candidate.getAttribute('aria-label') === name
  )
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing button: ${name}`)
  return match
}

function highlighted(root: HTMLElement): string[] {
  return [...root.querySelectorAll('[data-memry-block-action]')].map(
    (element) => (element as HTMLElement).dataset.id ?? ''
  )
}

interface Harness {
  root: HTMLElement
  menu: BlockMenuController
  panel: BlockActionsPanelController
  blocks: Map<string, StubBlock>
  sent: GuestMsg[]
  deliver(msg: HostMsg): void
  removeBlocks: ReturnType<typeof vi.fn>
  updateBlock: ReturnType<typeof vi.fn>
  caret: { id: string }
}

function harness(initial: readonly StubBlock[]): Harness {
  document.body.replaceChildren()
  const root = document.createElement('div')
  root.id = 'root'
  const panelHost = document.createElement('div')
  document.body.append(root, panelHost)
  mountBlocks(root, initial)

  const blocks = new Map(initial.map((block) => [block.id, block]))
  const caret = { id: initial[0]?.id ?? '' }
  const removeBlocks = vi.fn((targets: ActionBlockLike[]) => {
    for (const target of targets) {
      blocks.delete(target.id)
      root.querySelector(`.bn-block-outer[data-id="${target.id}"]`)?.remove()
    }
  })
  const updateBlock = vi.fn()
  const editor: BlockMenuEditorSurface = {
    schema: createMobileEditorSchema() as unknown as SchemaLikeForCaps,
    getBlock: (id) => blocks.get(id),
    getTextCursorPosition: () => ({ block: { id: caret.id } }),
    insertBlocks: vi.fn(),
    removeBlocks,
    updateBlock
  }

  const sent: GuestMsg[] = []
  let hostListener: ((msg: HostMsg) => void) | null = null
  const bridge: BlockMenuBridge = {
    send: (msg) => void sent.push(msg),
    flush: vi.fn(),
    onHostMsg: (listener) => {
      hostListener = listener
      return () => {
        hostListener = null
      }
    }
  }

  let menu: BlockMenuController | null = null
  const panel = installBlockActionsPanel(panelHost, root, {
    blockAction: (blockId, action) => menu?.run(blockId, action)
  })
  menu = installBlockMenu({ root, editor, panel, bridge, docId: DOC_ID })

  return {
    root,
    menu,
    panel,
    blocks,
    sent,
    deliver: (msg) => hostListener?.(msg),
    removeBlocks,
    updateBlock,
    caret
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/**
 * Lay the document out: jsdom measures everything as zero, and the whole point
 * of the scroll is a comparison between two boxes.
 */
function stubLayout(rects: Readonly<Record<string, { top: number; height: number }>>): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element
  ): DOMRect {
    const key = Object.keys(rects).find((selector) => this.matches(selector))
    const box = key ? rects[key] : { top: 0, height: 0 }
    return {
      ...box,
      bottom: box.top + box.height,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: box.top
    }.valueOf() as DOMRect
  })
}

function stubScrollBy(): ReturnType<typeof vi.fn> {
  const scrollBy = vi.fn()
  vi.spyOn(window, 'scrollBy').mockImplementation(scrollBy)
  return scrollBy
}

describe('bringing the addressed block clear of the panel', () => {
  // jsdom's viewport. The panel eats the bottom of it, so a block below
  // `innerHeight - panel - margin` has to come up by the difference.
  const VIEWPORT = window.innerHeight

  it('scrolls by the panel it is about to be covered by, not by the keyboard var', () => {
    const app = harness([image('img1')])
    // The long-press path: the keyboard has never been up, so the host's
    // measurement is still 0. Measuring the RENDERED panel is the only number
    // available, and it is the one that matters.
    document.documentElement.style.setProperty('--memry-keyboard-height', '0px')
    stubLayout({
      '.bn-block-outer': { top: VIEWPORT - 68, height: 60 },
      '.editor-block-actions-shell': { top: VIEWPORT - 300, height: 300 }
    })
    const scrollBy = stubScrollBy()

    press(contentOf(app.root, 'img1'))
    vi.advanceTimersByTime(450)

    expect(document.querySelector('.editor-block-actions')).not.toBeNull()
    // block bottom (VIEWPORT - 8) minus the lowest visible line (VIEWPORT - 300 - 12).
    expect(scrollBy).toHaveBeenCalledWith({ top: 304, behavior: 'smooth' })
  })

  it('leaves the note alone when the block is already clear of the panel', () => {
    const app = harness([image('img1')])
    stubLayout({
      '.bn-block-outer': { top: 100, height: 60 },
      '.editor-block-actions-shell': { top: VIEWPORT - 300, height: 300 }
    })
    const scrollBy = stubScrollBy()

    press(contentOf(app.root, 'img1'))
    vi.advanceTimersByTime(450)

    expect(document.querySelector('.editor-block-actions')).not.toBeNull()
    expect(scrollBy).not.toHaveBeenCalled()
  })

  it('honours the reader who asked for less motion', () => {
    const app = harness([image('img1')])
    document.documentElement.classList.add('reduced-motion')
    stubLayout({
      '.bn-block-outer': { top: VIEWPORT - 68, height: 60 },
      '.editor-block-actions-shell': { top: VIEWPORT - 300, height: 300 }
    })
    const scrollBy = stubScrollBy()

    press(contentOf(app.root, 'img1'))
    vi.advanceTimersByTime(450)

    expect(scrollBy).toHaveBeenCalledWith({ top: 304, behavior: 'auto' })
    document.documentElement.classList.remove('reduced-motion')
  })
})

describe('long-press', () => {
  it('opens the panel for an image only once the press has been held', () => {
    const app = harness([paragraph('p1', 'Words'), image('img1')])

    press(contentOf(app.root, 'img1'))
    vi.advanceTimersByTime(449)
    expect(document.querySelector('.editor-block-actions')).toBeNull()

    vi.advanceTimersByTime(1)

    // The panel is the image's, while the caret is still in the paragraph.
    expect(document.querySelector('[aria-label="Image"]')).not.toBeNull()
    // `image`'s propSchema has `backgroundColor` and no `textColor`.
    expect(button('Highlight: red')).toBeInstanceOf(HTMLButtonElement)
    expect(document.querySelector('[aria-label="Text colour: red"]')).toBeNull()
    // An attachment's bytes live under the source note's id, so it cannot move.
    expect(document.querySelector('[aria-label="Move to another note…"]')).toBeNull()
    expect(button('Duplicate')).toBeInstanceOf(HTMLButtonElement)
    expect(button('Delete')).toBeInstanceOf(HTMLButtonElement)
  })

  it('leaves a paragraph to the loupe', () => {
    const app = harness([paragraph('p1', 'Words'), image('img1')])

    press(contentOf(app.root, 'p1'))
    vi.advanceTimersByTime(1000)

    expect(document.querySelector('.editor-block-actions')).toBeNull()
    expect(highlighted(app.root)).toEqual([])
  })

  it('cancels once the finger has travelled past the tolerance', () => {
    const app = harness([image('img1')])
    const content = contentOf(app.root, 'img1')

    press(content, 100, 100)
    move(content, 104, 108)
    vi.advanceTimersByTime(200)
    // Still within 10 px: a finger never sits perfectly still.
    move(content, 100, 118)
    vi.advanceTimersByTime(1000)

    expect(document.querySelector('.editor-block-actions')).toBeNull()
  })

  it('cancels when the press ends, and when the page scrolls under it', () => {
    const app = harness([image('img1')])
    const content = contentOf(app.root, 'img1')

    press(content)
    content.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    vi.advanceTimersByTime(1000)
    expect(document.querySelector('.editor-block-actions')).toBeNull()

    press(content)
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(1000)
    expect(document.querySelector('.editor-block-actions')).toBeNull()
  })
})

describe('the highlight', () => {
  it('rings the addressed block while the panel is up and clears it on Done', () => {
    const app = harness([paragraph('p1', 'Words'), image('img1')])

    press(contentOf(app.root, 'img1'))
    vi.advanceTimersByTime(450)
    expect(highlighted(app.root)).toEqual(['img1'])

    button('Done').click()

    expect(document.querySelector('.editor-block-actions')).toBeNull()
    expect(highlighted(app.root)).toEqual([])
  })

  it('rings exactly one block, and stops ringing when the menu is torn down', () => {
    const app = harness([image('img1'), image('img2')])

    press(contentOf(app.root, 'img1'))
    vi.advanceTimersByTime(450)
    press(contentOf(app.root, 'img2'))
    vi.advanceTimersByTime(450)
    expect(highlighted(app.root)).toEqual(['img2'])

    app.menu.destroy()
    expect(highlighted(app.root)).toEqual([])
  })

  it('drops the panel and the ring when the note goes read-only', () => {
    const app = harness([image('img1')])

    press(contentOf(app.root, 'img1'))
    vi.advanceTimersByTime(450)
    // Both halves, because `applyCfg` sets both: the panel closes itself
    // panel and the menu drops what the panel was about.
    app.panel.setReadOnly(true)
    app.menu.setReadOnly(true)

    expect(document.querySelector('.editor-block-actions')).toBeNull()
    expect(highlighted(app.root)).toEqual([])

    app.menu.openForCaret()
    expect(document.querySelector('.editor-block-actions')).toBeNull()
  })
})

describe('the move round trip', () => {
  function openMoveFor(id: string): Harness {
    const app = harness([paragraph('p1', 'Words'), paragraph('p2', 'Other')])
    app.caret.id = id
    app.menu.openForCaret()
    button('Move to another note…').click()
    return app
  }

  it('asks the host and keeps the ring up until the answer lands', () => {
    const app = openMoveFor('p1')

    expect(app.sent).toEqual([
      { type: 'block-move-request', reqId: 'bm1', docId: DOC_ID, blockId: 'p1', label: 'Paragraph' }
    ])
    // The picker is a native Modal over the whole screen, so the panel goes —
    // but the ring stays, because the reader has to know which block travels.
    expect(document.querySelector('.editor-block-actions')).toBeNull()
    expect(highlighted(app.root)).toEqual(['p1'])
    // Nothing is removed yet: the source goes only once the copy is durable.
    expect(app.removeBlocks).not.toHaveBeenCalled()
  })

  it('removes the source block when the host says the copy is durable', () => {
    const app = openMoveFor('p1')

    app.deliver({
      type: 'block-move-result',
      reqId: 'bm1',
      docId: DOC_ID,
      blockId: 'p1',
      result: { status: 'moved', targetTitle: 'Recipes' }
    })

    expect(app.removeBlocks).toHaveBeenCalledWith([expect.objectContaining({ id: 'p1' })])
    expect(app.blocks.has('p1')).toBe(false)
    expect(highlighted(app.root)).toEqual([])
  })

  it('keeps the block on cancel, and on a failure the host is explaining', () => {
    for (const result of [
      { status: 'cancelled' },
      { status: 'failed', detail: 'That note is no longer open' }
    ] as const) {
      const app = openMoveFor('p1')

      app.deliver({
        type: 'block-move-result',
        reqId: 'bm1',
        docId: DOC_ID,
        blockId: 'p1',
        result
      })

      expect(app.removeBlocks).not.toHaveBeenCalled()
      expect(app.blocks.has('p1')).toBe(true)
      expect(highlighted(app.root)).toEqual([])
    }
  })

  it('ignores an answer to a request it is not waiting on', () => {
    const app = openMoveFor('p1')

    // A reply that outlived its request, or a second reply to one already
    // answered. Acting on it would delete a block nobody asked to move.
    app.deliver({
      type: 'block-move-result',
      reqId: 'bm99',
      docId: DOC_ID,
      blockId: 'p1',
      result: { status: 'moved', targetTitle: 'Recipes' }
    })
    // And an answer addressed to a different note, which is what a mid-flow
    // note switch produces.
    app.deliver({
      type: 'block-move-result',
      reqId: 'bm1',
      docId: 'some-other-note',
      blockId: 'p1',
      result: { status: 'moved', targetTitle: 'Recipes' }
    })

    expect(app.removeBlocks).not.toHaveBeenCalled()
    expect(app.blocks.has('p1')).toBe(true)
    expect(highlighted(app.root)).toEqual(['p1'])

    // The slot is still occupied, so the real answer still works.
    app.deliver({
      type: 'block-move-result',
      reqId: 'bm1',
      docId: DOC_ID,
      blockId: 'p1',
      result: { status: 'moved', targetTitle: 'Recipes' }
    })
    expect(app.blocks.has('p1')).toBe(false)
  })
})

describe('the panel from the caret', () => {
  it('offers both colour rows on a paragraph and re-renders after a tap', () => {
    const app = harness([paragraph('p1', 'Words')])
    app.menu.openForCaret()

    expect(document.querySelector('[aria-label="Paragraph"]')).not.toBeNull()
    expect(button('Text colour: red')).toBeInstanceOf(HTMLButtonElement)
    expect(button('Text colour: red').getAttribute('aria-pressed')).toBe('false')

    button('Text colour: red').click()

    expect(app.updateBlock).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }), {
      props: { textColor: 'red' }
    })
    // A nudge-and-look loop: the panel stays up, the ring stays on, and the
    // swatch that was tapped is now the checked one.
    app.blocks.set('p1', {
      ...app.blocks.get('p1')!,
      props: { textColor: 'red', backgroundColor: 'default', textAlignment: 'left' }
    })
    button('Highlight: default').click()
    expect(button('Text colour: red').getAttribute('aria-pressed')).toBe('true')
    expect(highlighted(app.root)).toEqual(['p1'])
  })

  it('closes after Duplicate and after Delete', () => {
    const app = harness([paragraph('p1', 'Words')])

    app.menu.openForCaret()
    button('Duplicate').click()
    expect(document.querySelector('.editor-block-actions')).toBeNull()
    expect(highlighted(app.root)).toEqual([])

    app.menu.openForCaret()
    button('Delete').click()
    expect(app.removeBlocks).toHaveBeenCalledWith([expect.objectContaining({ id: 'p1' })])
    expect(document.querySelector('.editor-block-actions')).toBeNull()
    expect(highlighted(app.root)).toEqual([])
  })

  it('says so when the actions carry a subtree', () => {
    const app = harness([
      { ...paragraph('p1', 'Parent'), type: 'toggleListItem', children: [paragraph('p2', 'Kid')] }
    ])

    app.menu.openForCaret()

    expect(document.body.textContent).toContain('Includes nested blocks')
    expect(document.querySelector('[aria-label="Toggle list"]')).not.toBeNull()
  })
})
