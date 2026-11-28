/**
 * Inputs for the `markdown-seed.json` class (spec 005-journal JP022a): the
 * template markdown a journal day is seeded from, and the edge cases of the
 * path desktop turns it into a document with.
 *
 * Every case stays inside the constructs the core's seed builds
 * (`crates/memry-core/src/crdt/markdown_seed/mod.rs`); the generator refuses
 * one that reaches a desktop layer it does not reproduce.
 */

import { MARKDOWN_SEED_HTML_CASES } from './markdown-seed-cases-html'
import { MARKDOWN_SEED_LEAK_CASES } from './markdown-seed-cases-leaks'
import { MARKDOWN_SEED_MASK_CASES } from './markdown-seed-cases-masks'
import { MARKDOWN_SEED_MENTION_CASES } from './markdown-seed-cases-mentions'
import { MARKDOWN_SEED_MORE_CASES } from './markdown-seed-cases-more'

export const MARKDOWN_SEED_CASES: ReadonlyArray<{ name: string; markdown: string; pins: string }> =
  [
    {
      name: 'journal: morning and gratitude',
      markdown: '## Morning\n- [ ] \n\n## Gratitude\n1. \n2. \n',
      pins: 'an empty check item and two empty numbered items: a marker alone on its line is an empty item, after a blank line or another item'
    },
    {
      name: 'journal: date heading after substitution',
      markdown: '# Monday, June 15, 2099\n\n## Notes\n',
      pins: 'a substituted {{date}} heading'
    },
    {
      name: 'journal: evening review',
      markdown:
        '## Evening\n- [ ] Stretch\n- [x] Read **one chapter**\n\n### What went well\n1. \n\n### Tomorrow\n- \n',
      pins: 'headings 2 and 3, checked and unchecked items, a trailing `- ` trimmed to a paragraph'
    },
    {
      name: 'journal: inline marks',
      markdown:
        'Felt **focused**, *calm* and ~~rushed~~ with `deep work` — see [plan](https://example.com/plan)',
      pins: 'bold, italic, strike, code and a link'
    },
    {
      name: 'journal: wiki link and tag stay text',
      markdown: 'Continue from [[2099-06-14]] and [[Project Atlas|Atlas]] #journal',
      pins: 'wiki links and tags are plain text in the fragment'
    },
    {
      name: 'journal: code block with language',
      markdown: '## Snippet\n\n```ts\nconst mood = 7\n\nlog(mood)\n```\n',
      pins: 'a fenced code block keeps its language and its blank line'
    },
    {
      name: 'journal: untagged fence',
      markdown: '```\nplain\n```',
      pins: 'an untagged fence gets language "" instead of BlockNote\'s default'
    },
    {
      name: 'journal: indented code has no language',
      markdown: 'Log:\n\n    tail -f app.log',
      pins: 'an indented run becomes a code block with language "", like an untagged fence (BBF-114)'
    },
    {
      name: 'journal: quote',
      markdown: '> The obstacle is the way.\n> — Marcus Aurelius',
      pins: 'a quote of one paragraph, a soft break inside'
    },
    {
      name: 'journal: divider between sections',
      markdown: '## Plan\n\n---\n\n## Review',
      pins: 'a divider'
    },
    {
      name: 'journal: nested lists',
      markdown: '- Work\n  - Ship JP022\n    - [ ] vectors\n- Home\n  1. Groceries\n  2. Laundry',
      pins: 'nesting by indentation, mixed list types under one item'
    },
    {
      name: 'journal: ordered list start',
      markdown: '3. third\n4. fourth',
      pins: 'the first item of a list that does not start at 1 carries start'
    },
    {
      name: 'journal: ordered start dropped under a nested list',
      markdown: '5. five\n   - sub',
      pins: 'a nested list wraps the item and its start is lost'
    },
    {
      name: 'journal: list item continuation',
      markdown: '- Idea\n  details on the next line',
      pins: 'an indented line under an item is a child paragraph'
    },
    {
      name: 'journal: all heading levels',
      markdown: '# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6',
      pins: 'levels 1 to 6'
    },
    {
      name: 'journal: setext headings',
      markdown: 'Title\n=====\n\nSub\n---',
      pins: 'setext levels 1 and 2'
    },
    {
      name: 'journal: soft and hard breaks',
      markdown: 'line one\nline two  \nline three\\\nline four',
      pins: 'a soft break is one hardBreak, a hard break two'
    },
    {
      name: 'journal: code span drops other marks',
      markdown: '**`x`** and [`y`](https://example.com)',
      pins: 'the code mark excludes bold; a code span in a link is the link text with its backticks'
    },
    {
      name: 'journal: code span with backticks in a bold link',
      markdown: '[**``a`b``** c](https://example.com)',
      pins: 'the fence is rebuilt from the code, and the link keeps the marks around it'
    },
    {
      name: 'journal: link title and escaped space in an address',
      markdown: '[a](https://example.com "T here") and [b](u\\ y)',
      pins: 'a destination with whitespace is the href as written, title and escape included (BBF-109)'
    },
    {
      name: 'journal: unsafe link is text',
      markdown: '[click](javascript:alert)',
      pins: 'a link the mark refuses keeps its text unmarked'
    },
    {
      name: 'edge: empty string',
      markdown: '',
      pins: 'an empty document is one empty blockGroup'
    },
    {
      name: 'edge: only blank lines',
      markdown: '\n\n\n',
      pins: 'blank lines alone make no block'
    },
    {
      name: 'edge: one trailing newline',
      markdown: 'Hello\n',
      pins: 'a single trailing newline adds nothing'
    },
    {
      name: 'edge: two trailing newlines',
      markdown: 'Hello\n\n\n',
      pins: 'trailing blank lines beyond the first become empty paragraphs'
    },
    {
      name: 'edge: extra blank lines between blocks',
      markdown: 'a\n\n\n\nb',
      pins: 'blank lines beyond a paragraph break become empty paragraphs'
    },
    {
      name: 'edge: leading blank lines and indent',
      markdown: '\n\n   indented start',
      pins: "leading blank lines and the first line's indent are trimmed"
    },
    {
      name: 'edge: escapes and emphasis rules',
      markdown: '\\*not italic\\* snake_case __init__ a*b*c',
      pins: 'escapes, intraword underscores, intraword asterisks'
    },
    {
      name: 'edge: unicode and whitespace',
      markdown: 'ünïcode 😀  two  spaces\tand tab',
      pins: 'text without a newline keeps its whitespace'
    },
    {
      name: 'table: header, marks and alignment row',
      markdown:
        '| Name | Value |\n|:---|---:|\n| **alpha** | `1` |\n| [beta](https://e.com/b) | ~~2~~ |',
      pins: 'a pipe table: tableHeader cells first, marked runs in tableParagraphs'
    },
    {
      name: 'table: ragged rows and escaped pipes',
      markdown: '| a | b |\n|---|---|\n| one |\n| x \\| y | z | extra |',
      pins: 'a row wider than the header widens the table; short rows and the header get empty cells; an escaped pipe stays in its cell'
    },
    {
      name: 'table: a code span holds its pipes',
      markdown: '| `a|b` | y |\n|---|---|\n| [l](https://e.com) | `p|q` |\n| `x\\|y` | ` | ` |',
      pins: 'a pipe inside a code span splits no cell, in a header, beside a link, and spaced; an escaped one is the pipe'
    },
    {
      name: 'table: rows wider than the header',
      markdown:
        '|  |  |\n|---|---|\n| 1 | 2 | 3 |\n\na | b\n---|---\n1 | 2 | 3 | 4\n\n- x\n  | h |\n  |---|\n  | 1 | 2 |\n| 3 | 4 | 5 |',
      pins: 'a blank header stays absent; a table without outer pipes widens; a table in a list item widens to its own rows only'
    },
    {
      name: 'table: a header spelled like a delimiter row widens',
      markdown: '| --- |\n|---|\n| 1 | 2 |',
      pins: 'a header row spelled like a delimiter row gains a column for each cell a body row has past it, as any header does'
    },
    {
      name: 'table: blank header and cell image',
      markdown: '|  |  |\n|---|---|\n| x ![i](https://e.com/i.png) y | `a  b` |',
      pins: 'a blank header row is dropped; an image in a cell is an inlineImage; code keeps its spaces'
    },
    {
      name: 'table: wiki link alias and text around',
      markdown: 'Before\n\n| [[Roadmap|the plan]] | b |\n|---|---|\n| 1 | 2 |\n\nAfter',
      pins: "a wiki link's alias pipe stays in its cell"
    },
    {
      name: 'image: standalone lines, width and video',
      markdown:
        'Intro\n![chart|300](https://e.com/c.png)\n![](https://e.com/clip.mp4 "Clip")\n![photo](assets/p.png)',
      pins: 'an image line is its own block; `|300` is previewWidth; a video address is a video block named by its title'
    },
    {
      name: 'image: lifted out of text and headings',
      markdown:
        'see ![x](https://e.com/a.png) now\n\n# Title ![y](https://e.com/b.png)\n\nlink [![z](https://e.com/c.png)](https://e.com/p) here',
      pins: 'an image in a paragraph or heading moves after it; a linked image leaves its alt as the link text'
    },
    {
      name: 'embed: youtube, bookmark, whiteboard and file',
      markdown:
        '![My video](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10)\n![bookmark](https://www.example.com/post)\n![whiteboard](memry://canvas/abc_1-2)\n<!-- file:{"url":"memry-file://x.pdf","name":"x.pdf","size":3,"mimeType":"application/pdf"} -->\n![bookmark](assets/photo.png)',
      pins: 'one-line embed markers become their blocks; a bookmark that is no web address stays an image'
    },
    {
      name: 'callout: types, fold and children',
      markdown:
        '> [!note]\n> Callout **body**\n\n> [!tip]-\n> Folded\n\n> [!warning]\n> own line\n>\n> child paragraph\n\n> [!info]',
      pins: 'a lowercase built-in marker claims its body; `-` folds it closed; a blank `>` line starts its children'
    },
    {
      name: 'callout: shapes desktop leaves as quotes',
      markdown:
        '> [!NOTE]\n> GitHub alert\n\n> [!info] Title\n> body\n\n> [!tip]\n> an _italic_ word',
      pins: 'an uppercase or titled marker, or a body that does not serialize back byte for byte, stays a quote'
    },
    {
      name: 'callout: bare marker heals',
      markdown: '[!info]\nbody text',
      pins: 'a marker that lost its `> ` heals into a callout over the paragraph below'
    },
    {
      name: 'math: block and inline dollars',
      markdown: '$$\n\\int_0^1 x\\,dx\n$$\n\nInline $x$ stays text\n\n$$ one line $$',
      pins: 'a `$$` fence in its written form is a mathBlock; inline and one-line dollars stay text'
    },
    {
      name: 'math: a fence after another block',
      markdown: 'one\n\n$$\nx\n$$\n\n$$\ny\n$$\n\n- a\n\n$$\nz\n$$\n\ntwo\n$$\nw\n$$',
      pins: 'a fence after a blank line is a mathBlock whatever block sits above; one that continues a paragraph stays text'
    },
    {
      name: 'quote: separated paragraphs',
      markdown: '> **lead**\n>\n> second *para*',
      pins: 'a blank `>` line makes a quote whose later paragraphs are its children'
    },
    {
      name: 'toggle: memry toggles and foreign details',
      markdown:
        '<details data-memry-toggle open>\n<summary>Toggle **title**</summary>\n\nHidden body\n\n<details data-memry-toggle>\n<summary>Inner</summary>\n\n- a\n\n</details>\n\n</details>\n\n\n<details>\n<summary>Click</summary>\nForeign\n</details>',
      pins: "Memry's toggle nests; a gap at its edge is kept; a foreign `<details>` stays text"
    },
    {
      name: 'mermaid: diagram fence',
      markdown: '```mermaid\ngraph TD\n  A-->B\n```\n\n```js\nx\n```',
      pins: 'a mermaid fence is a diagram block with its source as plain content'
    },
    {
      name: 'columns: prose and a non-column div stay markdown',
      markdown:
        '# Title\n\n**bold** and a multi-column layout\n\n::: note\nThis is a note\n:::\n\n- item',
      pins: 'only a line-anchored column region opener changes the whole read; the word or a `:::` div of another class does not'
    },
    {
      name: 'soft break: after a styled, coded or linked run',
      markdown: '**b**\nfoo\n\n[l](https://e.com)\nfoo\n\n*a*\n`c`\nd\n\n**a**\n[b](https://e.com)',
      pins: "the line after a run that ends in a soft break loses the parser's leading space, whatever the run's marks"
    },
    {
      name: 'soft break: inside link text',
      markdown: '[a\nb](https://e.com)\n\n**[a](https://e.com)\n[b](https://e.com)**',
      pins: 'link text is repaired too, and a run left holding only the artifact is removed'
    },
    {
      name: 'callout: styled first body line',
      markdown: '> [!note]\n> **b**\n> plain\n\n> `c`\n> [!tip] x',
      pins: 'a body line after a styled run serializes back to its bytes, so the callout is claimed; a marker on a later line stays a quote'
    },
    {
      name: 'hard break: spaces before a backslash break',
      markdown: 'foo \\\nbar\n\n**b** \t\\\nc',
      pins: "the whitespace before a hard break is part of the break's spelling, as with two trailing spaces"
    },
    {
      name: 'hard break: a lazy line after a list item joins it',
      markdown: '- a  \nb\n- [ ] c\\\nd\n\n1. e  \nf  \ng\n\n- h\ni  \nj',
      pins: 'a hard break in a list item keeps the lazy line after it in the item (BBF-99); a soft break does not'
    },
    {
      name: 'hard break: a soft break inside list-item link text',
      markdown: '- [a\nb](https://e.com)\n- x [c\nd\ne](https://e.com) y',
      pins: 'the item keeps one link holding the break (BBF-106)'
    },
    {
      name: 'hard break: inside image alt text',
      markdown: '![a  \nb](https://e.com/i.png)',
      pins: "an image's name gets the break's spelling back, never the token"
    },
    {
      name: 'hard break: inside a fence another fence closed',
      markdown: '```\ncode\n```mermaid\na  \nb',
      pins: 'a hard-break token that lands in a code block gets its spelling back, never the token'
    },
    {
      name: 'hard break: in a nested fence opener',
      markdown: '- a\n    ```  \n    x\n```',
      pins: "a hard-break token in a code block's language gets its spelling back, as every string prop does"
    },
    {
      name: 'line endings: CRLF and CR',
      markdown: '# Title\r\n\r\n| a |\r\n|---|\r\n| 1 |\r\nlast\rline',
      pins: 'CRLF and a lone CR read as LF'
    },
    {
      name: 'comment: %% inside a paragraph',
      markdown: 'Tail %% [[Topic]] secret %% end.\n\n%% a %% and %% b %%\n\nx%%y%%z',
      pins: 'an Obsidian comment is an htmlComment node whose source keeps its %% delimiters, however it is surrounded; two in a row are two nodes'
    },
    {
      name: 'comment: a stray %% stays text',
      markdown: 'Save 50%% today\n\n`x %%`\n\n```\n%%\n```',
      pins: 'a %% with no partner outside code is text; a %% in a code span or a fence is not a partner'
    },
    {
      name: 'comment: %% inside emphasis',
      markdown: '*a %% b %% c*\n\n**x %% y %% z**\n\n~~s %% t %% u~~',
      pins: 'the node sits between runs that keep the surrounding marks'
    },
    {
      name: 'comment: %% block on its own lines',
      markdown: '%%\nblock [[Other]] secret\n%%\n\nText',
      pins: 'a multi-line comment is one node in a paragraph of its own, and the text after it a second paragraph'
    },
    {
      name: 'comment: %% glued to the line above and below',
      markdown:
        'one\n%% hidden %%\ntwo\n\n# H\n%% c %%\n\n%% d %%\n- item\n\n%% e %%\n> quote\n\n%% f %%\n---',
      pins: 'a comment on the line before or after a block kind joins that line into the paragraph it touches, as desktop masks it before any line is split'
    },
    {
      name: 'comment: %% in code stays code',
      markdown: '`a %% b %% c`\n\n```\n%% x %%\n```\n\n    %% y %%\n\n~~~\n%%\n~~~',
      pins: 'a code span, a fence and an indented code block keep their %% as text'
    },
    {
      name: 'comment: %% holding a blank line and a fence',
      markdown: '%%\nline\n\n```\ncode\n```\n%%\nend',
      pins: 'a comment is masked before any line is split, so a blank line or a fence inside it stays inside the one node'
    },
    {
      name: 'comment: %% in list items, a heading and a link label',
      markdown:
        '- item %% c %% tail\n- [ ] todo %% d %%\n\n## Title %% e %%\n\n[a %% b %% c](https://e.com) and `x`',
      pins: 'a comment is a node in a list item and a heading, and the plain text of a link label'
    },
    {
      name: 'comment: %% in a table cell',
      markdown: '| a | b %% c %% |\n|---|---|\n| 1 | 2 %% open |',
      pins: 'a comment that closes inside its cell is a node, one that crosses the cell end is text'
    },
    {
      name: 'comment: %% in a callout body and a quote',
      markdown: '> [!note]\n> body %% c %%\n> more\n\n> quoted %% d %%',
      pins: 'a callout or quote body holding a comment is not claimed: desktop serializes the comment back as its source, which is not the masked run, so the proof fails and the quote stays flat'
    },
    {
      name: 'parity: image address through the DOM',
      markdown:
        '![a](http://e.com)\n\n![b](HTTP://E.com:80/x/../y?q=1#f)\n\n![c](assets/x.png)\n\n![d](https://e.com/a%20b.png)\n\n![e](memry-file://Abc/v.png)',
      pins: "an absolute address is the WHATWG serialization jsdom's img.src gives (lowercase scheme and host, no default port, resolved dot segments, a root path); a relative one stays as written"
    },
    {
      name: 'parity: code span with a leading space on a pipe line',
      markdown: '` |`é\n\n` a|`b\n\n- ` |`c\n\n` a`d',
      pins: 'a line with a pipe hides its code spans whitespace from the repair, so the leading space stays; a line without one strips it as the parser does'
    },
    {
      name: 'parity: paragraph of whitespace-only code spans and breaks',
      markdown: '`\n`\n`\n`\n\n`\n`\n`\n`\n`\n`\n\n`\n`\nx\n`\n`\n\n` `\\\n` `',
      pins: 'a paragraph with no visible text is parsed with collapsed whitespace: leading, repeated and trailing blanks go, a blank right after a break goes, a blank between breaks stays'
    },
    {
      name: 'callout: escaped markup in the body',
      markdown:
        '> [!note]\n> a \\*b\\* c \\`d\\` e \\_f\\_ g\n\n> [!tip]\n> first\n> \\# x\n> 1\\. y\n\n> [!info]\n> a \\~\\~z\\~\\~ and [w\\](v)',
      pins: 'a body whose escapes the writer puts back (paired `*`, backticks and `_`, a `#` or `1.` opening a line, `~~`, a `]` before `(`) serializes to its bytes, so each is a callout'
    },
    {
      name: 'callout: unpaired markup stays unescaped',
      markdown:
        '> [!note]\n> 5 * 3 and a_b_c and [[_draft]] and 2 * 4\n\n> [!tip]\n> a ! b ~ c ] d',
      pins: 'text that pairs nothing keeps its bytes: a spaced `*`, an intraword `_`, a `_` in a wiki link, a lone `!`, `~` or `]` are written as they are, so each is a callout'
    },
    {
      name: 'quote: blank separator and escaped markup',
      markdown: '> lead \\*x\\* and \\`y\\`\n>\n> second \\_z\\_ and 5 * 3',
      pins: 'a quote whose paragraphs hold escaped markup and a spaced `*` is claimed with its later paragraph as a child'
    },
    {
      name: 'callout: hard break and escaped markup in the body',
      markdown:
        '> [!tip]\n> line one  \n> line \\*two\\*\n> \\- three\n\n> [!note]\n> soft\n> \\> four',
      pins: 'a hard break keeps its spelling in the proof, and the line after it opens with an escaped `*`, `-` or `>`'
    },
    {
      name: 'callout: a body holding a table',
      markdown: '> [!note]\n> | a | b |\n> |---|---|\n> | c | d |',
      pins: 'a callout body of any block is read as a structured run, and the callout is claimed when its canonical form settles, so the table stays a table inside it'
    },
    {
      name: 'quote: a run opening on a table',
      markdown: '> | a | b |\n> |---|---|\n> | c | d |',
      pins: 'a quote needs no blank `>` line, nested level or list to be read: a first block that is not a paragraph leaves its own line empty and every block a child'
    },
    {
      name: 'quote: a line then a heading',
      markdown: '> a\n> # h',
      pins: 'a heading under a quote line is a child of the quote, claimed through its canonical form, which gains the blank `>` line between blocks'
    },
    {
      name: 'quote: a line, a blank and a table',
      markdown: '> x\n>\n> | a | b |\n> |---|---|\n> | c | d |',
      pins: 'a blank `>` line then a table: the paragraph is the quote line and the table its child'
    },
    {
      name: 'callout: a body in another spelling',
      markdown: '> [!tip]\n> Use __bold__',
      pins: 'a body that does not reproduce its bytes (`__bold__` is written `**bold**`) is still a callout, since its canonical form settles'
    },
    {
      name: 'quote: a quoted fence then a lazy line',
      markdown: '> ```\n> - x\n> ```\nz',
      pins: 'a list marker inside a quoted fence is code, so the run ends at its last `>` line and the next line is a paragraph of its own'
    },
    {
      name: 'empty blocks: headings and items with nothing on the line',
      markdown:
        '#\n\n## \n\n-\n- \n*\n\n1.\n2. x\n3)\n\n- [x]\n\ntext\n-\n\n```\n-\n#\n```\n\n####### ',
      pins: 'a heading or item line with no text is an empty block, an item only after a blank line or another item (after paragraph text `-` stays text), never inside a fence, and `#######` is text'
    },
    {
      name: 'empty blocks: a box after a number',
      markdown: '1. [ ]\n\n- [ ]\n\n1. [ ] x',
      pins: "a box after a number is the item's text, not a to-do; after a bullet it is an empty to-do"
    },
    {
      name: 'table: a header row ending in a backslash',
      markdown: '| a \\\n|---|\n| b |',
      pins: 'the header cell is a and a backslash: a table row is one line, so no hard break'
    },
    {
      name: 'table: a body row ending in a backslash',
      markdown: '| a |\n|---|\n| b \\\n| c |',
      pins: "the second row's cell keeps its trailing backslash"
    },
    {
      name: 'empty heading: only a flush-left hash is empty',
      markdown: ' #\n\n  ##\n\n#\n\n##\t',
      pins: 'an empty heading is flush left; an indented hash is the text of a paragraph'
    },
    {
      name: 'empty heading: a hash inside a paragraph',
      markdown: 'a  \n #\n\nb\\\n#',
      pins: 'a hash line under paragraph text stays that text, with no placeholder in it'
    },
    {
      name: 'emphasis: a code span and edge spaces',
      markdown: '**`a` x `c`**',
      pins: 'the spaces beside the code spans leave the bold: code a, a space, bold x, a space, code c'
    },
    {
      name: 'emphasis: edge space beside a lifted image',
      markdown: '**see ![x](u)** now',
      pins: 'the bold ends at its last word; the space it held is plain text before the image'
    },
    {
      name: 'block starts: a callout right under a heading',
      markdown: '# H\n> [!tip]\n> d',
      pins: 'a heading and a callout, not a quote holding the text [!tip]'
    },
    {
      name: 'block starts: a callout in the middle of text',
      markdown: 'one\n> [!tip]\n> d\ntwo',
      pins: 'a paragraph, a callout, and a paragraph: a quote line ends the paragraph above it'
    },
    {
      name: 'block starts: math right above a heading',
      markdown: '$$\ny\n$$\n# H',
      pins: 'a math block and a heading: the line after the closing $$ may be a heading'
    },
    {
      name: 'block starts: a quote line without the space',
      markdown: '> [!note]\n> body\n>more',
      pins: 'a callout whose body is body and more: the space after > is optional'
    },
    {
      name: 'block starts: a quote with a lazy line, then a callout',
      markdown: '> a\nlazy\n> [!tip]\n> d',
      pins: 'a quote a and lazy, then a callout: a quote line after lazy lines opens a new block'
    },
    {
      name: 'marker image: a youtube address lifted from text',
      markdown: 'see ![](https://www.youtube.com/watch?v=dQw4w9WgXcQ)',
      pins: 'a paragraph see and a youtube embed, as the marker line would read'
    },
    {
      name: 'marker image: an indented whiteboard',
      markdown: 'a\n\n  ![whiteboard](memry://canvas/abc)',
      pins: 'a paragraph and a whiteboard block, not an image'
    },
    {
      name: 'marker image: a file marker whose JSON does not read',
      markdown: '<!-- file:{bad} -->',
      pins: 'a paragraph holding the comment, which keeps its bytes'
    },
    {
      name: "details markup: a quote holding a toggle's lines",
      markdown: '> <details>\n> <summary>O</summary>\n>\n> ob\n>\n> </details>',
      pins: 'a quote whose text keeps the details markup lines: the parser no longer drops them as raw HTML'
    },
    {
      name: 'details markup: a one-paragraph quote',
      markdown: '> <details>\n> <summary>O</summary>',
      pins: 'a flat quote of the text <details> and <summary>O</summary>, which was O'
    },
    {
      name: 'details markup: a callout body',
      markdown: '> [!info]\n> <details>\n>\n> b',
      pins: 'a callout whose first line keeps the <details> text'
    },
    {
      name: 'details markup: a closing tag in a heading',
      markdown: '## </details>',
      pins: 'a heading holding </details>, which was an empty heading'
    },
    {
      name: 'callout marker: a quote whose text spells one',
      markdown: '> \\[!info]\n> c',
      pins: 'a quote of the text [!info] and c: an escaped bracket is no marker'
    },
    {
      name: 'callout marker: a folded one escaped',
      markdown: '> \\[!tip]-',
      pins: 'a quote of the text [!tip]-'
    },
    {
      name: 'callout marker: a torn one in a paragraph',
      markdown: '\\[!info]\nc',
      pins: 'a paragraph of the text [!info] and c'
    },
    {
      name: 'emphasis: a marked run ending in a space and a break',
      markdown: '*a \n*b',
      pins: 'the space and the break after it leave the italic: italic a, a space, a break, b'
    },
    {
      name: 'emphasis: a marked run ending in a hard break',
      markdown: '*a  \n*b',
      pins: 'the two spaces of a hard break and the break leave the italic'
    },
    {
      name: 'list item child: a callout',
      markdown: '- a\n\n  > [!info]\n  > c',
      pins: 'a list item a holding a callout child: a run indented under an item after a blank line is that block'
    },
    {
      name: 'list item child: a math block',
      markdown: '- a\n\n  $$\n  x\n  $$',
      pins: 'a list item a holding a mathBlock child'
    },
    {
      name: 'list item child: a structured quote',
      markdown: '- a\n\n  > x\n  >\n  > y',
      pins: 'a list item a holding a structured quote child'
    },
    {
      name: "list item child: a numbered item's callout",
      markdown: '1. a\n\n   > [!tip]\n   > d\n\nafter',
      pins: 'an item holding a callout, then a top-level paragraph: the run ends at the first line at the left edge'
    },
    {
      name: 'writer: an italic run ending in a star beside an underscore',
      markdown: '> \\_\n> *a\\**\n>\n> z',
      pins: 'a structured quote: the escaped star ends no run on a delimiter, so the writer keeps the stars, `*a\\**`, and the body settles'
    },
    {
      name: 'writer: a bold run ending in a star then an underscore run',
      markdown: '> **a\\***_a\\*_\n>\n> z',
      pins: 'a structured quote: the bold run keeps its stars and the italic run against them is spelled with underscores, `**a\\***_a\\*_`'
    },
    {
      name: 'writer: a code span between an underscore and an italic star',
      markdown: '> \\_*`c`\\**\n>\n> z',
      pins: 'a structured quote of the text _, code c and an italic star'
    },
    {
      name: 'writer: an italic run ending in a star',
      markdown: '> *a\\**\n>\n> z',
      pins: 'a structured quote: the escaped star ends no run on a delimiter, so the writer spells the run `*a\\**`, the source'
    },
    {
      name: 'writer: a bold run ending in a star',
      markdown: '> **a\\***\n>\n> z',
      pins: 'a structured quote: the writer spells the run `**a\\***`, the source'
    },
    {
      name: 'whitespace-only code span: a paragraph of it between paragraphs',
      markdown: 'x\n\n`  `\n\ny',
      pins: 'a paragraph holding a code span of two spaces: the spaces travel hidden through the parse, so the paragraph keeps them'
    },
    {
      name: 'whitespace-only code span: a paragraph of it after a paragraph',
      markdown: 'x\n\n` `',
      pins: 'a second paragraph holding a code span of one space'
    },
    ...MARKDOWN_SEED_MORE_CASES,
    ...MARKDOWN_SEED_MASK_CASES,
    ...MARKDOWN_SEED_MENTION_CASES,
    ...MARKDOWN_SEED_HTML_CASES,
    ...MARKDOWN_SEED_LEAK_CASES
  ]
