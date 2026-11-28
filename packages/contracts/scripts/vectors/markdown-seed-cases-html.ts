/**
 * More inputs for the `markdown-seed.json` class, in
 * [`MARKDOWN_SEED_CASES`](./markdown-seed-cases.ts): raw HTML the editor has
 * no node for, which stays text in the document (`parse-markdown.ts`,
 * `inline/raw-html.ts`). The tags the editor does handle are not here: the
 * core keeps their lines as literal text, as it always has.
 */

import { serializeLinkMentionToken } from '@memry/editor-schema/inline'

const mention = serializeLinkMentionToken

export const MARKDOWN_SEED_HTML_CASES: ReadonlyArray<{
  name: string
  markdown: string
  pins: string
}> = [
  {
    name: 'raw html: tags the editor does not render stay text',
    markdown: 'a <kbd>Ctrl</kbd>+<kbd>K</kbd> b <sup>2</sup> <mark>m</mark> <x-y> <kq/>',
    pins: 'each tag is the characters it was written with, in one paragraph with the words around it'
  },
  {
    name: 'raw html: a block tag does not split its paragraph',
    markdown: 'kq0 <div> kq1\nkq2 <p>kq3\n<article>\nkq4 <summary>s</summary>',
    pins: 'a tag at a line start or in a line is text, so the four lines are one paragraph with soft breaks'
  },
  {
    name: 'raw html: a script and a style keep their bodies',
    markdown: '<script>kq9</script>\n\nkq0 <style>kq8</style> kq1',
    pins: 'the body of a script or a style is text between its two tags'
  },
  {
    name: 'raw html: a declaration, an instruction and a CDATA section',
    markdown: 'a <!x> b <?x?> c <![CDATA[x]]> d',
    pins: 'each construct is read whole and stays text'
  },
  {
    name: 'raw html: a tag that is not complete hides only its angle bracket',
    markdown: 'a <div\n\nb <kq\nc> d\n\ne <?x f <![CDATA[x g\n\n<1> < kq> h<',
    pins: 'an unfinished tag, a tag across two lines and an angle bracket that opens nothing are text, and the rest of the line is read as markdown'
  },
  {
    name: 'raw html: the characters inside a tag are not markdown',
    markdown: 'a <x a="*b*"> c <x a="_" b="_"> d _e_ *f*',
    pins: 'no stars or underscores inside a tag pair with each other or with a mark outside it'
  },
  {
    name: 'raw html: emphasis beside and between tags',
    markdown: '<kbd>_x_</kbd> a_<kbd> **b**<kbd>**c**</kbd> _<kbd>_',
    pins: 'a mark next to or between tags is read as it was with the angle brackets there'
  },
  {
    name: 'raw html: a tag with a pipe in it splits a table row',
    markdown: '| a | b |\n| - | - |\n| <x a="|"> c | <y> |',
    pins: 'a row splits at a pipe before it reads a tag, so the tag with a pipe keeps only its angle bracket as text'
  },
  {
    name: 'raw html: in a quote, a list item, a heading and a table cell',
    markdown:
      '> kq0 <kbd>x</kbd> kq1\n\n- kq2 <kbd>y</kbd>\n- kq3 <div>\n\n# kq4 <kbd>z</kbd>\n\n| a <kbd>h</kbd> | b |\n| - | - |\n| c <kbd>c</kbd> | d |',
    pins: 'a tag is text wherever the block holds inline content'
  },
  {
    name: 'raw html: in code, as written',
    markdown: 'a `<kbd>` b `` <x a="*"> `` c <kbd>\n\n```\n<div>\n<script>kq9</script>\n```',
    pins: 'a tag in a code span or a fence is the code, and the tag after the spans is text'
  },
  {
    name: 'raw html: in a link label, a link address and an image alt',
    markdown: '[a <kbd>x</kbd>](https://e.com/<kq>) ![b <kbd>y</kbd>](https://e.com/i.png)',
    pins: 'a tag in a label, an address or an alt is text there'
  },
  {
    name: 'raw html: after a backslash',
    markdown: 'a \\<kq> b \\\\<kq> c',
    pins: 'a backslash before a tag stays text beside it, and a pair of backslashes before one is a single backslash'
  },
  {
    name: 'raw html: in a toggle summary and a callout',
    markdown:
      '<details data-memry-toggle>\n<summary>kq0 <kbd>x</kbd></summary>\n\nkq1 <div> kq2\n\n</details>\n\n> [!note]\n> kq3 <kbd>y</kbd>',
    pins: 'a summary, its body and a callout keep the tags as text'
  },
  {
    name: 'raw html: beside a hard break',
    markdown: 'kq0 <kbd>x</kbd>  \nkq1 <kbd>y</kbd>\\\nkq2',
    pins: 'a tag at the end of a line keeps the line break that follows it'
  },
  {
    name: 'raw html: a token beside a tag and a tag holding a token',
    markdown: `<kbd>${mention('https://example.com/a')}</kbd> b <x t="${mention('https://example.com/b')}"> c`,
    pins: 'a token is hidden before the tags are read, so the tag around it is text and a tag that holds one is text with the token put back and promoted after it'
  },
  {
    name: 'raw html: an angle bracket inside a token',
    markdown: 'a ((mention:https%3A%2F%2Fexample.com%2F<kbd>x)) b <kbd>y</kbd>',
    pins: 'the angle bracket in a token payload opens no tag, and the tag after the token is text'
  },
  {
    name: 'raw html: a backslash before a tag the editor handles',
    markdown:
      'a \\<b>x\\</b> \\<a href="u">y\\</a> \\<br> \\<ul>\\<li>z\\</li>\\</ul> \\<input type=checkbox> \\<kq> \\\\<kq> \\\\\\<i>',
    pins: 'the backslash escapes the angle bracket of a handled tag, so the tag is text and the backslash is gone; before a tag the editor does not handle it stays text, a pair is one backslash, and a third escapes the tag after them'
  },
  {
    name: 'raw html: an escaped tag in a quote, a list item, a heading and a table cell',
    markdown:
      '> kq0 \\<b>x\\</b>\n\n- kq1 \\<i>y\\</i>\n\n# kq2 \\<u>z\\</u>\n\n| a | b |\n| - | - |\n| c \\<s>d\\</s> | e |\n\n**kq3 \\<b>f\\</b>** [g \\<i>h\\</i>](https://e.com)',
    pins: 'an escaped tag is text wherever the block holds inline content, inside a mark and a link label too'
  },
  {
    name: 'raw html: a backslash before a span',
    markdown:
      'a \\<span style="color:red">x\\</span> \\<span>y\\</span> \\<span class="k">z\\</span> \\</span> b',
    pins: 'the backslash escapes the angle bracket of a span tag, coloured or plain, so the tag is text and the backslash is gone, and no span tag closes or ends a colour'
  },
  {
    name: 'raw html: an escaped tag in a details line no toggle claimed',
    markdown:
      '<details>\n<summary>kq0 \\<b>x\\</b> \\<i>y\\</i> z</summary>\nkq1\n</details>\n\n<summary>\\<a href="u">w\\</a></summary>',
    pins: 'the backslash escapes the angle bracket of a handled tag on a details markup line too, so the line is the text it spells with the tag bare and the backslash is gone'
  },
  {
    name: 'raw html: escaped tags past the nesting cap',
    markdown: `${'\\<b>'.repeat(150)}x${'\\</b>'.repeat(150)}`,
    pins: 'an escaped tag opens nothing and counts toward no cap, so a hundred and fifty of them are text'
  }
]
