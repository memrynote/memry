/**
 * Inputs for the `markdown-seed.json` class (spec 005-journal JP022a): the
 * template markdown a journal day is seeded from, and the edge cases of the
 * path desktop turns it into a document with.
 *
 * Every case stays inside the constructs the core's seed builds
 * (`crates/memry-core/src/crdt/markdown_seed/mod.rs`); the generator refuses
 * one that reaches a desktop layer it does not reproduce.
 */

export const MARKDOWN_SEED_CASES: ReadonlyArray<{ name: string; markdown: string; pins: string }> =
  [
    {
      name: 'journal: morning and gratitude',
      markdown: '## Morning\n- [ ] \n\n## Gratitude\n1. \n2. \n',
      pins: 'an empty check item and an empty numbered item; the last line is trimmed to `2.` first, so it is a paragraph'
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
      pins: 'short rows padded and long rows cut to the header width; an escaped pipe stays in its cell'
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
      name: 'line endings: CRLF and CR',
      markdown: '# Title\r\n\r\n| a |\r\n|---|\r\n| 1 |\r\nlast\rline',
      pins: 'CRLF and a lone CR read as LF'
    }
  ]
