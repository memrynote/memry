// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

import { createTouchBlockSpecs, formatFileSize } from '../../editor-web/src/blocks'
import { createTouchInlineSpecs, dateMentionLabel } from '../../editor-web/src/inline'

/**
 * What a reader actually sees on a phone (epic #2025).
 *
 * The sibling gate, `mobile-editor-block-coverage.test.ts`, only proves every
 * schema key HAS a touch renderer. It cannot tell a renderer that draws a card
 * from one that draws nothing, because it never calls one. This file calls
 * every `render` and asserts the visible result: the file name and its size,
 * the callout glyph, the task title without its `{task:id}` suffix, the date
 * pill without its `((date:…))` token.
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
type InlineRender = (
  inlineContent: unknown,
  updateInlineContent: (update: unknown) => void,
  editor: unknown
) => Rendered

const blockSpecs = createTouchBlockSpecs()
const inlineSpecs = createTouchInlineSpecs()

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

function renderInline(
  key: keyof typeof inlineSpecs,
  props: Record<string, unknown>,
  update: (value: unknown) => void = () => undefined
): Rendered {
  const spec = inlineSpecs[key] as unknown as { implementation: { render: InlineRender } }
  return spec.implementation.render({ type: key, props }, update, stubEditor())
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

function isoOffsetByDays(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date.toISOString()
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

describe('hashTag', () => {
  it('shows the tag as a coloured chip', () => {
    const { dom } = renderInline('hashTag', { tag: 'work', color: '', icon: '' })

    expect(dom.textContent).toBe('#work')
    expect(dom.getAttribute('data-hash-tag')).toBe('work')
    expect(dom.style.backgroundColor).not.toBe('')
    expect(dom.style.getPropertyValue('--hash-tag-color')).not.toBe('')
  })

  it('draws an emoji icon and skips an icon-registry name', () => {
    const emoji = renderInline('hashTag', { tag: 'work', color: '', icon: '🔥' })
    expect(emoji.dom.querySelector('.hash-tag-icon')?.textContent).toBe('🔥')

    // An icon-name value addresses desktop's HugeIcon registry, which the
    // WebView bundle does not carry.
    const named = renderInline('hashTag', { tag: 'work', color: '', icon: 'briefcase-01' })
    expect(named.dom.querySelector('.hash-tag-icon')).toBeNull()
    expect(named.dom.textContent).toBe('#work')
  })
})

/** A mention with no time and no explicit format, for the label cases. */
const plain = { hasTime: false, dateFormat: 'relative', timeFormat: 'system' }

describe('dateMention', () => {
  function pill(props: Record<string, unknown>) {
    return renderInline('dateMention', {
      anchorId: 'a1',
      dateISO: isoOffsetByDays(0),
      hasTime: false,
      dateFormat: 'relative',
      remind: 'none',
      timeFormat: 'system',
      ...props
    }).dom
  }

  it('shows a readable date, never the persistence token', () => {
    const dom = pill({})
    expect(dom.textContent).not.toContain('((date:')
    expect(dom.querySelector('.date-mention-label')?.textContent).toBe('Today')
  })

  it('names the neighbouring days and falls back to the full form', () => {
    expect(dateMentionLabel({ dateISO: isoOffsetByDays(1), ...plain })).toBe('Tomorrow')
    expect(dateMentionLabel({ dateISO: isoOffsetByDays(-1), ...plain })).toBe('Yesterday')
    expect(dateMentionLabel({ dateISO: isoOffsetByDays(9), ...plain })).toMatch(
      /^\d{1,2} \S+, \d{4}$/
    )
    expect(
      dateMentionLabel({
        dateISO: new Date(2020, 8, 4).toISOString(),
        hasTime: false,
        dateFormat: 'full',
        timeFormat: 'system'
      })
    ).toMatch(/^4 \S+, 2020$/)
  })

  it('reads an unparseable date as a placeholder', () => {
    expect(dateMentionLabel({ dateISO: '', ...plain })).toBe('Date')
    expect(dateMentionLabel({ dateISO: 'not-a-date', ...plain })).toBe('Date')
  })

  it('appends a clock time only when the mention carries one', () => {
    const at = new Date()
    at.setHours(14, 5, 0, 0)
    expect(
      dateMentionLabel({
        dateISO: at.toISOString(),
        hasTime: true,
        dateFormat: 'relative',
        timeFormat: '24h'
      })
    ).toBe('Today 14:05')
    expect(dateMentionLabel({ dateISO: at.toISOString(), ...plain })).toBe('Today')
  })

  it('shows the alarm glyph only for a mention with a reminder', () => {
    expect(pill({ remind: 'none' }).querySelector('.date-mention-icon')).toBeNull()
    expect(pill({ remind: '' }).querySelector('.date-mention-icon')).toBeNull()
    expect(pill({ remind: '15m' }).querySelector('.date-mention-icon svg')).not.toBeNull()
  })
})

describe('inlineImage', () => {
  it('keeps the vault-relative reference for the DOM-level resolver', () => {
    const { dom } = renderInline('inlineImage', {
      src: 'attachments/n1/chart.png',
      alt: 'Chart',
      width: 0
    })

    const img = dom.querySelector('img')!
    // `getAttribute`, never `.src`: the property resolves the reference against
    // the document base URL, which is not what the note holds.
    expect(img.getAttribute('src')).toBe('attachments/n1/chart.png')
    expect(img.getAttribute('alt')).toBe('Chart')
    expect(img.style.inlineSize).toBe('')
  })

  it('applies a stored display width', () => {
    const { dom } = renderInline('inlineImage', {
      src: 'attachments/n1/chart.png',
      alt: '',
      width: 300
    })
    expect(dom.querySelector('img')!.style.inlineSize).toBe('300px')
  })
})

describe('inlineCheckbox', () => {
  it('reflects the document value and flips it on tap', () => {
    const update = vi.fn()
    const { dom } = renderInline('inlineCheckbox', { checked: true }, update)

    const input = dom.querySelector('input')!
    expect(input.checked).toBe(true)
    expect(dom.getAttribute('contenteditable')).toBe('false')

    tap(dom, 'pointerup')
    expect(update).toHaveBeenCalledWith({ type: 'inlineCheckbox', props: { checked: false } })
  })
})

describe('linkMention', () => {
  it('shows site and title as text, with no link and no favicon', () => {
    const { dom } = renderInline('linkMention', {
      url: 'https://www.example.com/post',
      domain: 'example.com',
      title: 'A post',
      favicon: 'https://www.example.com/favicon.ico',
      siteName: 'Example'
    })

    expect(dom.textContent).not.toContain('((mention:')
    expect(dom.querySelector('.link-mention-site')?.textContent).toBe('Example')
    expect(dom.querySelector('.link-mention-title')?.textContent).toBe('A post')
    expect(countTags(dom, 'a')).toBe(0)
    expect(countTags(dom, 'img')).toBe(0)
  })

  it('omits the title line when there is none', () => {
    const { dom } = renderInline('linkMention', {
      url: 'https://example.com/post',
      domain: '',
      title: '',
      favicon: '',
      siteName: ''
    })

    expect(dom.querySelector('.link-mention-title')).toBeNull()
    expect(dom.querySelector('.link-mention-site')?.textContent).toBe('example.com')
  })
})

describe('every touch spec', () => {
  it('is registered under its own config.type (#1455)', () => {
    for (const [key, spec] of Object.entries(blockSpecs)) {
      expect(spec.config.type, `block spec registered as "${key}"`).toBe(key)
    }
    for (const [key, spec] of Object.entries(inlineSpecs)) {
      const config = spec.config as { type: string }
      expect(config.type, `inline spec registered as "${key}"`).toBe(key)
    }
  })
})
