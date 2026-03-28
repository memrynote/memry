import { describe, expect, it } from 'vitest'
import {
  splitMarkdownPreservingBlanks,
  assembleMarkdownWithBlanks,
  type MarkdownSegment
} from './empty-lines'

// ---------------------------------------------------------------------------
// splitMarkdownPreservingBlanks
// ---------------------------------------------------------------------------

describe('splitMarkdownPreservingBlanks', () => {
  it('returns single content segment for standard markdown (no extra blanks)', () => {
    // #given
    const md = 'Hello\n\nWorld'

    // #when
    const result = splitMarkdownPreservingBlanks(md)

    // #then — \n\n is standard paragraph break, no split
    expect(result).toEqual([{ type: 'content', text: 'Hello\n\nWorld' }])
  })

  it('splits on 3 consecutive newlines (1 extra blank line)', () => {
    // #given
    const md = 'Hello\n\n\nWorld'

    // #when
    const result = splitMarkdownPreservingBlanks(md)

    // #then — 3 newlines = 2 blank lines visible, 1 extra beyond standard
    expect(result).toEqual([
      { type: 'content', text: 'Hello' },
      { type: 'gap', extraLines: 1 },
      { type: 'content', text: 'World' }
    ])
  })

  it('splits on 6 consecutive newlines (4 extra blank lines)', () => {
    // #given
    const md = 'Hello\n\n\n\n\n\nWorld'

    // #when
    const result = splitMarkdownPreservingBlanks(md)

    // #then — 6 newlines = 5 blank lines visible, 4 extra
    expect(result).toEqual([
      { type: 'content', text: 'Hello' },
      { type: 'gap', extraLines: 4 },
      { type: 'content', text: 'World' }
    ])
  })

  it('handles multiple gap regions', () => {
    // #given
    const md = 'A\n\n\nB\n\n\n\nC'

    // #when
    const result = splitMarkdownPreservingBlanks(md)

    // #then
    expect(result).toEqual([
      { type: 'content', text: 'A' },
      { type: 'gap', extraLines: 1 },
      { type: 'content', text: 'B' },
      { type: 'gap', extraLines: 2 },
      { type: 'content', text: 'C' }
    ])
  })

  it('preserves code blocks with internal blank lines (no split)', () => {
    // #given — 4 newlines inside code block should NOT trigger a split
    const md = 'Before\n\n```python\ndef foo():\n    pass\n\n\n\n    return 1\n```\n\nAfter'

    // #when
    const result = splitMarkdownPreservingBlanks(md)

    // #then — entire thing is one content segment
    expect(result).toEqual([{ type: 'content', text: md }])
  })

  it('splits outside code blocks but preserves inside', () => {
    // #given — 3+ newlines BEFORE code block, but not inside
    const md = 'Hello\n\n\n\n```\ncode\n```\n\nAfter'

    // #when
    const result = splitMarkdownPreservingBlanks(md)

    // #then
    expect(result).toEqual([
      { type: 'content', text: 'Hello' },
      { type: 'gap', extraLines: 2 },
      { type: 'content', text: '```\ncode\n```\n\nAfter' }
    ])
  })

  it('splits after code block with extra blank lines', () => {
    // #given
    const md = '```\ncode\n```\n\n\n\nAfter'

    // #when
    const result = splitMarkdownPreservingBlanks(md)

    // #then
    expect(result).toEqual([
      { type: 'content', text: '```\ncode\n```' },
      { type: 'gap', extraLines: 2 },
      { type: 'content', text: 'After' }
    ])
  })

  it('handles tilde code fences (~~~)', () => {
    // #given
    const md = 'Before\n\n~~~\ncode\n\n\n\n~~~\n\nAfter'

    // #when
    const result = splitMarkdownPreservingBlanks(md)

    // #then — blank lines inside ~~~ fence should not split
    expect(result).toEqual([{ type: 'content', text: md }])
  })

  it('handles leading extra blank lines', () => {
    // #given
    const md = '\n\n\nHello'

    // #when
    const result = splitMarkdownPreservingBlanks(md)

    // #then
    expect(result).toEqual([
      { type: 'gap', extraLines: 1 },
      { type: 'content', text: 'Hello' }
    ])
  })

  it('handles trailing extra blank lines', () => {
    // #given
    const md = 'Hello\n\n\n'

    // #when
    const result = splitMarkdownPreservingBlanks(md)

    // #then
    expect(result).toEqual([
      { type: 'content', text: 'Hello' },
      { type: 'gap', extraLines: 1 }
    ])
  })

  it('returns empty array for empty input', () => {
    expect(splitMarkdownPreservingBlanks('')).toEqual([])
  })

  it('returns empty array for whitespace-only input', () => {
    expect(splitMarkdownPreservingBlanks('\n\n')).toEqual([])
  })

  it('handles single line with no newlines', () => {
    // #given
    const md = 'Hello World'

    // #when
    const result = splitMarkdownPreservingBlanks(md)

    // #then
    expect(result).toEqual([{ type: 'content', text: 'Hello World' }])
  })

  it('preserves standard blank lines within content segments', () => {
    // #given — multiple paragraphs separated by single blank lines (standard)
    const md = 'Para 1\n\nPara 2\n\nPara 3'

    // #when
    const result = splitMarkdownPreservingBlanks(md)

    // #then — no splitting; all standard \n\n separators
    expect(result).toEqual([{ type: 'content', text: 'Para 1\n\nPara 2\n\nPara 3' }])
  })

  it('handles mixed standard and extra blank lines', () => {
    // #given
    const md = 'A\n\nB\n\n\n\nC\n\nD'

    // #when
    const result = splitMarkdownPreservingBlanks(md)

    // #then — split only at the 4-newline gap
    expect(result).toEqual([
      { type: 'content', text: 'A\n\nB' },
      { type: 'gap', extraLines: 2 },
      { type: 'content', text: 'C\n\nD' }
    ])
  })
})

// ---------------------------------------------------------------------------
// assembleMarkdownWithBlanks
// ---------------------------------------------------------------------------

describe('assembleMarkdownWithBlanks', () => {
  it('returns single segment as-is', () => {
    // #given
    const segments: MarkdownSegment[] = [{ type: 'content', text: 'Hello\n\nWorld' }]

    // #when
    const result = assembleMarkdownWithBlanks(segments)

    // #then
    expect(result).toBe('Hello\n\nWorld')
  })

  it('joins two content segments with correct blank line count', () => {
    // #given — 2 extra blank lines between segments
    const segments: MarkdownSegment[] = [
      { type: 'content', text: 'Hello' },
      { type: 'gap', extraLines: 2 },
      { type: 'content', text: 'World' }
    ]

    // #when
    const result = assembleMarkdownWithBlanks(segments)

    // #then — \n\n (standard) + \n\n (2 extra) = 4 newlines total
    expect(result).toBe('Hello\n\n\n\nWorld')
  })

  it('joins with 1 extra blank line', () => {
    // #given
    const segments: MarkdownSegment[] = [
      { type: 'content', text: 'A' },
      { type: 'gap', extraLines: 1 },
      { type: 'content', text: 'B' }
    ]

    // #when
    const result = assembleMarkdownWithBlanks(segments)

    // #then — 3 newlines total
    expect(result).toBe('A\n\n\nB')
  })

  it('handles multiple gaps', () => {
    // #given
    const segments: MarkdownSegment[] = [
      { type: 'content', text: 'A' },
      { type: 'gap', extraLines: 1 },
      { type: 'content', text: 'B' },
      { type: 'gap', extraLines: 3 },
      { type: 'content', text: 'C' }
    ]

    // #when
    const result = assembleMarkdownWithBlanks(segments)

    // #then
    expect(result).toBe('A\n\n\nB\n\n\n\n\nC')
  })

  it('handles leading gap', () => {
    // #given
    const segments: MarkdownSegment[] = [
      { type: 'gap', extraLines: 2 },
      { type: 'content', text: 'Hello' }
    ]

    // #when
    const result = assembleMarkdownWithBlanks(segments)

    // #then — leading: \n\n (standard) + \n\n (2 extra) before content
    expect(result).toBe('\n\n\n\nHello')
  })

  it('handles trailing gap', () => {
    // #given
    const segments: MarkdownSegment[] = [
      { type: 'content', text: 'Hello' },
      { type: 'gap', extraLines: 2 }
    ]

    // #when
    const result = assembleMarkdownWithBlanks(segments)

    // #then
    expect(result).toBe('Hello\n\n\n\n')
  })

  it('returns empty string for empty segments', () => {
    expect(assembleMarkdownWithBlanks([])).toBe('')
  })

  it('round-trips: split then assemble preserves original', () => {
    // #given
    const original = 'Hello\n\n\n\nWorld\n\n\n\n\n\nEnd'

    // #when
    const segments = splitMarkdownPreservingBlanks(original)
    const result = assembleMarkdownWithBlanks(segments)

    // #then
    expect(result).toBe(original)
  })

  it('round-trips standard markdown (no extra blanks)', () => {
    // #given
    const original = 'Hello\n\nWorld'

    // #when
    const segments = splitMarkdownPreservingBlanks(original)
    const result = assembleMarkdownWithBlanks(segments)

    // #then
    expect(result).toBe(original)
  })

  it('round-trips with code blocks', () => {
    // #given
    const original = 'Before\n\n\n\n```\ncode\n\n\n\nmore\n```\n\n\n\nAfter'

    // #when
    const segments = splitMarkdownPreservingBlanks(original)
    const result = assembleMarkdownWithBlanks(segments)

    // #then
    expect(result).toBe(original)
  })
})
