import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { scanClickableElements } from './dom-scanner'

const HINT_OVERLAY_ID = 'hint-mode-overlay'

const mockRect = (el: HTMLElement, rect: Partial<DOMRect> = {}): void => {
  el.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      width: 100,
      height: 30,
      top: 0,
      left: 0,
      bottom: 30,
      right: 100,
      toJSON: () => ({}),
      ...rect
    }) as DOMRect
}

const mockOffsetParent = (el: HTMLElement, parent: Element | null = document.body): void => {
  Object.defineProperty(el, 'offsetParent', { value: parent, configurable: true })
}

const createEl = (tag: string, attrs: Record<string, string> = {}, text = ''): HTMLElement => {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  if (text) el.textContent = text
  document.body.appendChild(el)
  mockRect(el)
  mockOffsetParent(el)
  return el
}

describe('scanClickableElements', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('finds buttons', () => {
    createEl('button', {}, 'Click me')
    const results = scanClickableElements()
    expect(results).toHaveLength(1)
    expect(results[0].tagName).toBe('BUTTON')
  })

  it('finds anchor links', () => {
    createEl('a', { href: '/test' }, 'Link')
    const results = scanClickableElements()
    expect(results).toHaveLength(1)
  })

  it('finds role=button elements', () => {
    createEl('div', { role: 'button' }, 'Fake button')
    const results = scanClickableElements()
    expect(results).toHaveLength(1)
  })

  it('finds role=tab elements', () => {
    createEl('div', { role: 'tab' }, 'Tab')
    const results = scanClickableElements()
    expect(results).toHaveLength(1)
  })

  it('finds role=treeitem elements', () => {
    createEl('div', { role: 'treeitem' }, 'Tree item')
    const results = scanClickableElements()
    expect(results).toHaveLength(1)
  })

  it('finds role=menuitem elements', () => {
    createEl('div', { role: 'menuitem' }, 'Menu item')
    const results = scanClickableElements()
    expect(results).toHaveLength(1)
  })

  it('finds role=option elements', () => {
    createEl('div', { role: 'option' }, 'Option')
    const results = scanClickableElements()
    expect(results).toHaveLength(1)
  })

  it('finds tabindex elements (not -1)', () => {
    createEl('div', { tabindex: '0' }, 'Focusable')
    const results = scanClickableElements()
    expect(results).toHaveLength(1)
  })

  it('excludes tabindex=-1', () => {
    createEl('div', { tabindex: '-1' }, 'Not focusable')
    const results = scanClickableElements()
    expect(results).toHaveLength(0)
  })

  it('finds data-hint elements', () => {
    createEl('span', { 'data-hint': '' }, 'Custom hint')
    const results = scanClickableElements()
    expect(results).toHaveLength(1)
  })

  it('excludes disabled elements', () => {
    createEl('button', { disabled: '' }, 'Disabled')
    const results = scanClickableElements()
    expect(results).toHaveLength(0)
  })

  it('excludes aria-disabled elements', () => {
    createEl('button', { 'aria-disabled': 'true' }, 'Disabled')
    const results = scanClickableElements()
    expect(results).toHaveLength(0)
  })

  it('excludes elements inside hint overlay', () => {
    const overlay = document.createElement('div')
    overlay.id = HINT_OVERLAY_ID
    const btn = document.createElement('button')
    btn.textContent = 'Inside overlay'
    mockRect(btn)
    mockOffsetParent(btn, overlay)
    overlay.appendChild(btn)
    document.body.appendChild(overlay)

    const results = scanClickableElements()
    expect(results).toHaveLength(0)
  })

  it('returns empty array when no clickable elements exist', () => {
    createEl('div', {}, 'Plain text')
    const results = scanClickableElements()
    expect(results).toHaveLength(0)
  })
})
