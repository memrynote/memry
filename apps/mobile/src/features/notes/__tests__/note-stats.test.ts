import { describe, expect, it } from 'vitest'

import {
  calculateWordCount,
  formatStatTimestamp,
  readingTimeLabel,
  wordCountLabel
} from '@/features/notes/note-stats'

describe('note stats', () => {
  // The same fixture desktop's frontmatter.test.ts pins, so the two platforms
  // are provably counting the same thing.
  it('ignores code blocks and inline code, like desktop', () => {
    const content = `
Here is some text with \`inline code\` and more words.

\`\`\`
const value = 1
\`\`\`

Another line with words.
`
    expect(calculateWordCount(content)).toBe(12)
  })

  it('rounds reading time up at 200 words per minute', () => {
    expect(readingTimeLabel(0)).toBe('0 min read')
    expect(readingTimeLabel(1)).toBe('1 min read')
    expect(readingTimeLabel(201)).toBe('2 min read')
  })

  it('singularises one word', () => {
    expect(wordCountLabel(1)).toBe('1 word')
    expect(wordCountLabel(0)).toBe('0 words')
  })

  it('formats timestamps relative to today', () => {
    const now = new Date(2026, 8, 9, 18, 51)
    expect(formatStatTimestamp(new Date(2026, 8, 9, 18, 36).getTime(), now)).toBe('Today at 18:36')
    expect(formatStatTimestamp(new Date(2026, 8, 8, 9, 4).getTime(), now)).toBe(
      'Yesterday at 09:04'
    )
    expect(formatStatTimestamp(new Date(2026, 7, 26, 7, 5).getTime(), now)).toBe(
      '26 Aug 2026 at 07:05'
    )
    expect(formatStatTimestamp(null, now)).toBe('—')
  })
})
