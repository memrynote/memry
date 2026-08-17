import { describe, it, expect } from 'vitest'
import { linkBubbleLabel } from './canvas-link-label'

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
