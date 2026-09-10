// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GuestMsg, HostMsg, WikiCandidate } from '@memry/contracts/webview-bridge'
import type { GuestBridge } from '../../editor-web/src/bridge'
import {
  detectTrigger,
  inlineMenuScrollPlan,
  installWikiLinkAutocomplete,
  type WikiLinkEditorSurface
} from '../../editor-web/src/wiki-links'

/**
 * `#` and `@` inline menus in the guest (#2099).
 *
 * They ride the `[[` machinery, so the tests that matter are the ones that
 * pull the three triggers apart: which one is open, how many characters the
 * accept path deletes backwards, and which node it writes.
 */
describe('detectTrigger', () => {
  it('opens the tag menu on `#`', () => {
    expect(detectTrigger('a #road')).toEqual({ trigger: 'tag', query: 'road' })
  })

  it('opens on a bare `#`, so the whole tag list is one keystroke away', () => {
    expect(detectTrigger('#')).toEqual({ trigger: 'tag', query: '' })
  })

  it('opens the mention menu on `@`, spaces and all', () => {
    expect(detectTrigger('see @sprint plan')).toEqual({ trigger: 'mention', query: 'sprint plan' })
  })

  it('lets `[[` win over a `#` inside its own heading grammar', () => {
    expect(detectTrigger('[[Toplantı#Kar')).toEqual({ trigger: 'wiki', query: 'Toplantı#Kar' })
  })

  it('gives the nearer trigger the menu', () => {
    expect(detectTrigger('#tag @no')).toEqual({ trigger: 'mention', query: 'no' })
    expect(detectTrigger('@who #ta')).toEqual({ trigger: 'tag', query: 'ta' })
  })

  it('does not fire mid-word', () => {
    expect(detectTrigger('kaan@example.com')).toBeNull()
    expect(detectTrigger('C#')).toBeNull()
  })

  it('closes a tag run at a space and a mention run once it runs away', () => {
    expect(detectTrigger('#road ')).toBeNull()
    expect(detectTrigger('@sprint  plan')).toBeNull()
  })

  it('takes the last `@` rather than the first', () => {
    expect(detectTrigger('@one x @two')).toEqual({ trigger: 'mention', query: 'two' })
  })
})

describe('inline trigger menus', () => {
  let hostListener: ((msg: HostMsg) => void) | null = null
  let sent: GuestMsg[] = []
  let root: HTMLElement
  let chrome: HTMLElement
  let surface: WikiLinkEditorSurface
  let detach: () => void

  const bridge = {
    send: (msg: GuestMsg) => {
      sent.push(msg)
    },
    flush: () => {},
    onHostMsg: (listener: (msg: HostMsg) => void) => {
      hostListener = listener
      return () => {
        hostListener = null
      }
    }
  } as unknown as GuestBridge

  /** Put the caret at the end of the paragraph's text, then type. */
  function typeInto(text: string): void {
    const paragraph = root.querySelector('p')!
    paragraph.textContent = text
    const range = document.createRange()
    range.setStart(paragraph.firstChild!, text.length)
    range.collapse(true)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    root.dispatchEvent(new Event('input', { bubbles: true }))
  }

  function answer(items: WikiCandidate[]): void {
    const query = [...sent].reverse().find((msg) => msg.type === 'wiki-query')
    if (query?.type !== 'wiki-query') throw new Error('No query was sent')
    hostListener?.({ type: 'wiki-candidates', reqId: query.reqId, items })
  }

  /** One finger down and up on the same spot: a pick. */
  function tap(target: HTMLElement, clientY = 400): void {
    for (const type of ['pointerdown', 'pointerup']) {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientY }))
    }
  }

  /** A finger that lands on a row and travels: a scroll of the list. */
  function drag(target: HTMLElement, from: number, to: number): void {
    target.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientY: from })
    )
    target.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, cancelable: true, clientY: to })
    )
    target.dispatchEvent(
      new MouseEvent('pointerup', { bubbles: true, cancelable: true, clientY: to })
    )
  }

  function tagRow(title: string): WikiCandidate {
    return {
      kind: 'tag',
      id: title,
      title,
      subtitle: '',
      icon: '',
      target: title,
      alias: '',
      color: ''
    }
  }

  function row(label: string): HTMLButtonElement {
    const match = [...chrome.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes(label)
    )
    if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing row: ${label}`)
    return match
  }

  beforeEach(() => {
    vi.useFakeTimers()
    sent = []
    document.body.replaceChildren()
    root = document.createElement('div')
    root.innerHTML = '<p data-node-type="paragraph"></p>'
    chrome = document.createElement('div')
    document.body.append(root, chrome)
    surface = {
      replaceQuery: vi.fn(),
      replaceQueryWithTag: vi.fn(),
      unpromoteAdjacent: vi.fn(() => false)
    }
    detach = installWikiLinkAutocomplete(surface, bridge, { root, chrome }).detach
  })

  afterEach(() => {
    detach()
    vi.useRealTimers()
  })

  it('asks the host for tags when `#` is typed', () => {
    typeInto('#road')

    expect(sent.at(-1)).toEqual({
      type: 'wiki-query',
      reqId: expect.any(String),
      query: 'road',
      trigger: 'tag'
    })
  })

  it('writes a hashTag node carrying the vault colour and icon', () => {
    typeInto('#road')
    answer([
      {
        kind: 'tag',
        id: 'Roadmap',
        title: 'Roadmap',
        subtitle: '',
        icon: '🚀',
        target: 'Roadmap',
        alias: '',
        color: 'tangerine'
      }
    ])

    tap(row('Roadmap'))

    // `'#'.length + 'road'.length`, and nothing forward: a tag has no closer.
    expect(surface.replaceQueryWithTag).toHaveBeenCalledWith(5, 0, 'Roadmap', 'tangerine', '🚀')
    expect(surface.replaceQuery).not.toHaveBeenCalled()
  })

  it('shows the tag with its `#`, as every other Memry surface does', () => {
    typeInto('#road')
    answer([
      {
        kind: 'tag',
        id: 'Roadmap',
        title: 'Roadmap',
        subtitle: '',
        icon: '',
        target: 'Roadmap',
        alias: '',
        color: ''
      }
    ])

    expect(row('Roadmap').textContent).toContain('#Roadmap')
  })

  it('writes a wiki link when a note is picked from `@`', () => {
    typeInto('@tok')
    answer([
      {
        kind: 'note',
        id: 'n2',
        title: 'Tokyo trip',
        subtitle: '',
        icon: '',
        target: 'Tokyo trip',
        alias: ''
      }
    ])

    tap(row('Tokyo trip'))

    expect(surface.replaceQuery).toHaveBeenCalledWith(4, 0, 'Tokyo trip', '')
    expect(surface.replaceQueryWithTag).not.toHaveBeenCalled()
  })

  it('does not print the `|` hint under a tag menu — there is no such grammar', () => {
    typeInto('#road')
    answer([
      {
        kind: 'create',
        id: '',
        title: 'road',
        subtitle: 'Create tag',
        icon: '',
        target: 'road',
        alias: '',
        color: ''
      }
    ])

    expect(chrome.querySelector('.wiki-menu-hint')).toBeNull()
  })

  it('re-asks immediately when the trigger changes, not on the debounce', () => {
    typeInto('#road')
    sent = []
    typeInto('#road @tok')

    expect(sent.at(-1)).toMatchObject({ trigger: 'mention', query: 'tok' })
  })

  it('scrolls the list on a drag rather than picking the row it started on', () => {
    typeInto('#a')
    answer([
      tagRow('a24'),
      tagRow('absurd'),
      tagRow('active'),
      tagRow('andy-weir'),
      tagRow('annual'),
      tagRow('architecture')
    ])

    drag(row('a24'), 400, 260)

    // The whole defect in one assertion: the first touch of a scroll used to
    // be the pick, so the list could only ever be read five rows deep.
    expect(surface.replaceQueryWithTag).not.toHaveBeenCalled()
    expect(chrome.querySelector<HTMLElement>('.wiki-menu')?.hidden).toBe(false)
  })

  it('still picks when the finger barely moves', () => {
    typeInto('#a')
    answer([tagRow('a24')])

    drag(row('a24'), 400, 396)

    expect(surface.replaceQueryWithTag).toHaveBeenCalledWith(2, 0, 'a24', '', '')
  })

  it('keeps the caret out of the editor while a row is being pressed', () => {
    typeInto('#a')
    answer([tagRow('a24')])

    const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientY: 400 })
    row('a24').dispatchEvent(down)

    expect(down.defaultPrevented).toBe(true)
  })

  it('closes the menu once the run is abandoned', () => {
    typeInto('#road')
    answer([
      {
        kind: 'tag',
        id: 'Roadmap',
        title: 'Roadmap',
        subtitle: '',
        icon: '',
        target: 'Roadmap',
        alias: '',
        color: ''
      }
    ])
    expect(chrome.querySelector<HTMLElement>('.wiki-menu')?.hidden).toBe(false)

    typeInto('#road ')

    expect(chrome.querySelector<HTMLElement>('.wiki-menu')?.hidden).toBe(true)
  })
})

/**
 * Where the menu leaves the line the reader is typing.
 *
 * The plan is asserted rather than the scroll: jsdom has no layout, so a test
 * driving the DOM path would measure zeroes and pass on any arithmetic.
 */
describe('inlineMenuScrollPlan', () => {
  it('does nothing when the caret already sits above the menu', () => {
    expect(
      inlineMenuScrollPlan({ caretBottom: 200, menuTop: 520, scrollY: 0, maxScroll: 4000 })
    ).toEqual({ scrollBy: 0, pad: 0 })
  })

  it('scrolls the caret clear when the menu covers it, with room to spare', () => {
    // 700 + 12 margin - 520 = 192, and there are 4000px of note left.
    expect(
      inlineMenuScrollPlan({ caretBottom: 700, menuTop: 520, scrollY: 0, maxScroll: 4000 })
    ).toEqual({ scrollBy: 192, pad: 0 })
  })

  it('leaves a margin, so the line is readable rather than merely uncovered', () => {
    expect(
      inlineMenuScrollPlan({ caretBottom: 520, menuTop: 520, scrollY: 0, maxScroll: 4000 }).scrollBy
    ).toBe(12)
  })

  it('asks for exactly the document the last line is missing', () => {
    // Scrolled to the very end: every pixel of the scroll has to be invented.
    expect(
      inlineMenuScrollPlan({ caretBottom: 700, menuTop: 520, scrollY: 4000, maxScroll: 4000 })
    ).toEqual({ scrollBy: 192, pad: 192 })
  })

  it('only pads the part it cannot scroll', () => {
    expect(
      inlineMenuScrollPlan({ caretBottom: 700, menuTop: 520, scrollY: 3950, maxScroll: 4000 })
    ).toEqual({ scrollBy: 192, pad: 142 })
  })
})
