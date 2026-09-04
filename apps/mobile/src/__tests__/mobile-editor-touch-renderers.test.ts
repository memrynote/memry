// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

import { createTouchBlockSpecs, formatFileSize } from '../../editor-web/src/blocks'

/**
 * What a reader actually sees on a phone (epic #2025).
 *
 * The sibling gate, `mobile-editor-block-coverage.test.ts`, only proves every
 * schema key HAS a touch renderer. It cannot tell a renderer that draws a card
 * from one that draws nothing, because it never calls one. This file calls
 * every `render` and asserts the visible result: the file name and its size,
 * the callout glyph, the task title without its `{task:id}` suffix.
 *
 * Two of the assertions are contracts rather than looks. No renderer may emit
 * an `<img>` (the WebView's CSP is `img-src data: blob:`, so a remote one is
 * swapped for a "not downloaded yet" placeholder by `images.ts`), and none may
 * emit an `<a href>` (a tap navigates the WebView off the editor document, and
 * the guest-to-host protocol has no message that opens a URL externally).
 * Those are written here as assertions, not as comments in the renderer.
 *
 * jsdom is not declared in `apps/mobile/package.json`; it resolves from the
 * pnpm workspace root, which is why the environment can be requested here
 * without the mobile app taking a dependency on it.
 */

type Rendered = { dom: HTMLElement; contentDOM?: HTMLElement; destroy?: () => void }
type BlockRender = (this: unknown, block: unknown, editor: unknown) => Rendered

const blockSpecs = createTouchBlockSpecs()

function stubEditor() {
  const updateBlock = vi.fn((block: unknown) => block)
  return {
    updateBlock,
    isEditable: true,
    transact: (fn: () => unknown) => fn(),
    getBlock: (block: unknown) => block,
    onChange: () => () => undefined,
    setTextCursorPosition: vi.fn(),
    focus: vi.fn(),
    dictionary: { toggle_blocks: { add_block_button: 'Add block' } }
  }
}

/**
 * Renders a block the way the editor does, and hands back both halves.
 *
 * `implementation.render` is BlockNote's own wrapper, not the function
 * `blocks.ts` supplies: it reads `this.blockContentDOMAttributes`, delegates,
 * and wraps the result in the `.bn-block-content[data-content-type=…]` element
 * ProseMirror actually mounts. So it is called with a node-view `this`, `dom`
 * is that wrapper, and `root` is the touch element inside it — which is what
 * `styles.css` selects on.
 */
function renderBlock(
  key: keyof typeof blockSpecs,
  props: Record<string, unknown>,
  editor: unknown = stubEditor()
): Rendered & { root: HTMLElement } {
  const render = blockSpecs[key].implementation.render as unknown as BlockRender
  const rendered = render.call(
    { blockContentDOMAttributes: {}, renderType: 'nodeView', props },
    { id: `${key}-1`, type: key, props, content: [], children: [] },
    editor
  )
  return { ...rendered, root: rendered.dom.firstElementChild as HTMLElement }
}

/**
 * How many `tag` elements a rendered result contains, the element ITSELF
 * included. `querySelectorAll` only walks descendants, so it answers zero for a
 * chip that is itself the forbidden `<a>` — which is exactly the regression
 * these counts exist to catch.
 */
function countTags(rendered: HTMLElement, tag: string): number {
  const host = document.createElement('div')
  host.appendChild(rendered)
  return host.querySelectorAll(tag).length
}

/** jsdom has no PointerEvent, and the handlers only ever call `preventDefault`. */
function tap(element: Element, type: 'pointerup' | 'click' | 'mousedown'): void {
  element.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }))
}

describe('callout', () => {
  it('shows a glyph, the block content and no literal marker', () => {
    const { dom, root, contentDOM } = renderBlock('callout', {
      textAlignment: 'left',
      textColor: 'default',
      type: 'warning'
    })

    expect(root.getAttribute('data-callout-type')).toBe('warning')
    expect(dom.querySelector('.callout-icon svg')).not.toBeNull()
    expect(contentDOM).toBe(dom.querySelector('.callout-content'))
    // The server DOM prints `[!warning]` as text, because that IS the on-disk
    // first line. A reader must never see it.
    expect(dom.textContent).not.toContain('[!')
  })

  it('falls back to info for a type the schema does not know', () => {
    const { root } = renderBlock('callout', {
      textAlignment: 'left',
      textColor: 'default',
      type: 'nonsense'
    })
    expect(root.getAttribute('data-callout-type')).toBe('info')
  })
})

describe('taskBlock', () => {
  it('shows the title without its markdown id suffix', () => {
    const { dom, root } = renderBlock('taskBlock', {
      taskId: 'task-9',
      title: 'Renew the domain',
      checked: false,
      parentTaskId: ''
    })

    expect(dom.querySelector('.task-title')?.textContent).toBe('Renew the domain')
    expect(dom.textContent).not.toContain('{task:')
    expect(dom.querySelector('.task-check')?.getAttribute('aria-checked')).toBe('false')
    expect(root.getAttribute('data-nested')).toBeNull()
  })

  it('tracks checked, and marks a nested task', () => {
    const { dom, root } = renderBlock('taskBlock', {
      taskId: 'task-9',
      title: 'Done thing',
      checked: true,
      parentTaskId: 'task-1'
    })

    expect(root.getAttribute('data-checked')).toBe('true')
    expect(dom.querySelector('.task-check')?.getAttribute('aria-checked')).toBe('true')
    expect(root.getAttribute('data-nested')).toBe('true')
  })

  it('reads an untitled task as placeholder text', () => {
    const { dom } = renderBlock('taskBlock', {
      taskId: 'task-9',
      title: '',
      checked: false,
      parentTaskId: ''
    })

    const title = dom.querySelector('.task-title')
    expect(title?.textContent).toBe('Untitled task')
    expect(title?.getAttribute('data-empty')).toBe('true')
  })

  it('flips checked in the document when the box is tapped', () => {
    const editor = stubEditor()
    const { dom } = renderBlock(
      'taskBlock',
      { taskId: 'task-9', title: 'Renew the domain', checked: false, parentTaskId: '' },
      editor
    )

    tap(dom.querySelector('.task-check')!, 'pointerup')

    expect(editor.updateBlock).toHaveBeenCalledWith(expect.anything(), {
      props: { checked: true }
    })
  })
})

describe('file', () => {
  it('shows the name and a readable size, not an HTML comment', () => {
    const { dom } = renderBlock('file', {
      url: 'attachments/n1/report.pdf',
      name: 'report.pdf',
      size: 2_411_724,
      mimeType: 'application/pdf',
      width: 0,
      height: 0,
      align: 'left'
    })

    // The server DOM for this block is a single comment node, so on mobile the
    // whole block used to be an empty line. Non-empty text is the fix.
    expect(dom.textContent).not.toBe('')
    expect(dom.querySelector('.file-name')?.textContent).toBe('report.pdf')
    expect(dom.querySelector('.file-meta')?.textContent).toBe('2.3 MB')
    expect(dom.querySelector('.file-icon svg')).not.toBeNull()
  })

  it('omits the size line when there is no size', () => {
    const { dom } = renderBlock('file', {
      url: 'attachments/n1/note.txt',
      name: '',
      size: 0,
      mimeType: 'text/plain',
      width: 0,
      height: 0,
      align: 'left'
    })

    expect(dom.querySelector('.file-name')?.textContent).toBe('attachments/n1/note.txt')
    expect(dom.querySelector('.file-meta')).toBeNull()
  })

  it('formats sizes across the unit boundaries', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(1023)).toBe('1023 B')
    expect(formatFileSize(1024)).toBe('1.0 KB')
    expect(formatFileSize(1536)).toBe('1.5 KB')
    expect(formatFileSize(1024 ** 2 - 1)).toBe('1024.0 KB')
    expect(formatFileSize(1024 ** 2)).toBe('1.0 MB')
    expect(formatFileSize(1024 ** 3)).toBe('1.0 GB')
    // Neither can reach the formatter from a real block, but a synced prop is
    // whatever the other device wrote, so neither may produce `NaN B` either.
    expect(formatFileSize(-5)).toBe('0 B')
    expect(formatFileSize(Number.NaN)).toBe('0 B')
    // A prop seeded straight into the shared Y.Doc arrives as a STRING — the
    // same landmine `toWidth` and `toChecked` exist for. Uncoerced, every
    // synced attachment reads `0 B`.
    expect(formatFileSize('248512')).toBe('242.7 KB')
  })
})

describe('youtubeEmbed', () => {
  it('shows a card with no image and no link', () => {
    const { dom } = renderBlock('youtubeEmbed', {
      videoId: 'dQw4w9WgXcQ',
      videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    })

    expect(dom.querySelector('.embed-title')?.textContent).toBe('YouTube')
    expect(dom.querySelector('.embed-url')?.textContent).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    )
    expect(countTags(dom, 'img')).toBe(0)
    expect(countTags(dom, 'a')).toBe(0)
  })

  it('drops the url line when the block carries neither url nor id', () => {
    const { dom } = renderBlock('youtubeEmbed', { videoId: '', videoUrl: '' })
    expect(dom.querySelector('.embed-url')).toBeNull()
  })
})

describe('bookmark', () => {
  it('shows title, description and site with no image and no link', () => {
    const { dom } = renderBlock('bookmark', {
      url: 'https://www.example.com/a/deep/page',
      domain: 'example.com',
      title: 'A deep page',
      description: 'What the page is about.',
      image: 'https://www.example.com/og.png',
      favicon: 'https://www.example.com/favicon.ico',
      siteName: 'Example'
    })

    expect(dom.querySelector('.bookmark-title')?.textContent).toBe('A deep page')
    expect(dom.querySelector('.bookmark-description')?.textContent).toBe('What the page is about.')
    expect(dom.querySelector('.bookmark-site')?.textContent).toBe('Example')
    expect(countTags(dom, 'img')).toBe(0)
    expect(countTags(dom, 'a')).toBe(0)
  })

  it('falls back to the hostname with the www stripped', () => {
    const { dom } = renderBlock('bookmark', {
      url: 'https://www.example.com/a/deep/page',
      domain: '',
      title: '',
      description: '',
      image: '',
      favicon: '',
      siteName: ''
    })

    expect(dom.querySelector('.bookmark-title')?.textContent).toBe('example.com')
    expect(dom.querySelector('.bookmark-description')).toBeNull()
  })
})

describe('toggleListItem', () => {
  it('reflects the open prop and writes the flip back to the document', () => {
    const closed = renderBlock('toggleListItem', {
      backgroundColor: 'default',
      textAlignment: 'left',
      textColor: 'default',
      open: false
    })
    expect(closed.dom.querySelector('.bn-toggle-wrapper')?.getAttribute('data-show-children')).toBe(
      'false'
    )

    const editor = stubEditor()
    const open = renderBlock(
      'toggleListItem',
      { backgroundColor: 'default', textAlignment: 'left', textColor: 'default', open: true },
      editor
    )
    expect(open.dom.querySelector('.bn-toggle-wrapper')?.getAttribute('data-show-children')).toBe(
      'true'
    )

    tap(open.dom.querySelector('.bn-toggle-button')!, 'click')
    expect(editor.updateBlock).toHaveBeenCalledWith(expect.anything(), { props: { open: false } })
  })
})

describe('every touch block spec', () => {
  it('is registered under its own config.type (#1455)', () => {
    for (const [key, spec] of Object.entries(blockSpecs)) {
      expect(spec.config.type, `block spec registered as "${key}"`).toBe(key)
    }
  })
})
