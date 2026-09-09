// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BRIDGE_PROTOCOL_VERSION,
  type GuestMsg,
  type HostMsg
} from '@memry/contracts/webview-bridge'

import { GuestBridge } from '../../editor-web/src/bridge'
import {
  dropAt,
  installPasteLinkMenu,
  isLinkMention,
  isPastedUrl,
  pasteLinkOptions,
  replaceAt,
  rewriteInlineContent,
  type PasteLinkSurface
} from '../../editor-web/src/paste-link'

const URL = 'https://example.com/post'
const VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'

function surface(overrides: Partial<PasteLinkSurface> = {}): PasteLinkSurface {
  return {
    cursorBlockId: vi.fn(() => 'block-1'),
    toMention: vi.fn(() => true),
    toEmbed: vi.fn(),
    toBookmark: vi.fn(),
    applyPreview: vi.fn(),
    ...overrides
  }
}

/**
 * A real `GuestBridge` over a spy transport, not a stand-in for one: the point
 * of most of these assertions is the message that reaches the wire, and a fake
 * bridge would assert the test's own idea of the envelope.
 */
function bridgeWithSpy(): { bridge: GuestBridge; sent: GuestMsg[] } {
  const sent: GuestMsg[] = []
  const bridge = new GuestBridge((payload) => {
    for (const msg of JSON.parse(payload).msgs as GuestMsg[]) sent.push(msg)
  })
  bridge.markLoaded()
  return { bridge, sent }
}

let hostSeq = 0

function deliver(bridge: GuestBridge, msg: HostMsg): void {
  bridge.receive(
    JSON.stringify({ v: BRIDGE_PROTOCOL_VERSION, sid: 'host', seq: ++hostSeq, msgs: [msg] })
  )
}

function paste(root: HTMLElement, text: string): void {
  const event = new Event('paste', { bubbles: true })
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (type: string) => (type === 'text/plain' ? text : '') }
  })
  root.dispatchEvent(event)
  vi.advanceTimersByTime(32)
}

function rows(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('.paste-link-item')]
}

function tap(option: string): void {
  const row = rows().find((candidate) => candidate.getAttribute('data-option') === option)
  if (!row) throw new Error(`Missing row: ${option}`)
  row.dispatchEvent(new Event('pointerdown', { bubbles: true }))
}

function install(overrides: Partial<PasteLinkSurface> = {}) {
  const root = document.createElement('div')
  const chrome = document.createElement('div')
  const toolbarHost = document.createElement('div')
  document.body.append(root, chrome, toolbarHost)
  const api = surface(overrides)
  const { bridge, sent } = bridgeWithSpy()
  const panel: boolean[] = []
  const menu = installPasteLinkMenu(api, bridge, { root, chrome, toolbarHost }, (open) =>
    panel.push(open)
  )
  return { root, api, bridge, sent, menu, panel }
}

describe('paste-link menu', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    document.body.replaceChildren()
    hostSeq = 0
  })

  it('offers the embed row only for a URL it can actually embed', () => {
    expect(pasteLinkOptions(URL)).toEqual(['mention', 'bookmark', 'url'])
    expect(pasteLinkOptions(VIDEO)).toEqual(['mention', 'embed', 'bookmark', 'url'])
  })

  it('opens on a pasted bare URL and stays shut for prose that merely holds one', () => {
    const { root } = install()

    paste(root, `see ${URL} for the details`)
    expect(rows()).toHaveLength(0)

    paste(root, `  ${URL}  `)
    expect(rows().map((row) => row.getAttribute('data-option'))).toEqual([
      'mention',
      'bookmark',
      'url'
    ])
  })

  it('makes a bookmark and fetches its metadata through the host', () => {
    const { root, api, bridge, sent } = install()

    paste(root, URL)
    tap('bookmark')

    expect(api.toBookmark).toHaveBeenCalledWith('block-1', URL)
    expect(rows()).toHaveLength(0)

    const request = sent.find((msg) => msg.type === 'link-preview-req')
    expect(request).toMatchObject({ url: URL })

    deliver(bridge, {
      type: 'link-preview',
      reqId: request!.type === 'link-preview-req' ? request!.reqId : '',
      title: 'A post',
      domain: 'example.com',
      description: 'About things',
      image: 'https://example.com/cover.png',
      favicon: 'https://example.com/favicon.ico',
      siteName: 'Example'
    })

    expect(api.applyPreview).toHaveBeenCalledWith(
      'bookmark',
      URL,
      expect.objectContaining({ title: 'A post', siteName: 'Example' })
    )
  })

  it('does not ask for metadata when the mention could not be written', () => {
    const { root, api, sent } = install({ toMention: vi.fn(() => false) })

    paste(root, URL)
    tap('mention')

    expect(api.toMention).toHaveBeenCalledWith('block-1', URL)
    expect(sent.some((msg) => msg.type === 'link-preview-req')).toBe(false)
  })

  it('leaves the document alone when the reader keeps the plain URL', () => {
    const { root, api, sent } = install()

    paste(root, URL)
    tap('url')

    expect(api.toMention).not.toHaveBeenCalled()
    expect(api.toBookmark).not.toHaveBeenCalled()
    expect(api.toEmbed).not.toHaveBeenCalled()
    expect(sent.some((msg) => msg.type === 'link-preview-req')).toBe(false)
    expect(rows()).toHaveLength(0)
  })

  it('passes the video id an embed needs', () => {
    const { root, api } = install()

    paste(root, VIDEO)
    tap('embed')

    expect(api.toEmbed).toHaveBeenCalledWith('block-1', VIDEO, 'dQw4w9WgXcQ')
  })

  it('dismisses on the next edit and on a tap outside itself', () => {
    const { root } = install()

    paste(root, URL)
    root.dispatchEvent(new Event('input', { bubbles: true }))
    expect(rows()).toHaveLength(0)

    paste(root, URL)
    expect(rows()).not.toHaveLength(0)
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(rows()).toHaveLength(0)
  })

  it('ignores a metadata answer for a request it no longer holds', () => {
    const { root, api, bridge } = install()

    paste(root, URL)
    tap('bookmark')
    api.applyPreview = vi.fn()

    deliver(bridge, {
      type: 'link-preview',
      reqId: 'lp-not-ours',
      title: 'Someone else',
      domain: '',
      description: '',
      image: '',
      favicon: '',
      siteName: ''
    })

    expect(api.applyPreview).not.toHaveBeenCalled()
  })

  it('stops listening once detached', () => {
    const { root, menu } = install()

    menu.detach()
    paste(root, URL)

    expect(rows()).toHaveLength(0)
  })

  it('reports itself as a panel so the native footer gets out of its way', () => {
    const { root, menu, panel } = install()

    paste(root, URL)
    expect(panel).toEqual([true])

    tap('url')
    expect(panel).toEqual([true, false])

    // A note torn down with the strip open must not leave the next note's
    // footer hidden by a menu that no longer exists.
    paste(root, URL)
    menu.detach()
    expect(panel).toEqual([true, false, true, false])
  })
})

describe('paste-link block rewriting', () => {
  it('matches the link node and the plain text a paste can leave behind', () => {
    expect(isPastedUrl({ type: 'link', href: URL }, URL)).toBe(true)
    expect(isPastedUrl({ type: 'text', text: `x ${URL}` }, URL)).toBe(true)
    expect(isPastedUrl({ type: 'link', href: 'https://other.example' }, URL)).toBe(false)
    expect(isLinkMention({ type: 'linkMention', props: { url: URL } }, URL)).toBe(true)
    expect(isLinkMention({ type: 'linkMention', props: { url: 'https://x.test' } }, URL)).toBe(
      false
    )
  })

  it('rewrites a flat paragraph and reports a miss as null', () => {
    const content = [
      { type: 'text', text: 'read ' },
      { type: 'link', href: URL }
    ]

    expect(rewriteInlineContent(content, (node) => isPastedUrl(node, URL), dropAt)).toEqual([
      { type: 'text', text: 'read ' }
    ])
    expect(
      rewriteInlineContent(content, (node) => isPastedUrl(node, 'https://absent.test'), dropAt)
    ).toBeNull()
  })

  it('reaches inside a table cell without flattening the table', () => {
    const content = {
      type: 'tableContent',
      headerRows: 1,
      rows: [
        { cells: [{ content: [{ type: 'text', text: 'head' }] }] },
        { cells: [{ content: [{ type: 'link', href: URL }] }] }
      ]
    }

    const next = rewriteInlineContent(
      content,
      (node) => isPastedUrl(node, URL),
      (inline, index) => replaceAt(inline, index, { type: 'linkMention', props: { url: URL } })
    )

    expect(next).toMatchObject({
      type: 'tableContent',
      headerRows: 1,
      rows: [
        { cells: [{ content: [{ type: 'text', text: 'head' }] }] },
        { cells: [{ content: [{ type: 'linkMention', props: { url: URL } }] }] }
      ]
    })
  })

  it('round-trips a bare-array table cell from an older document', () => {
    const content = {
      type: 'tableContent',
      rows: [{ cells: [[{ type: 'link', href: URL }]] }]
    }

    expect(rewriteInlineContent(content, (node) => isPastedUrl(node, URL), dropAt)).toMatchObject({
      rows: [{ cells: [[]] }]
    })
  })
})
