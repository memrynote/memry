// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GuestMsg, HostMsg, WikiCandidate } from '@memry/contracts/webview-bridge'
import type { GuestBridge } from '../../editor-web/src/bridge'
import {
  detectTrigger,
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
    const toolbarHost = document.createElement('div')
    document.body.append(root, chrome, toolbarHost)
    surface = {
      replaceQuery: vi.fn(),
      replaceQueryWithTag: vi.fn(),
      unpromoteAdjacent: vi.fn(() => false)
    }
    detach = installWikiLinkAutocomplete(surface, bridge, { root, chrome, toolbarHost }).detach
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

    row('Roadmap').dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))

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

    row('Tokyo trip').dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))

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
