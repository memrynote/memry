import { describe, expect, it } from 'vitest'
import { escapeMarkdownText } from './markdown-escapes'

type Run = { type: string; text: string; styles: Record<string, unknown> }

const run = (text: string, styles: Record<string, unknown> = {}): Run => ({
  type: 'text',
  text,
  styles
})

/** What the writer spells of `runs`: each run's escaped text, in its marks' delimiters. */
const spelled = (runs: Run[]): Array<[string, string[]]> =>
  escapeMarkdownText(runs, 'paragraph').map((item) => [item.text, Object.keys(item.styles)])

describe('escapeMarkdownText around a tag a mark boundary cuts', () => {
  it('takes the marks off the tag and merges the pieces into one run', () => {
    expect(spelled([run('<kq a="'), run('*', { bold: true }), run('">')])).toEqual([
      ['<kq a="*">', []]
    ])
  })

  it('keeps the marks on what is outside the tag', () => {
    expect(spelled([run('a '), run('b <kq a="x', { bold: true }), run('"> c')])).toEqual([
      ['a ', []],
      ['b ', ['bold']],
      ['<kq a="x"> c', []]
    ])
  })

  it('takes a code mark off the characters inside the tag too', () => {
    expect(spelled([run('<kq a="'), run('x', { code: true }), run('">')])).toEqual([
      ['<kq a="x">', []]
    ])
  })

  it('leaves a tag inside one run, with or without a mark, as it is', () => {
    expect(spelled([run('<kq a="*">', { bold: true })])).toEqual([['<kq a="*">', ['bold']]])
    expect(spelled([run('x '), run('<kq a="*"> y', { italic: true })])).toEqual([
      ['x ', []],
      ['<kq a="*"> y', ['italic']]
    ])
  })

  it('cuts each tag of a group and leaves the runs between them marked', () => {
    expect(
      spelled([
        run('<b'),
        run('>x</b', { bold: true }),
        run('>'),
        run(' y ', { italic: true }),
        run('<kq a="'),
        run('z', { strike: true }),
        run('">')
      ])
    ).toEqual([
      ['\\<b>', []],
      ['x', ['bold']],
      ['\\</b>', []],
      [' y ', ['italic']],
      ['<kq a="z">', []]
    ])
  })

  it('does not look for a tag across a link or a node', () => {
    const link = { type: 'link', href: 'u', content: [run('x', { bold: true })] }
    const items = [run('<kq a="'), link, run('">')]
    expect(escapeMarkdownText(items as never, 'paragraph')).toHaveLength(3)
  })

  it('cuts a tag inside a link label', () => {
    const link = {
      type: 'link',
      href: 'u',
      content: [run('<kq a="'), run('*', { bold: true }), run('">')]
    }
    const [out] = escapeMarkdownText([link] as never, 'paragraph') as unknown as Array<{
      content: Run[]
    }>
    expect(out.content.map((item) => item.text)).toEqual(['<kq a="*">'])
  })
})
