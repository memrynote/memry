// Golden corpus for Obsidian foreign-syntax preservation (docs/obs/06).
// One fixture per syntax-inventory row; both the renderer pipeline
// (markdown-utils) and the main CRDT pipeline (blocknote-converter) matrix-test
// every entry for first-pass identity (once === input) and idempotence
// (twice === once). Do not "fix" a fixture to make a test pass — fixtures are
// the spec; the pipelines must adapt.

export interface ForeignSyntaxFixture {
  name: string
  markdown: string
}

export const FOREIGN_SYNTAX_FIXTURES: ForeignSyntaxFixture[] = [
  { name: 'block-id-eol', markdown: 'Some text ^ab12cd' },
  // Obsidian puts a block ID for quotes/tables on its own line after a blank line.
  { name: 'block-id-own-line', markdown: '> quoted text\n\n^quote1' },
  { name: 'block-id-on-bullet', markdown: '- item one ^ab12cd\n- item two' },
  { name: 'comment-inline', markdown: 'Before %%draft [[Hidden Link]]%% after' },
  { name: 'comment-block', markdown: '%%\n- raw notes\n- more notes\n%%' },
  { name: 'highlight', markdown: 'This is ==important== text' },
  { name: 'math-inline', markdown: 'Energy: $e=mc^2$ done' },
  { name: 'math-block', markdown: '$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$' },
  { name: 'mermaid-fence', markdown: '```mermaid\ngraph TD;\n  A-->B;\n```' },
  {
    name: 'tasks-emoji-plain-checkbox',
    markdown: '- [ ] Pay rent 📅 2026-07-05 🔁 every month ⏫'
  },
  {
    name: 'tasks-emoji-linked-task',
    markdown: '- [ ] Pay rent 📅 2026-07-05 ⏫ {task:t-42}'
  },
  { name: 'dataview-fullline', markdown: 'Rating:: 9' },
  { name: 'dataview-bracketed', markdown: 'Loved it [rating:: 9] overall' },
  { name: 'dataview-parenthesized', markdown: 'Loved it (rating:: 9) overall' },
  {
    name: 'checkbox-custom-states',
    markdown: '- [-] cancelled task\n- [?] maybe task\n- [>] forwarded task'
  },
  { name: 'template-vars', markdown: 'Created {{date:YYYY-MM-DD}} for {{title}}' },
  { name: 'footnote-inline', markdown: 'A claim^[see appendix] here' },
  { name: 'footnote-ref', markdown: 'A claim[^1] here' },
  { name: 'footnote-definition', markdown: 'A claim[^1] here\n\n[^1]: the supporting note' },
  { name: 'embed-image-sized', markdown: '![[img.png|300x200]]' },
  { name: 'embed-pdf-page', markdown: '![[doc.pdf#page=3]]' },
  { name: 'embed-note-heading-inline', markdown: 'see ![[Note#Heading]] here' },
  { name: 'wikilink-heading', markdown: 'see [[Note#Heading]] here' },
  { name: 'wikilink-blockid', markdown: 'see [[Note#^ab12cd]] here' },
  { name: 'mdlink-percent20', markdown: '[note](My%20Note.md)' },
  { name: 'callout-unknown-type', markdown: '> [!faq] FAQ Title\n> Body line' },
  { name: 'callout-fold-markers', markdown: '> [!note]- Folded title\n> Hidden body' },
  { name: 'callout-custom-title', markdown: '> [!info] My title\n> Body line' },
  {
    name: 'callout-nested',
    markdown: '> [!note]\n> outer body\n> > [!tip] inner\n> > nested body'
  },
  {
    name: 'callout-multi-paragraph',
    markdown: '> [!note]\n> First paragraph\n>\n> Second paragraph'
  },
  {
    // Cross-pipeline sink: gaps, code fence, inline + block foreign syntax.
    // Renderer-only Memry markers (![embed]/![bookmark]/file) are covered by
    // their own unit tests per pipeline and stay out so the same bytes can be
    // asserted through both pipelines.
    name: 'kitchen-sink',
    markdown: [
      '# Trip notes',
      '',
      'Some text ^ab12cd',
      '',
      'Before %%draft [[Hidden Link]]%% after ==important== and $e=mc^2$.',
      '',
      '%%',
      '- raw block notes',
      '%%',
      '',
      '$$',
      '\\int_0^1 x^2 \\, dx',
      '$$',
      '',
      '> [!faq]- Custom FAQ title',
      '> Folded body',
      '',
      '![[img.png|300x200]]',
      '',
      '- [-] cancelled item',
      '',
      '[^1]: the footnote',
      '',
      '```mermaid',
      'graph TD;',
      '  A-->B;',
      '```',
      '',
      '',
      '',
      'After a big gap with {{title}} and [rating:: 9].'
    ].join('\n')
  }
]
