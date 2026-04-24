import { describe, it, expect } from 'vitest'
import { assignLabels, extractElementText } from './label-assigner'

const mockRect = (el: HTMLElement): void => {
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
      toJSON: () => ({})
    }) as DOMRect
}

const mockElement = (text: string, ariaLabel?: string): HTMLElement => {
  const el = document.createElement('button')
  el.textContent = text
  if (ariaLabel) el.setAttribute('aria-label', ariaLabel)
  mockRect(el)
  return el
}

describe('extractElementText', () => {
  it('returns textContent trimmed', () => {
    const el = mockElement('  Hello World  ')
    expect(extractElementText(el)).toBe('Hello World')
  })

  it('prefers aria-label over textContent', () => {
    const el = mockElement('X', 'Close dialog')
    expect(extractElementText(el)).toBe('Close dialog')
  })

  it('falls back to title attribute', () => {
    const el = document.createElement('button')
    el.setAttribute('title', 'Settings')
    expect(extractElementText(el)).toBe('Settings')
  })

  it('returns empty string when no text found', () => {
    const el = document.createElement('button')
    expect(extractElementText(el)).toBe('')
  })
})

describe('assignLabels', () => {
  it('assigns single-char mnemonic for unique first letters', () => {
    const elements = [mockElement('Inbox'), mockElement('Journal'), mockElement('Tasks')]
    const hints = assignLabels(elements)
    expect(hints.map((h) => h.label)).toEqual(['I', 'J', 'T'])
  })

  it('assigns two-char labels when first letters conflict', () => {
    const elements = [mockElement('Tags'), mockElement('Tasks')]
    const hints = assignLabels(elements)
    expect(hints[0].label).toBe('TA')
    expect(hints[1].label).toBe('TS')
  })

  it('falls back to sequential codes for three-way conflicts with same second letter', () => {
    const elements = [mockElement('AA'), mockElement('AB'), mockElement('AA')]
    const hints = assignLabels(elements)
    const labels = hints.map((h) => h.label)
    expect(labels).toHaveLength(3)
    expect(new Set(labels).size).toBe(3)
  })

  it('assigns sequential codes for elements with no text', () => {
    const el1 = document.createElement('button')
    const el2 = document.createElement('button')
    ;[el1, el2].forEach(mockRect)
    const hints = assignLabels([el1, el2])
    expect(hints[0].label).toMatch(/^[A-Z]{2}$/)
    expect(hints[1].label).toMatch(/^[A-Z]{2}$/)
    expect(hints[0].label).not.toBe(hints[1].label)
  })

  it('avoids prefix collisions between single and two-char labels', () => {
    const elements = [
      mockElement('Inbox'),
      mockElement('Journal'),
      mockElement(''),
      mockElement('')
    ]
    const hints = assignLabels(elements)
    const singleChars = hints.filter((h) => h.label.length === 1).map((h) => h.label)
    const twoChars = hints.filter((h) => h.label.length === 2).map((h) => h.label)

    for (const sc of singleChars) {
      for (const tc of twoChars) {
        expect(tc.startsWith(sc)).toBe(false)
      }
    }
  })

  it('is case insensitive — labels are uppercase', () => {
    const elements = [mockElement('inbox')]
    const hints = assignLabels(elements)
    expect(hints[0].label).toBe('I')
  })

  it('skips non-ASCII first letters and assigns sequential code', () => {
    const elements = [mockElement('日本語')]
    const hints = assignLabels(elements)
    expect(hints[0].label).toMatch(/^[A-Z]{2}$/)
  })

  it('handles single element', () => {
    const hints = assignLabels([mockElement('Only')])
    expect(hints).toHaveLength(1)
    expect(hints[0].label).toBe('O')
  })

  it('handles empty input', () => {
    const hints = assignLabels([])
    expect(hints).toHaveLength(0)
  })

  it('preserves element references in output', () => {
    const el = mockElement('Test')
    const hints = assignLabels([el])
    expect(hints[0].element).toBe(el)
  })

  it('includes rect in output', () => {
    const hints = assignLabels([mockElement('Test')])
    expect(hints[0].rect).toBeDefined()
    expect(hints[0].rect.width).toBe(100)
  })
})
