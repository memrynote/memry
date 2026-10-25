import type { MarkdownSource } from './cases-bn'
import type { OracleCase } from './cases-frontmatter'

/**
 * Inputs of `memry-parse.json` (op `memry-parse`): the whole markdown-to-seed
 * path with the memry layers. Markdown comes from the 817 shared sources and
 * from the hand-written notes below, one per layer and quirk. Expected outputs
 * come from the oracle (`memry-oracle.ts`); nothing here states an answer.
 */

interface Extra {
  notePath?: string
  embedFiles?: Record<string, string>
  calloutTypes?: { name: string; label: string; color: string; icon: string }[]
  writing?: unknown
}

const FENCE = '```'

const NOTES: Record<string, string> = {
  'empty-input': '',
  'only-blank-lines': '\n\n\n',
  'plain-paragraph': 'Hello world\n',
  'crlf-document': 'one\r\ntwo\r\n\r\nthree\r\n',
  'lone-cr-lines': 'a\rb\r\rc',
  'blank-line-gaps': 'a\n\n\n\nb\n\n\n\n\n\nc\n',
  'gap-after-heading': '# Title\n\n\n\nbody\n',
  'gap-in-fence': `${FENCE}\na\n\n\n\nb\n${FENCE}\n`,
  'hard-break-two-spaces': 'line one  \nline two\n',
  'hard-break-backslash': 'line one\\\nline two\n',
  'soft-break-paragraph': 'line one\nline two\n',
  'hard-break-in-code-block': `${FENCE}\na  \nb\n${FENCE}\n`,
  'hard-break-in-link-text': '[one  \ntwo](https://example.com)\n',
  'html-comment-inline': 'before <!-- hidden --> after\n',
  'html-comment-own-line': '<!-- note -->\n\ntext\n',
  'html-comment-multiline': '<!--\nline\n\nbreak\n-->\n\ntext\n',
  'html-comment-in-code': 'use `<!-- x -->` here\n',
  'html-comment-in-fence': `${FENCE}\n<!-- x -->\n${FENCE}\n`,
  'html-comment-in-link': '[a <!-- c --> b](https://example.com)\n',
  'percent-comment': 'text %%hidden%% more\n',
  'html-comment-in-table': '| a | b |\n| - | - |\n| x <!-- c --> | y |\n',
  'html-comment-bold': '**a <!-- b --> c**\n',
  'toggle-closed': '<details>\n<summary>Title</summary>\n\nBody text\n\n</details>\n',
  'toggle-open': '<details open>\n<summary>Title</summary>\n\nBody\n\n</details>\n',
  'toggle-nested':
    '<details>\n<summary>Outer</summary>\n\n<details>\n<summary>Inner</summary>\n\nDeep\n\n</details>\n\n</details>\n',
  'toggle-with-colors':
    '<!-- colors:{"textColor":"red"} -->\n<details>\n<summary>Colored</summary>\n\nBody\n\n</details>\n',
  'toggle-with-gap': 'a\n\n\n<details>\n<summary>T</summary>\n\nb\n\n</details>\n\n\n\nc\n',
  'toggle-empty-body': '<details>\n<summary>Only summary</summary>\n</details>\n',
  'toggle-in-fence': `${FENCE}html\n<details>\n<summary>x</summary>\n</details>\n${FENCE}\n`,
  'details-literal-text': 'plain <details> text\n',
  'columns-two':
    '--- start-multi-column: abc123\n\nLeft\n\n--- end-column ---\n\nRight\n\n--- end-multi-column\n',
  'columns-settings':
    '--- start-multi-column: abc123\n```column-settings\nNumber of Columns: 2\nColumn 1 Width: 30%\nColumn 2 Width: 70%\n```\n\nLeft\n\n--- end-column ---\n\nRight\n\n--- end-multi-column\n',
  'columns-one': '--- start-multi-column: x\n\nOnly\n\n--- end-multi-column\n',
  'columns-empty-column':
    '--- start-multi-column: x\n\n--- end-column ---\n\nRight\n\n--- end-multi-column\n',
  'columns-with-toggle':
    '--- start-multi-column: x\n\n<details>\n<summary>T</summary>\n\nb\n\n</details>\n\n--- end-column ---\n\nR\n\n--- end-multi-column\n',
  'columns-unclosed': '--- start-multi-column: x\n\nLeft\n\n--- end-column ---\n\nRight\n',
  'columns-with-gap':
    'a\n\n\n\n--- start-multi-column: x\n\nL\n\n--- end-column ---\n\nR\n\n--- end-multi-column\n\n\n\nb\n',
  'math-block': '$$\nx^2 + y^2\n$$\n',
  'math-block-mid-paragraph': 'text\n$$\nx\n$$\nmore\n',
  'math-block-indented': '  $$\nx\n  $$\n',
  'math-block-multiline': '$$\na\n\nb\n$$\n',
  'math-in-fence': `${FENCE}\n$$\nx\n$$\n${FENCE}\n`,
  'math-inline': 'inline $x$ math and $$y$$\n',
  'file-marker':
    '<!-- file:{"url":"memry-file://a.pdf","name":"a.pdf","size":10,"kind":"pdf"} -->\n',
  'file-marker-bad-json': '<!-- file:{not json} -->\n',
  'file-marker-in-fence': `${FENCE}\n<!-- file:{"url":"x"} -->\n${FENCE}\n`,
  'youtube-embed': '![](https://www.youtube.com/watch?v=dQw4w9WgXcQ)\n',
  'youtube-embed-alt': '![video](https://youtu.be/dQw4w9WgXcQ)\n',
  'youtube-not-video': '![alt](https://www.youtube.com/about)\n',
  'bookmark-line': '![bookmark](https://www.example.com/page)\n',
  'bookmark-local-path': '![bookmark](assets/photo.png)\n',
  'whiteboard-line': '![whiteboard](memry://canvas/abc123)\n',
  'whiteboard-external': '![whiteboard](https://example.com/x.png)\n',
  'sidecar-align': '<!-- align:center -->\nCentered text\n',
  'sidecar-colors': '<!-- colors:{"backgroundColor":"yellow"} -->\nColored\n',
  'sidecar-twice': '<!-- align:right -->\n<!-- colors:{"textColor":"blue"} -->\nBoth\n',
  'sidecar-before-list': '<!-- align:center -->\n- item\n- two\n',
  'sidecar-orphan': '<!-- align:center -->\n',
  'sidecar-in-fence': `${FENCE}\n<!-- align:center -->\n${FENCE}\n`,
  'table-align': '<!-- table-align:{"0:1":"center"} -->\n| a | b |\n| - | - |\n| 1 | 2 |\n',
  'table-layout': '<!-- table-layout:{"widths":[100,200]} -->\n| a | b |\n| - | - |\n| 1 | 2 |\n',
  'table-colors':
    '<!-- table-colors:{"1:0":{"backgroundColor":"red"}} -->\n| a | b |\n| - | - |\n| 1 | 2 |\n',
  'table-wiki-pipe': '| a | b |\n| - | - |\n| [[Note|alias]] | x |\n',
  'table-code-spaces': '| a | b |\n| - | - |\n| `x  y` | `  z` |\n',
  'link-card': '<!-- link-card:{"url":"https://example.com","title":"T"} -->\n',
  'nesting-marker':
    '- a\n\n<!-- memry:block-nesting-level=1 -->\n\nchild\n\n<!-- memry:block-nesting-level=0 -->\n\nafter\n',
  'nesting-marker-deep':
    'p\n\n<!-- memry:block-nesting-level=1 -->\n\nc1\n\n<!-- memry:block-nesting-level=2 -->\n\nc2\n\n<!-- memry:block-nesting-level=0 -->\n',
  'nesting-marker-bad-level': '<!-- memry:block-nesting-level=99 -->\n\nx\n',
  'task-block': '- [ ] Buy milk {task:abc123}\n- [x] Done {task:def456}\n',
  'task-block-nested':
    '- [ ] Parent {task:p1}\n  - [ ] Child {task:c1}\n    - [ ] Grand {task:g1}\n',
  'task-block-empty-id': '- [ ] Draft {task:}\n',
  'task-block-in-fence': `${FENCE}\n- [ ] x {task:a}\n${FENCE}\n`,
  'task-checked-states': '- [x] A {task:a}\n- [ ] B {task:b}\n- [X] C {task:c}\n',
  'task-obsidian': '- [ ] Pay rent 📅 2026-01-02 ⏫ {task:r1}\n',
  'plain-checkbox': '- [ ] plain item {check}\n- [x] done item {check}\n',
  'plain-checkbox-nested': '- [ ] parent {check}\n  - [ ] child {check}\n',
  'checkbox-regular': '- [ ] one\n- [x] two\n',
  'inline-color-span': 'a <span style="color: red">red</span> b\n',
  'inline-color-bg': '<span style="background-color: #ff0000">bg</span>\n',
  'inline-color-both': '<span style="color: red; background-color: yellow">both</span>\n',
  'inline-color-nested-bold': '**<span style="color: blue">bold blue</span>**\n',
  'inline-color-in-code': '`<span style="color: red">x</span>`\n',
  'inline-color-unknown': '<span style="font-size: 20px">big</span>\n',
  'wiki-link': 'See [[Wiki Link]] and [[Target|alias]] and [[A#h]]\n',
  'hash-tag': 'A #tag and #multi-word_tag here\n',
  'date-mention': 'On ((date:2026-01-02)) we met\n',
  'link-mention': 'With ((mention:note:abc|Title)) there\n',
  'token-emphasis': 'x ((mention:note:a_b_c|T_t)) *y*\n',
  'wiki-image-embed': '![[photo.png]]\n',
  'wiki-image-embed-sized': '![[photo.png|300]]\n',
  'wiki-image-embed-inline': 'text ![[photo.png]] more\n',
  'wiki-note-embed': '![[Some Note]]\n',
  'block-images-adjacent': '![a](a.png)![b](b.png)\n',
  'block-image-in-text': 'text ![a](a.png) more\n',
  'block-image-lift': 'para ![a](a.png)\n\n- item ![b](b.png)\n',
  'image-with-title': '![alt](a.png "title")\n',
  'image-hard-break-alt': '![one  \ntwo](a.png)\n',
  'link-reference':
    'See [docs][d] and [other].\n\n[d]: https://example.com/docs "Docs"\n[other]: <https://example.com/o p>\n',
  'link-reference-unused': '[x]: https://example.com\n\ntext\n',
  'link-reference-in-fence': `${FENCE}\n[x]: https://a.b\n${FENCE}\n\n[x]\n`,
  'link-reference-case': '[Foo Bar][fb]\n\n[FB]: https://x.y\n',
  'link-destination-title': '[a](https://example.com "the title")\n',
  'link-destination-spaced': '[a](<https://example.com/a b>)\n',
  'link-code-text': '[`code`](https://example.com) and [a `b` c](https://example.com)\n',
  footnotes: 'Text[^1] and more[^note].\n\n[^1]: First.\n[^note]: Second.\n',
  'critic-addition': 'a {++added++} b\n',
  'critic-deletion': 'a {--removed--} b\n',
  'critic-substitution': 'a {~~old~>new~~} b\n',
  'critic-comment': 'a {>>a comment<<} b\n',
  'critic-highlight': 'a {==marked==}{>>why<<} b\n',
  'critic-multiple': '{++one++} {--two--}\n\n{~~x~>y~~}\n',
  'critic-astral': '😀 {++é++} 日本語 {--x--}\n',
  'critic-in-fence': `${FENCE}\n{++x++}\n${FENCE}\n`,
  'critic-unclosed': 'a {++open\n',
  'writing-alt': 'Sabah <!--alt:k3x9q2-->ayaz<!--/alt:k3x9q2--> bir ruzgar.\n',
  'writing-ghost': 'Kahve <!--ghost-->biraz fazla<!--/ghost--> kalabalikti.\n',
  'writing-unpaired': 'a <!--alt:x1-->b\n\nc <!--/ghost--> d\n',
  'writing-nested': '<!--ghost-->a <!--alt:q1-->b<!--/alt:q1--> c<!--/ghost-->\n',
  'writing-duplicate-id': '<!--alt:z-->a<!--/alt:z--> <!--alt:z-->b<!--/alt:z-->\n',
  'writing-with-critic': '<!--ghost-->a<!--/ghost--> {++new++}\n',
  'quote-plain': '> quoted line\n',
  'quote-blank-line': '> a\n>\n> b\n',
  'quote-nested': '> a\n>\n> > inner\n',
  'quote-two-paragraphs': '> first\n>\n> second\n',
  'quote-with-list': '> - a\n> - b\n',
  'quote-lazy': '> a\nlazy\n',
  'callout-info': '> [!info]\n> Body text\n',
  'callout-warning-fold': '> [!warning]+\n> Body\n',
  'callout-with-title': '> [!note] Title here\n> Body\n',
  'callout-unknown-type': '> [!danger]\n> Body\n',
  'callout-torn': '[!info]\nBody text\n',
  'callout-lone-marker-text': 'text\n\n[!info]\n\nother\n',
  'callout-children': '> [!tip]\n> Own\n>\n> - item\n',
  'callout-custom-type': '> [!decision]\n> We chose X\n',
  'callout-in-list': '- item\n\n  > [!info]\n  > nested\n',
  'code-fence-info': `${FENCE}ts\nconst a = 1\n  const b = 2\n${FENCE}\n`,
  'code-indented': 'para\n\n    code line\n    more\n',
  'code-fence-tilde': '~~~\n  indented\n~~~\n',
  'code-fence-long': '````\n```\ninner\n```\n````\n',
  'code-diagram': `${FENCE}mermaid\ngraph TD\n    A[Start] --> B\n${FENCE}\n`,
  'code-portal': `${FENCE}memry-portal\n{"v":1,"note":"n1"}\n${FENCE}\n`,
  'code-view': `${FENCE}memry-view\n{"v":1}\n${FENCE}\n`,
  'pre-block': '<pre><code>A  \nB</code></pre>\n',
  'lists-mixed': '- a\n  1. b\n  2. c\n- d\n\n1. x\n2. y\n',
  'list-after-gap': '- a\n\n\n- b\n',
  'heading-levels': '# a\n## b\n### c\n#### d\n##### e\n###### f\n',
  'emphasis-mix': '**bold** *it* ~~strike~~ `code` ==mark==\n',
  'emphasis-intraword': 'snake_case_word and 2*3*4\n',
  'break-artifact-bold': '**a**\nc\n',
  'break-artifact-link': '[a](u)\n[b](u)\n',
  'break-artifact-paragraph': 'para\n\n    code\n',
  'frontmatter-like': '---\ntitle: x\n---\n\nbody\n',
  'thematic-breaks': 'a\n\n---\n\nb\n\n***\n',
  'unicode-mix': 'héllo 日本語 😀 emoji\n\n> 引用\n',
  'u2028-line': 'a\u2028b\n\nc\n',
  'bom-start': '\uFEFFstart\n',
  'nbsp-lines': 'a\n\u00a0\nb\n'
}

function uniqueId(prefix: string, index: number): string {
  return `${prefix}/memry-parse/src-${String(index).padStart(4, '0')}`
}

export function memryParseCases(external: MarkdownSource[]): OracleCase[] {
  const cases: OracleCase[] = []
  const extras: Record<string, Extra> = {
    'embed-resolved': {
      notePath: 'notes/a.md',
      embedFiles: { 'photo.png': 'memry-file://abc/photo.png' }
    },
    'embed-resolved-sized': {
      notePath: 'notes/a.md',
      embedFiles: { 'photo.png': 'memry-file://abc/photo.png' }
    },
    'embed-resolved-inline': {
      notePath: 'notes/a.md',
      embedFiles: { 'photo.png': 'memry-file://abc/photo.png' }
    },
    'callout-custom-type': {
      calloutTypes: [{ name: 'decision', label: 'Decision', color: '#336699', icon: 'gavel' }]
    },
    'writing-alt': { writing: { alternatives: { k3x9q2: { versions: ['soguk', 'buz'] } } } }
  }
  const notes: Record<string, string> = { ...NOTES }
  notes['embed-resolved'] = '![[photo.png]]\n'
  notes['embed-resolved-sized'] = '![[photo.png|300]]\n'
  notes['embed-resolved-inline'] = 'text ![[photo.png]] more\n'
  for (const [name, markdown] of Object.entries(notes)) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    cases.push({
      id: `parse-notes/memry-parse/${slug}`,
      op: 'memry-parse',
      input: { markdown, ...extras[name] }
    })
  }
  external.forEach((source, i) => {
    cases.push({
      id: uniqueId('parse-sources', i),
      op: 'memry-parse',
      input: { markdown: source.markdown }
    })
  })
  return cases
}
