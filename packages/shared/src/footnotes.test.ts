import { describe, expect, it } from 'vitest'
import { scanFootnotes } from './footnotes'

function refs(markdown: string): Array<[string, number]> {
  return scanFootnotes(markdown).references.map((ref) => [
    markdown.slice(ref.start, ref.end),
    ref.number
  ])
}

describe('scanFootnotes', () => {
  it('numbers notes by first reference, not by label or definition order', () => {
    const markdown = 'B[^b] then A[^a] then B again[^b].\n\n[^a]: Alpha.\n[^b]: Beta.'
    expect(refs(markdown)).toEqual([
      ['[^b]', 1],
      ['[^a]', 2],
      ['[^b]', 1]
    ])
    expect(scanFootnotes(markdown).definitions.map((d) => [d.label, d.number, d.text])).toEqual([
      ['a', 2, 'Alpha.'],
      ['b', 1, 'Beta.']
    ])
  })

  it('matches labels without regard to case', () => {
    expect(refs('Ref[^Note].\n\n[^note]: Text.')).toEqual([['[^Note]', 1]])
  })

  it('leaves a reference with no definition as text', () => {
    expect(refs('Missing[^x] here.\n\n[^y]: Unused.')).toEqual([])
    expect(scanFootnotes('Missing[^x] here.\n\n[^y]: Unused.').definitions[0].number).toBeNull()
  })

  it('ignores references and definitions in code', () => {
    const markdown = 'Use `[^1]` here.\n\n```\nx[^1]\n[^1]: in a fence\n```\n\n[^1]: Real.'
    expect(refs(markdown)).toEqual([])
    expect(scanFootnotes(markdown).definitions.map((d) => d.text)).toEqual(['Real.'])
  })

  it('leaves an inline footnote as text', () => {
    expect(scanFootnotes('Inline ^[note] here.')).toEqual({ references: [], definitions: [] })
  })

  it('reads an indented continuation as part of the definition', () => {
    const markdown =
      'Ref[^1].\n\n[^1]: First line\n    second line.\n\n    Second paragraph.\n\nAfter.'
    const [definition] = scanFootnotes(markdown).definitions
    expect(definition.text).toBe('First line\nsecond line.\n\nSecond paragraph.')
    expect(markdown.slice(definition.start, definition.end)).toBe(
      '[^1]: First line\n    second line.\n\n    Second paragraph.'
    )
  })

  it('gives offsets into a CRLF note', () => {
    const markdown = 'Ref[^1].\r\n\r\n[^1]: Text.\r\nAfter'
    expect(refs(markdown)).toEqual([['[^1]', 1]])
    const [definition] = scanFootnotes(markdown).definitions
    expect(markdown.slice(definition.start, definition.end)).toBe('[^1]: Text.\r\nAfter')
    expect(definition.text).toBe('Text.\nAfter')
  })

  it('reads a label as ending at the next bracket, so a run of `[^` stays linear', () => {
    expect(refs('x[^a[^b] y\n\n[^b]: B.')).toEqual([['[^b]', 1]])
    const start = performance.now()
    scanFootnotes('[^'.repeat(50_000) + '\n\n[^b]: B.')
    expect(performance.now() - start).toBeLessThan(1000)
  })

  it('does not read a definition marker as a reference', () => {
    expect(refs('[^1]: Only a definition.')).toEqual([])
  })
})
