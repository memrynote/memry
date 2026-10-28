import { afterEach, describe, expect, it, vi } from 'vitest'

import { watchExternalLinks, watchLinkDrops } from './external-link-guard'

const ORIGIN = 'http://localhost:3000'

function mount(html: string): HTMLElement {
  document.body.innerHTML = html
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the markup above always has #l
  return document.getElementById('l') as HTMLElement
}

function click(element: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init })
  element.dispatchEvent(event)
  return event
}

/** Whether the engine will skip the default action (the navigation), whatever the page sees. */
const engineSkipsDefault = (event: Event): boolean =>
  Object.getOwnPropertyDescriptor(Event.prototype, 'defaultPrevented')?.get?.call(event) === true

/** The guard opens after the event's dispatch, once no handler claimed it. */
const afterDispatch = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('watchExternalLinks', () => {
  let stop = (): void => undefined
  const open = vi.fn(() => Promise.resolve())
  const start = (): void => {
    stop = watchExternalLinks(window, open, ORIGIN)
  }
  afterEach(() => {
    stop()
    open.mockClear()
  })

  it('sends a clicked web or mail link to the OS and keeps the page', async () => {
    start()
    for (const href of [
      'https://example.com/a?b=1',
      'http://example.com/',
      'mailto:hi@memrynote.com'
    ]) {
      const link = mount(`<a id="l" href="${href}"><span id="inner">x</span></a>`)
      const event = click(link.querySelector('#inner') ?? link)
      expect(engineSkipsDefault(event), href).toBe(true)
      await afterDispatch()
      expect(open).toHaveBeenLastCalledWith(new URL(href).href)
    }
  })

  it('takes a link whose click an app handler stops from propagating', async () => {
    start()
    const link = mount('<div id="wrap"><a id="l" href="https://example.com/s">x</a></div>')
    link.addEventListener('click', (event) => event.stopPropagation())
    const stopper = new AbortController()
    document.addEventListener('click', (event) => event.stopImmediatePropagation(), {
      capture: true,
      signal: stopper.signal
    })
    const event = click(link)
    stopper.abort()
    expect(engineSkipsDefault(event)).toBe(true)
    await afterDispatch()
    expect(open).toHaveBeenCalledExactlyOnceWith('https://example.com/s')
  })

  it('leaves every other click to the page', async () => {
    start()
    const cases: Array<[string, MouseEventInit?]> = [
      ['<a id="l" href="#section">x</a>'],
      [`<a id="l" href="${ORIGIN}/page">x</a>`],
      ['<a id="l" href="memry-file://local/v/a.pdf">x</a>'],
      ['<a id="l" href="javascript:void(0)">x</a>'],
      ['<a id="l" href="https://example.com/f" download>x</a>'],
      ['<a id="l" href="https://example.com/">x</a>', { button: 1 }],
      ['<button id="l">x</button>']
    ]
    for (const [html, init] of cases) {
      const event = click(mount(html), init)
      expect(engineSkipsDefault(event), html).toBe(false)
    }
    await afterDispatch()
    expect(open).not.toHaveBeenCalled()
  })

  it('leaves a link to a component that claims it, which sees the event as before', async () => {
    start()
    const link = mount('<a id="l" href="https://example.com/">x</a>')
    const seen: boolean[] = []
    link.addEventListener('click', (event) => {
      seen.push(event.defaultPrevented)
      event.preventDefault()
      seen.push(event.defaultPrevented)
    })
    document.addEventListener('click', (event) => seen.push(event.defaultPrevented), {
      once: true
    })
    click(link)
    expect(seen).toEqual([false, true, true])
    await afterDispatch()
    expect(open).not.toHaveBeenCalled()
  })

  it('stops listening after the cleanup', async () => {
    start()
    stop()
    const event = click(mount('<a id="l" href="https://example.com/">x</a>'))
    expect(engineSkipsDefault(event)).toBe(false)
    await afterDispatch()
    expect(open).not.toHaveBeenCalled()
  })
})

describe('watchLinkDrops', () => {
  let stop = (): void => undefined
  const open = vi.fn(() => Promise.resolve())
  afterEach(() => {
    stop()
    open.mockClear()
  })

  function drag(
    type: 'dragenter' | 'dragover' | 'drop',
    target: Element,
    data: Record<string, string>
  ): Event {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: Object.keys(data), getData: (t: string) => data[t] ?? '', dropEffect: 'none' }
    })
    target.dispatchEvent(event)
    return event
  }

  it('takes a link dragged in from a browser and opens it in the OS, so the window never navigates', async () => {
    stop = watchLinkDrops(window, open)
    const target = mount('<div id="l"></div>')
    const link = { 'text/uri-list': '# comment\r\nhttps://example.com/a\r\n', 'text/plain': 'x' }
    // WebKit fires drop instead of loading the URL itself only when the last dragenter or dragover
    // was cancelled: entering a new element, it takes the answer from dragenter.
    expect(engineSkipsDefault(drag('dragenter', target, link))).toBe(true)
    expect(engineSkipsDefault(drag('dragover', target, link))).toBe(true)
    // A drop zone that stops propagation does not hide the drop.
    target.addEventListener('drop', (event) => event.stopPropagation())
    expect(engineSkipsDefault(drag('drop', target, link))).toBe(true)
    await afterDispatch()
    expect(open).toHaveBeenCalledExactlyOnceWith('https://example.com/a')
  })

  it('leaves a dropped link to a zone that claims it', async () => {
    stop = watchLinkDrops(window, open)
    const target = mount('<div id="l"></div>')
    target.addEventListener('drop', (event) => event.preventDefault())
    drag('drop', target, { 'text/uri-list': 'https://example.com/icon.png' })
    await afterDispatch()
    expect(open).not.toHaveBeenCalled()
  })

  it('cancels a dropped link it does not open', async () => {
    stop = watchLinkDrops(window, open)
    const target = mount('<div id="l"></div>')
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'tauri://localhost/x']) {
      expect(engineSkipsDefault(drag('drop', target, { 'text/uri-list': url }))).toBe(true)
    }
    await afterDispatch()
    expect(open).not.toHaveBeenCalled()
  })

  it('leaves the editor, text fields, file drops and other drags alone', async () => {
    stop = watchLinkDrops(window, open)
    document.body.innerHTML =
      '<div class="ProseMirror"><p id="p">x</p></div><input id="i" /><div id="l"></div>'
    const link = { 'text/uri-list': 'https://example.com/' }
    const byId = (id: string): Element => document.getElementById(id) as Element
    for (const type of ['dragenter', 'dragover', 'drop'] as const) {
      expect(engineSkipsDefault(drag(type, byId('p'), link))).toBe(false)
      expect(engineSkipsDefault(drag(type, byId('i'), link))).toBe(false)
      expect(engineSkipsDefault(drag(type, byId('l'), { ...link, Files: '' }))).toBe(false)
      expect(engineSkipsDefault(drag(type, byId('l'), { 'text/plain': 'x' }))).toBe(false)
    }
    await afterDispatch()
    expect(open).not.toHaveBeenCalled()
  })
})
