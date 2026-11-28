import { describe, expect, it } from 'vitest'
import { RAW_HTML_MAX_NESTING as CAP, scanRawHtml } from './raw-html'

/** The source of each range the scan hides in `markdown`. */
function hidden(markdown: string): string[] {
  return scanRawHtml(markdown, true).map(({ start, end }) => markdown.slice(start, end))
}

const repeat = (count: number, make: (index: number) => string, join = ''): string =>
  Array.from({ length: count }, (_, index) => make(index)).join(join)

describe('what the nesting cap counts', () => {
  describe('tags the parse closes by itself', () => {
    it.each([
      ['list items', `<ul>\n${repeat(150, (i) => `<li>${i}`, '\n')}`],
      ['rows of cells', `<table>\n${repeat(150, (i) => `<tr><td>a${i}<td>b${i}`, '\n')}`],
      ['header cells', `<table><tr>${repeat(150, () => '<th>h')}`],
      ['table sections', `<table>${repeat(150, () => '<thead><tr><td>a<tbody><tr><td>b<tfoot>')}`],
      ['captions', `<table>${repeat(150, () => '<caption>c')}`],
      ['headings', repeat(150, () => '<h1>a<h2>b')],
      ['links', repeat(150, (i) => `<a href=u${i}>x`)]
    ])('holds one of %s at a time', (_label, markdown) => {
      expect(hidden(markdown)).toEqual([])
    })

    it('closes a cell, and what is in it, when the next cell opens', () => {
      expect(hidden(`<table><tr>${repeat(150, () => '<td><ul><li><b>x')}`)).toEqual([])
    })

    it('does not look past a list for the item it closes', () => {
      // Each `<li>` is the first of a list the one before it holds: two tags a level.
      expect(hidden(repeat(CAP / 2, () => '<ul><li>'))).toEqual([])
      expect(hidden(repeat(CAP / 2 + 1, () => '<ul><li>')).length).toBeGreaterThan(0)
    })
  })

  describe('marks a paragraph ends', () => {
    it('lets paragraphs of the same unclosed mark pile up to three', () => {
      expect(hidden(repeat(150, (i) => `<b>x${i}`, '\n\n'))).toEqual([])
    })

    it('counts the marks of one paragraph, soft breaks and all', () => {
      expect(hidden(repeat(CAP + 5, () => '<b>x', '\n'))).toHaveLength(5)
    })

    it('counts every different mark a paragraph leaves in the active list', () => {
      const markdown = repeat(CAP + 5, (i) => `<b data-n="${i}">x`, '\n\n')
      expect(hidden(markdown)).toHaveLength(5)
    })

    it('forgets a mark its closing tag closes', () => {
      expect(hidden(repeat(5 * CAP, (i) => `<b data-n="${i}">x</b>`, '\n\n'))).toEqual([])
    })

    it('ends the marks of a heading, a list item and a cell at the blank line after', () => {
      expect(hidden(repeat(5 * CAP, () => '# <b>x\n- <i>y\n\n| <u>z |\n| - |', '\n\n'))).toEqual([])
    })
  })

  describe('marks a list item or a table cell ends', () => {
    it.each([
      ['bullets', repeat(105, (i) => `- <i>item${i}`, '\n')],
      ['numbered items', repeat(105, (i) => `${i + 1}. <i>item${i}`, '\n')],
      ['quoted bullets', repeat(105, (i) => `> - <i>item${i}`, '\n')],
      ['nested bullets', `- a\n${repeat(105, (i) => `  - <i>item${i}`, '\n')}`],
      ['rows of cells', `| a | b |\n| - | - |\n${repeat(105, (i) => `| <b>c${i} | x |`, '\n')}`],
      ['cells of a row', `${repeat(106, () => '| <b>c')} |\n${repeat(106, () => '| -')} |`]
    ])('holds the identical marks of %s three at a time', (_label, markdown) => {
      expect(hidden(markdown)).toEqual([])
    })

    it('still counts the different marks each item leaves in the active list', () => {
      expect(hidden(repeat(CAP + 5, (i) => `- <b data-n="${i}">x`, '\n'))).toHaveLength(5)
      const rows = repeat(CAP + 5, (i) => `| <b data-n="${i}">x |`, '\n')
      expect(hidden(`| a |\n| - |\n${rows}`)).toHaveLength(5)
    })

    it.each([
      ['a pipe in a paragraph', repeat(CAP + 5, () => 'a | <b>x', '\n')],
      ['pipes of one line, no table', repeat(CAP + 5, () => '| <b>x ', '')],
      [
        'a numbered line that continues a paragraph',
        `a\n${repeat(CAP + 5, (i) => `${i + 2}. <b>x`, '\n')}`
      ],
      ['an indented line', `a\n${repeat(CAP + 5, () => '    - <b>x', '\n')}`]
    ])('does not end the marks of %s', (_label, markdown) => {
      expect(hidden(markdown)).toHaveLength(5)
    })
  })

  describe('tags outside a paragraph', () => {
    it('keeps the tags of an HTML block open past the blank line after it', () => {
      expect(hidden(repeat(CAP + 5, () => '<blockquote>x', '\n\n'))).toHaveLength(5)
    })

    it('keeps the tags after a tag that closes its paragraph open past the blank line', () => {
      expect(hidden(repeat(CAP + 5, () => 'a <ul>x', '\n\n'))).toHaveLength(5)
      expect(hidden(repeat(CAP + 5, () => 'a <pre>x', '\n\n'))).toHaveLength(5)
    })

    it('closes the marks a tag that closes its paragraph found in it', () => {
      expect(hidden(repeat(5 * CAP, (i) => `<b data-n="${i}">x</b> <ul>y</ul>`, '\n\n'))).toEqual(
        []
      )
    })

    it('reads a line that opens a block tag as an HTML block even after a paragraph line', () => {
      const markdown = repeat(CAP + 5, () => '<b>x\n<ul>y', '\n\n')
      expect(hidden(markdown).length).toBeGreaterThan(0)
    })
  })

  describe('closing tags', () => {
    it('closes the innermost open tag of its name, and what is in it', () => {
      // 90 open, three lists closed, 16 more: 100, where 106 would be past the cap.
      expect(
        hidden(`${repeat(45, () => '<ul><li>')}x</ul></ul></ul>${repeat(8, () => '<ul><li>')}`)
      ).toEqual([])
    })

    it('does not see past a cell to the list around the table', () => {
      // `</ul>` cannot close the list outside the table, so the table stays open.
      const markdown = repeat(60, () => '<ul><table><tr><td>x</ul>')
      expect(hidden(markdown).length).toBeGreaterThan(0)
    })

    it('reads a closing tag that closes nothing as written', () => {
      expect(hidden(repeat(5 * CAP, () => '</ul></li></b>'))).toEqual([])
    })

    it('ends a toggle at its closing tag', () => {
      const toggles = repeat(150, () => '<details data-memry-toggle>\nx\n</details>', '\n\n')
      expect(hidden(toggles).filter((tag) => tag.startsWith('<details'))).toEqual([])
    })
  })

  it('takes a tag it closed the count of back, so a note keeps what follows', () => {
    const markdown = `${repeat(CAP + 3, () => '<b>')}x${repeat(CAP + 3, () => '</b>')} <b>y</b>`
    expect(hidden(markdown)).toEqual(['<b>', '<b>', '<b>', '</b>', '</b>', '</b>'])
  })
})
