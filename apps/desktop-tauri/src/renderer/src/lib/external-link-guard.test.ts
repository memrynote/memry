import { afterEach, describe, expect, it, vi } from 'vitest'

import { watchExternalLinks } from './external-link-guard'

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

describe('watchExternalLinks', () => {
  let stop = (): void => undefined
  const open = vi.fn(() => Promise.resolve())
  const start = (): void => {
    stop = watchExternalLinks(document, open, ORIGIN)
  }
  afterEach(() => {
    stop()
    open.mockClear()
  })

  it('sends a clicked web or mail link to the OS and keeps the page', () => {
    start()
    for (const href of [
      'https://example.com/a?b=1',
      'http://example.com/',
      'mailto:hi@memrynote.com'
    ]) {
      const link = mount(`<a id="l" href="${href}"><span id="inner">x</span></a>`)
      const event = click(link.querySelector('#inner') ?? link)
      expect(event.defaultPrevented, href).toBe(true)
      expect(open).toHaveBeenLastCalledWith(new URL(href).href)
    }
  })

  it('leaves every other click to the page', () => {
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
      expect(event.defaultPrevented, html).toBe(false)
    }
    expect(open).not.toHaveBeenCalled()
  })

  it('does not take a link a component already claimed', () => {
    start()
    const link = mount('<a id="l" href="https://example.com/">x</a>')
    link.addEventListener('click', (event) => event.preventDefault())
    click(link)
    expect(open).not.toHaveBeenCalled()
  })

  it('stops listening after the cleanup', () => {
    start()
    stop()
    click(mount('<a id="l" href="https://example.com/">x</a>'))
    expect(open).not.toHaveBeenCalled()
  })
})
