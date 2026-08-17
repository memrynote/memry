import { describe, it, expect } from 'vitest'
import { elementLinkTarget, linkBubbleLabel, truncateLabel } from './canvas-link-label'

describe('linkBubbleLabel', () => {
  it('shows the title a link carries instead of its id', () => {
    expect(linkBubbleLabel('memry://note/s5b2qadr6tg4?label=memrynote%20Launch')).toBe(
      'memrynote Launch'
    )
  })

  it('works for every kind that carries a label', () => {
    expect(linkBubbleLabel('memry://task/t1?label=Ship%20it')).toBe('Ship it')
    expect(linkBubbleLabel('memry://inbox/i1?label=A%20clipped%20article')).toBe(
      'A clipped article'
    )
    expect(linkBubbleLabel('memry://file/f1?label=Spec.pdf')).toBe('Spec.pdf')
    expect(linkBubbleLabel('memry://project/p1?label=Launch')).toBe('Launch')
  })

  it('keeps the date param alongside the label for an event', () => {
    expect(linkBubbleLabel('memry://calendar/event/e1?date=2026-08-17&label=Standup')).toBe(
      'Standup'
    )
  })

  it('names a journal by its date even with no label', () => {
    expect(linkBubbleLabel('memry://journal/2026-08-17')).toBe('2026-08-17')
  })

  it('names a folder by its leaf even with no label', () => {
    expect(linkBubbleLabel('memry://folder/Work%2FNotes')).toBe('Notes')
  })

  it.each([
    ['a link written before labels existed', 'memry://note/n1'],
    ['a web address, where the URL is the honest label', 'https://example.com'],
    ['an unparseable link', 'memry//note/n1'],
    ['nothing', null],
    ['an empty href', '']
  ])('leaves %s alone', (_label, href) => {
    expect(linkBubbleLabel(href)).toBeNull()
  })
})

describe('elementLinkTarget', () => {
  it('names a card by the item it shows', () => {
    expect(
      elementLinkTarget('card-1', [
        { id: 'card-1', type: 'rectangle', customData: { entityType: 'note', entityId: 'n1' } }
      ])
    ).toEqual({ kind: 'entity', entityType: 'note', entityId: 'n1' })
  })

  it('names a text element by its own text', () => {
    expect(
      elementLinkTarget('t-1', [{ id: 't-1', type: 'text', text: 'memrynote Launch' }])
    ).toEqual({ kind: 'text', text: 'memrynote Launch' })
  })

  it('names a shape by the text bound into it', () => {
    expect(
      elementLinkTarget('r-1', [
        { id: 'r-1', type: 'rectangle' },
        { id: 't-1', type: 'text', text: 'Phase two', containerId: 'r-1' }
      ])
    ).toEqual({ kind: 'text', text: 'Phase two' })
  })

  it('reports a shape with nothing to name it by, rather than inventing one', () => {
    expect(elementLinkTarget('r-1', [{ id: 'r-1', type: 'ellipse' }])).toEqual({ kind: 'shape' })
  })

  it('ignores whitespace-only text', () => {
    expect(elementLinkTarget('t-1', [{ id: 't-1', type: 'text', text: '   ' }])).toEqual({
      kind: 'shape'
    })
  })

  it('reports a target that is gone', () => {
    expect(elementLinkTarget('missing', [{ id: 'r-1', type: 'rectangle' }])).toEqual({
      kind: 'missing'
    })
  })

  it('treats a deleted target as gone', () => {
    expect(elementLinkTarget('r-1', [{ id: 'r-1', type: 'rectangle', isDeleted: true }])).toEqual({
      kind: 'missing'
    })
  })

  it('does not read bound text off a deleted text element', () => {
    expect(
      elementLinkTarget('r-1', [
        { id: 'r-1', type: 'rectangle' },
        { id: 't-1', type: 'text', text: 'gone', containerId: 'r-1', isDeleted: true }
      ])
    ).toEqual({ kind: 'shape' })
  })
})

describe('truncateLabel', () => {
  it('collapses the newlines a multi-line text element carries', () => {
    expect(truncateLabel('Phase\n  two')).toBe('Phase two')
  })

  it('elides a label too long for the bubble', () => {
    expect(truncateLabel('x'.repeat(80))).toBe(`${'x'.repeat(47)}…`)
  })

  it('leaves a label that fits alone', () => {
    expect(truncateLabel('Phase two')).toBe('Phase two')
  })
})
