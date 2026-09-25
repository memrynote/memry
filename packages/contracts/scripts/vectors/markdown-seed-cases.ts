/**
 * Inputs for the `markdown-seed.json` class (spec 005-journal JP022a): the
 * template markdown a journal day is seeded from, and the edge cases of the
 * path desktop turns it into a document with.
 *
 * Every case stays inside the constructs the core's seed supports
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
      name: 'journal: indented code keeps the default language',
      markdown: 'Log:\n\n    tail -f app.log',
      pins: 'an indented run becomes a code block; no fence in the source, so javascript stays'
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
      pins: 'the code mark excludes bold and link'
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
    }
  ]
