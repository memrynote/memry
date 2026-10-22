import { describe, expect, it } from 'vitest'
import { markdownPreviewText } from './markdown-preview-text'

describe('markdownPreviewText', () => {
  it('reads a note the way the editor shows it, not the way the file stores it', () => {
    const file = [
      '--- start-multi-column: n101-cols',
      '```column-settings',
      'Number of Columns: 3',
      'Column Size: [25%, 50%, 25%]',
      '```',
      '',
      'Left',
      '',
      '--- end-column ---',
      '',
      'The middle column is wider.',
      '<details data-open="true">',
      '<summary>More</summary>',
      '--- end-multi-column'
    ].join('\n')

    expect(markdownPreviewText(file)).toBe('Left The middle column is wider. More')
  })

  it('drops structure markers and keeps the words', () => {
    const file = [
      '# Title',
      '',
      '> [!note] Heads up',
      '> Be careful',
      '',
      '- [ ] open task',
      '- [x] done task',
      '1. first',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |'
    ].join('\n')

    expect(markdownPreviewText(file)).toBe(
      'Title Heads up Be careful open task done task first a b 1 2'
    )
  })

  it('shows the label of a link and nothing for an image or embed', () => {
    expect(
      markdownPreviewText(
        'See [[Plan|the plan]] and [[Other]], [site](https://x.test) ![pic](a.png) ![[Embed]]'
      )
    ).toBe('See the plan and Other, site')
  })

  it('strips emphasis, code marks, comments and footnote references', () => {
    expect(
      markdownPreviewText('**bold** _it_ ~~gone~~ ==hi== `code`<!-- hidden --> %%note%% end[^1]')
    ).toBe('bold it gone hi code end')
  })

  it('leaves out code blocks and a leading frontmatter block', () => {
    expect(markdownPreviewText('---\ntitle: x\n---\nBody\n\n```ts\nconst a = 1\n```\nAfter')).toBe(
      'Body After'
    )
  })

  it('cuts at a word boundary with an ellipsis, and returns null for no text', () => {
    const text = markdownPreviewText('word '.repeat(100), 40)
    expect(text).toMatch(/^(word ?)+…$/)
    expect(text!.length).toBeLessThanOrEqual(41)
    expect(markdownPreviewText('---\n```js\nx\n```\n<!-- only -->')).toBeNull()
  })
})
