/**
 * More inputs for the `markdown-seed.json` class, in
 * [`MARKDOWN_SEED_CASES`](./markdown-seed-cases.ts): the writer's escapes and
 * spellings that decide a callout or a quote (`writer:`), an empty to-do under
 * any line, a lazy line after a quote, and math above a setext heading.
 */

export const MARKDOWN_SEED_MORE_CASES: ReadonlyArray<{
  name: string
  markdown: string
  pins: string
}> = [
  {
    name: 'writer: a callout whose italic ends in an escaped star',
    markdown: '> [!note]\n> *a\\**',
    pins: 'a callout: the writer spells the run `*a\\**`, so the body reproduces'
  },
  {
    name: 'writer: a callout whose bold ends in an escaped star',
    markdown: '> [!note]\n> **a\\***\n> y',
    pins: 'a callout: the writer spells the run `**a\\***`, so the body reproduces'
  },
  {
    name: 'writer: an underscore escaped beside runs spelled with underscores',
    markdown: '> snake_case *a*__b__\n>\n> z',
    pins: 'a structured quote: a block whose runs the writer spells with underscores escapes every `_` in its text, so `snake_case` is written `snake\\_case`, and the body settles'
  },
  {
    name: 'writer: an italic run touching a bold run',
    markdown: '> *a*__b__\n>\n> z',
    pins: 'a structured quote: stars against the stars of the run before open bold italic, so the writer spells the second run with underscores, `*a*__b__`'
  },
  {
    name: 'writer: a bold run touching an italic run in a callout',
    markdown: '> [!note]\n> **a**_b_\n> \\# x',
    pins: 'a callout: the italic run against the bold run is spelled `_b_`, and the line after the break keeps its escaped `#`'
  },
  {
    name: 'writer: an escaped star run touching a bold run',
    markdown: '> *a\\**__a__\n>\n> z',
    pins: "a structured quote: the second run is spelled with underscores against the first run's closing star"
  },
  {
    name: 'writer: a bold run ending in an escaped star after an italic run',
    markdown: '> _a_**a\\***\n>\n> z',
    pins: 'a structured quote: the bold run that ends in an escaped star keeps its stars against the underscore-spelled italic before it'
  },
  {
    name: 'writer: touching runs in a heading of a quote',
    markdown: '> ## *a\\**__a__\n>\n> z',
    pins: 'a structured quote whose first block is a heading with two runs against each other'
  },
  {
    name: 'writer: a code span with an underscore before touching runs',
    markdown: '> `a_` *b*__c__\n>\n> z',
    pins: 'a flat quote: a bare `_` in the code span could open a run that the underscore-spelled one would close, so the writer keeps stars, which the parser misreads, and the body does not settle'
  },
  {
    name: 'writer: a block start after a bold run ending in a break in a callout',
    markdown: '> [!note]\n> **b**\n> \\# x',
    pins: "a callout: the writer writes the break after the bold run's closing stars, so the `#` is at a line start and stays escaped"
  },
  {
    name: 'writer: a rule line after an italic run ending in a break in a callout',
    markdown: '> [!note]\n> *i*\n> \\---',
    pins: 'a callout: the escaped rule line after the italic run keeps its backslash'
  },
  {
    name: 'writer: a block start after a struck run ending in a break in a callout',
    markdown: '> [!note]\n> ~~s~~\n> \\# x',
    pins: "a callout: the break is written after the strike's closing delimiter, so the `#` stays escaped"
  },
  {
    name: 'writer: a list marker after a bold run ending in a break in a quote',
    markdown: '> lead\n>\n> **b**\n> \\- z',
    pins: 'a structured quote: the `-` after the bold run and its break stays escaped'
  },
  {
    name: 'writer: a block start after a link ending in a break in a callout',
    markdown: '> [!note]\n> [l](https://e.com)\n> \\- z',
    pins: "a callout: the break is written after the link's `](address)`, so the `-` stays escaped"
  },
  {
    name: 'writer: a block start after a link with parentheses ending in a break',
    markdown: '> [!note]\n> [l](https://e.com/a(1))\n> \\# x',
    pins: 'a callout: a link address with balanced parentheses, then a break and an escaped `#`'
  },
  {
    name: 'writer: a block start after a paragraph break',
    markdown: '**b**\n\\# x',
    pins: 'a paragraph of bold b, a break and the text `# x`'
  },
  {
    name: 'writer: an escaped image mark before a link in a callout',
    markdown: '> [!note]\n> \\![x](y)\n> \\# x',
    pins: 'a callout: the text `!`, a link x, a break and the text `# x`'
  },
  {
    name: 'writer: an escaped image mark before a link in a quote',
    markdown: '> \\![x](y)\n>\n> z',
    pins: 'a structured quote: the text `!` and a link x'
  },
  {
    name: 'empty to-do: under a heading',
    markdown: '# H\n- [ ]',
    pins: 'an empty check item under a heading: a to-do has no text for a paragraph to hold, so it counts after any line'
  },
  {
    name: 'empty to-do: under paragraph text',
    markdown: 'one\n- [x]',
    pins: 'a checked empty item after paragraph text, not a bullet of the text `[x]`'
  },
  {
    name: 'empty to-do: under a quote line',
    markdown: '> q\n- [ ]',
    pins: 'a quote line, then an empty check item'
  },
  {
    name: 'empty to-do: under a table row',
    markdown: '| b |\n- [ ]',
    pins: 'a paragraph of the row text and an empty check item after it'
  },
  {
    name: 'empty to-do: other bullets and an upper-case box',
    markdown: 'one\n* [X] \ntwo\n+ [ ]',
    pins: '`*` with `[X]` and `+` with `[ ]`, each an empty check item after paragraph text, and trailing blanks ignored'
  },
  {
    name: 'empty to-do: an empty bullet under text is still a setext underline',
    markdown: 'one\n-',
    pins: 'a bullet marker without a box stays text under a paragraph line: a paragraph, a break and `-`'
  },
  {
    name: 'writer: three stars after an italic run',
    markdown: '> *a***b**\n>\n> z',
    pins: 'a structured quote: the parser reads the three stars as no italic, the text *a and a bold *b'
  },
  {
    name: 'writer: three stars after a bold run',
    markdown: '> **a***b*\n>\n> z',
    pins: 'a structured quote of a bold a and an italic b: the writer spells the second run with underscores, which settles'
  },
  {
    name: 'writer: a code span holding a run of two backticks in a quote',
    markdown: '> `c``c`\n>\n> z',
    pins: 'a structured quote: the writer fences the code c``c with one backtick, the smallest count no run inside is, so the body reproduces; the longest run plus one would put three at a line start'
  },
  {
    name: 'writer: a code span holding a run of two backticks in a callout',
    markdown: '> [!note]\n> `c``c`',
    pins: 'a callout whose code span c``c is fenced with one backtick, as in the source'
  },
  {
    name: 'writer: a code span holding runs of one and three backticks',
    markdown: '> ``a`b```c``\n>\n> z',
    pins: 'a structured quote: the fence is two backticks, shorter than the four the longest run plus one would give'
  },
  {
    name: 'writer: a code span starting with a backtick and holding a run of three',
    markdown: '> `` `a```b ``\n>\n> z',
    pins: 'a structured quote: the code starts with a backtick, so the two-backtick fence is padded with a space each side'
  },
  {
    name: 'writer: a code span holding a run of one backtick',
    markdown: '> [!note]\n> `` a`b ``',
    pins: "a callout: the fewest backticks no run holds is two, the longest run plus one, so the spacing stays BlockNote's"
  },
  {
    name: 'lazy quote line: an image on the line after a quote',
    markdown: '> q\nsee ![x](u)',
    pins: "a structured quote of the paragraph q, a break and see, owning the image: the lazy line joins the quote's last paragraph, so the image is kept as a child"
  },
  {
    name: 'lazy quote line: a lazy line after a quote of blocks',
    markdown: '> q\n>\n> r\nlazy',
    pins: 'a structured quote whose second paragraph is r, a break and lazy: the lazy line is part of the last paragraph, not a paragraph after the quote'
  },
  {
    name: 'lazy quote line: a lazy line after a one-paragraph quote',
    markdown: '> q\nlazy\n\nafter',
    pins: 'a flat quote of q, a break and lazy, then a paragraph after the blank line'
  },
  {
    name: 'lazy quote line: a line after a quoted heading',
    markdown: '> # h\nz',
    pins: 'a quote owning a heading h, then a paragraph z: a run whose last line opens a block takes no lazy line'
  },
  {
    name: 'lazy quote line: a line after a callout',
    markdown: '> [!note]\n> c\nz',
    pins: 'a callout c, then a paragraph z: a callout body ends at its last `>` line'
  },
  {
    name: 'lazy quote line: a list item ends the run',
    markdown: '> q\n>\n> r\n- a',
    pins: 'a structured quote of q and r, then a bullet item: a list item is no lazy line'
  },
  {
    name: 'math above a setext heading: dashes',
    markdown: '$$\ny\n$$\nH\n---',
    pins: 'a math block y and a level 2 heading H: the parser ends a paragraph before a line with a setext underline below it, so the math owns its paragraph'
  },
  {
    name: 'math above a setext heading: equals signs',
    markdown: '$$\ny\n$$\nH\n===',
    pins: 'a math block y and a level 1 heading H'
  },
  {
    name: 'whitespace-only code span: a bullet item of it',
    markdown: '- ` `\n- b',
    pins: 'a bullet item holding a code span of one space, then b'
  },
  {
    name: 'whitespace-only code span: a numbered item and a quote of it',
    markdown: '1. `  `\n\n> `\t`',
    pins: 'a numbered item holding two spaces and a quote holding a tab, each as code'
  },
  {
    name: 'whitespace-only code span: bold around it',
    markdown: '**` `**',
    pins: 'a code span drops the bold around it: one code run of a space'
  },
  {
    name: 'empty-label link: in a line of text',
    markdown: 'x [](u) y',
    pins: 'a paragraph of x, an htmlComment node holding the link as written, and y: the address has no label to ride on'
  },
  {
    name: 'empty-label link: a paragraph of it after a paragraph',
    markdown: 'kq0xkq1x\n\n[](u)',
    pins: 'a paragraph holding only an htmlComment node: the link is the block, so no empty paragraph follows'
  },
  {
    name: 'empty-label link: a blank label with a title',
    markdown: '[ ](u "t")',
    pins: 'a paragraph holding the link as written, blank label and title included'
  },
  {
    name: 'empty-label link: in a bullet item, a quote and bold',
    markdown: '- [](u)\n\n> a [](v)\n\n**b [](w) c**',
    pins: 'each holds an htmlComment node; the bold keeps b and c around the node'
  },
  {
    name: 'empty-label link: in a table cell',
    markdown: '| a | b |\n| - | - |\n| [](u) | x |',
    pins: 'a cell holding an htmlComment node'
  },
  {
    name: 'empty-label link: beside an image',
    markdown: 'a [](u) ![i](v)',
    pins: 'an image has a node of its own and stays one, the link beside it is the htmlComment node'
  },
  {
    name: 'empty-label link: in a code span and after an escape',
    markdown: '`[](u)` \\[](v)',
    pins: 'a code span keeps the link as code, and an escaped bracket makes no link: both stay text'
  },
  {
    name: 'empty-label link across lines: in a line of text',
    markdown: 'a [](u\nv) b',
    pins: 'one paragraph of text with a soft break, brackets and address as written: a link whose address crosses a line is no node'
  },
  {
    name: 'empty-label link across lines: alone, a blank label and a title',
    markdown: '[](u\nv)\n\n[ ](u\nv "t")',
    pins: 'each paragraph keeps its source as text; the block is not dropped for holding only the link'
  },
  {
    name: 'empty-label link across lines: in a quote and a bullet item',
    markdown: '> [](u\n> v)\n\n- [](u\nv)',
    pins: 'the quote and the item keep the link as text'
  },
  {
    name: 'empty-label link across lines: inside link text',
    markdown: '[a [](u\nv) b](w)\n\n[[](u\nv)](w)',
    pins: 'the brackets of the text stay neutral to the label they sit in: one link whose label is the text, brackets included'
  },
  {
    name: 'empty-label link across lines: in an address and in a fence info string',
    markdown: '[b]([](u\nv))\n\n- a\n    ```[](u\nv)\n    x\n    ```',
    pins: 'an address is read as written, so its link is part of the address up to its whitespace; a fence info string holds no link'
  },
  {
    name: 'empty-label link across lines: then a link of one line',
    markdown: '[](u\nv)\n\n[](w)',
    pins: 'the second paragraph is still an htmlComment node: a link that stays text leaves the next one alone'
  }
]
