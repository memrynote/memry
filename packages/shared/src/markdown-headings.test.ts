import { describe, expect, it } from 'vitest'
import { extractMarkdownHeadings, stripInlineMarkdown } from './markdown-headings'

describe('extractMarkdownHeadings', () => {
  it('reads every ATX level in document order', () => {
    const markdown = ['# One', '## Two', '### Three', '#### Four', '##### Five', '###### Six'].join(
      '\n'
    )

    expect(extractMarkdownHeadings(markdown)).toEqual([
      { text: 'One', level: 1 },
      { text: 'Two', level: 2 },
      { text: 'Three', level: 3 },
      { text: 'Four', level: 4 },
      { text: 'Five', level: 5 },
      { text: 'Six', level: 6 }
    ])
  })

  it('ignores hashes inside fenced code blocks', () => {
    const markdown = [
      '# Real',
      '',
      '```bash',
      '# not a heading',
      '```',
      '',
      '~~~',
      '## also not a heading',
      '```',
      '~~~',
      '',
      '## Real again'
    ].join('\n')

    expect(extractMarkdownHeadings(markdown)).toEqual([
      { text: 'Real', level: 1 },
      { text: 'Real again', level: 2 }
    ])
  })

  it('ignores lines that only look like headings', () => {
    const markdown = ['#NoSpace', '    # indented four spaces', '###', 'plain text', '#'].join('\n')

    expect(extractMarkdownHeadings(markdown)).toEqual([])
  })

  it('drops a closing hash sequence but keeps a trailing hash in a word', () => {
    expect(extractMarkdownHeadings('## Sprint ##')).toEqual([{ text: 'Sprint', level: 2 }])
    expect(extractMarkdownHeadings('## C#')).toEqual([{ text: 'C#', level: 2 }])
  })

  it('strips inline markdown so the text matches what the editor renders', () => {
    const markdown = ['## **Kalın** başlık', '## `code` and [link](https://x.dev)'].join('\n')

    expect(extractMarkdownHeadings(markdown)).toEqual([
      { text: 'Kalın başlık', level: 2 },
      { text: 'code and link', level: 2 }
    ])
  })

  it('handles CRLF line endings', () => {
    expect(extractMarkdownHeadings('# One\r\n\r\n## Two\r\n')).toEqual([
      { text: 'One', level: 1 },
      { text: 'Two', level: 2 }
    ])
  })
})

describe('stripInlineMarkdown', () => {
  it('unwraps emphasis, strike and inline code', () => {
    expect(stripInlineMarkdown('***all*** **bold** *em* ~~gone~~ `code`')).toBe(
      'all bold em gone code'
    )
    expect(stripInlineMarkdown('_em_ and __strong__')).toBe('em and strong')
  })

  it('leaves intraword underscores alone', () => {
    expect(stripInlineMarkdown('snake_case_name')).toBe('snake_case_name')
  })

  it('reduces links, wiki links and images to their text', () => {
    expect(stripInlineMarkdown('[text](https://x.dev)')).toBe('text')
    expect(stripInlineMarkdown('[[Note|Alias]] and [[Other]]')).toBe('Alias and Other')
    expect(stripInlineMarkdown('Before ![alt](img.png) after')).toBe('Before after')
  })

  it('collapses whitespace the way the editor does', () => {
    expect(stripInlineMarkdown('  two   spaces  ')).toBe('two spaces')
  })
})
