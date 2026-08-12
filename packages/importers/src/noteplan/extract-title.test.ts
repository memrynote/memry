import { describe, it, expect } from 'vitest'
import { firstHeading, stripFirstHeading } from './extract-title.ts'

describe('firstHeading', () => {
  it('returns the first H1 text', () => {
    expect(firstHeading('# Start Here\nsome body')).toBe('Start Here')
  })

  it('ignores deeper headings and only takes H1', () => {
    expect(firstHeading('## Agenda\n# Real Title')).toBe('Real Title')
  })

  it('ignores an H1 inside a fenced code block', () => {
    expect(firstHeading('```\n# not a title\n```\n# Real Title')).toBe('Real Title')
  })

  it('returns null when there is no H1', () => {
    expect(firstHeading('just text\n- a bullet')).toBeNull()
  })
})

describe('stripFirstHeading', () => {
  it('removes exactly the line firstHeading found', () => {
    expect(stripFirstHeading('# Start Here\nsome body')).toBe('some body')
  })

  it('leaves an identical line inside a code fence alone', () => {
    expect(stripFirstHeading('```\n# Real Title\n```\n# Real Title\nbody')).toBe(
      '```\n# Real Title\n```\nbody'
    )
  })

  it('returns the body unchanged when there is no H1', () => {
    expect(stripFirstHeading('just text')).toBe('just text')
  })
})
