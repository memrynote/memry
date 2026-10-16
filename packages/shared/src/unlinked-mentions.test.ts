import { describe, expect, it } from 'vitest'
import { findUnlinkedMentions, linkUnlinkedMention } from './unlinked-mentions'

const texts = (markdown: string, names: string[]) =>
  findUnlinkedMentions(markdown, names).map((mention) => mention.text)

describe('findUnlinkedMentions', () => {
  it('skips text that is already a link, a URL, code or a comment', () => {
    const markdown = [
      'The plan is [[Plan]] and [[Other|plan]] and ![[plan.png]].',
      'See [the plan](https://x.test/plan) or https://plan.test/plan.',
      'Inline `plan` here, <!-- plan --> there.',
      '```',
      'plan',
      '```',
      'Final Plan.'
    ].join('\n')
    expect(texts(markdown, ['Plan'])).toEqual(['plan', 'Plan'])
  })

  it('offsets index the original markdown', () => {
    const markdown = '`x` Roadmap'
    const [mention] = findUnlinkedMentions(markdown, ['roadmap'])
    expect(markdown.slice(mention.start, mention.end)).toBe('Roadmap')
  })
})

describe('linkUnlinkedMention', () => {
  it('links the chosen mention with the text as the label', () => {
    expect(linkUnlinkedMention('the plan, the roadmap', ['Plan', 'Roadmap'], 1, 'Plan')).toBe(
      'the plan, the [[Plan|roadmap]]'
    )
  })

  it('writes a bare link when the text already spells the title', () => {
    expect(linkUnlinkedMention('A Plan', ['Plan'], 0, 'Plan')).toBe('A [[Plan]]')
  })

  it('returns null when the mention is gone', () => {
    expect(linkUnlinkedMention('nothing here', ['Plan'], 0, 'Plan')).toBeNull()
  })
})

describe('masking stays linear', () => {
  it('scans adversarial runs quickly', () => {
    const started = performance.now()
    findUnlinkedMentions('['.repeat(50_000) + 'a'.repeat(50_000) + 'plan', ['plan'])
    findUnlinkedMentions('a'.repeat(100_000) + ':', ['plan'])
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
