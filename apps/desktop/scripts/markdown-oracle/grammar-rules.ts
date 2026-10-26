/**
 * One positive and one negative note per rule of chapter 12 §12.6 to §12.8
 * (#3522). Positive: the note carries the construct the rule claims. Negative:
 * the near miss the rule must NOT claim, which has to survive as the author's
 * markdown. `gen-grammar-corpus.ts` writes them as `corpus/<rule>.pos.md` and
 * `.neg.md`; the oracle answers each, and both converters must agree on it.
 */
export interface GrammarRule {
  id: string
  /** Protocol section the rule is written in. */
  section: '12.6' | '12.7' | '12.8'
  pos: string
  neg: string
}

const F = '```'
const rules: GrammarRule[] = []
const add = (id: string, section: GrammarRule['section'], pos: string, neg: string): void => {
  rules.push({ id, section, pos, neg })
}

// 12.6 blocks
for (let n = 1; n <= 6; n++) {
  add(
    `heading-${n}`,
    '12.6',
    `${'#'.repeat(n)} Title ${n}\n\nbody\n`,
    `${'#'.repeat(n)}Title ${n}\n`
  )
}
add('heading-seven-hashes', '12.6', '###### six\n', '####### seven\n')
add(
  'heading-toggle',
  '12.6',
  '<details>\n<summary># Heading toggle</summary>\n\nbody\n\n</details>\n',
  '<details>\n<summary>#Heading toggle</summary>\n</details>\n'
)
add('paragraph', '12.6', 'plain text\n', '\\# not a heading\n')
add('paragraph-hard-break', '12.6', 'a  \nb\n', 'a \nb\n')
for (const marker of ['-', '*', '+']) {
  add(
    `bullet-${marker === '-' ? 'dash' : marker === '*' ? 'star' : 'plus'}`,
    '12.6',
    `${marker} one\n${marker} two\n`,
    `${marker}one\n${marker}two\n`
  )
}
add('bullet-nested', '12.6', '- a\n  - b\n    - c\n', '- a\n - b\n')
add('bullet-loose', '12.6', '- a\n\n- b\n', '- a\n\n\n\n- b\n')
add('bullet-empty-item', '12.6', '- \n- b\n', '-\n')
add('ordered', '12.6', '1. a\n2. b\n', '1.a\n2.b\n')
add('ordered-start', '12.6', '5. a\n6. b\n', '5) a\n')
add('ordered-nested', '12.6', '1. a\n   1. b\n', '1. a\n  1. b\n')
add('ordered-paren', '12.6', '1) a\n2) b\n', '1 ) a\n')
add('task-open', '12.6', '- [ ] todo\n', '- [] todo\n')
add('task-done', '12.6', '- [x] done\n', '- [X ] done\n')
add('task-upper', '12.6', '- [X] done\n', '- [y] nope\n')
add('task-nested', '12.6', '- [ ] a\n  - [x] b\n', '- [ ]a\n')
add('quote', '12.6', '> quoted\n', '>quoted\n')
add('quote-multi', '12.6', '> a\n> b\n', '> a\nb\n')
add('quote-nested', '12.6', '> a\n>\n> > b\n', '>> b\n')
add('quote-with-list', '12.6', '> - a\n> - b\n', '> -a\n')
add('quote-with-code', '12.6', `> ${F}\n> x\n> ${F}\n`, `> ${F}\n> x\n`)
for (const t of [
  'info',
  'warning',
  'error',
  'success',
  'note',
  'abstract',
  'todo',
  'tip',
  'important',
  'question',
  'example',
  'quote',
  'bug'
]) {
  add(`callout-${t}`, '12.6', `> [!${t}]\n> body of ${t}\n`, `> [!${t.toUpperCase()}]\n> body\n`)
}
add('callout-folded', '12.6', '> [!info]-\n> hidden\n', '> [!info] -\n> hidden\n')
add('callout-open-fold', '12.6', '> [!info]+\n> open\n', '> [!info]++\n> x\n')
add('callout-with-title', '12.6', '> [!tip] Title\n> body\n', '> [!tip]Title\n> body\n')
add('callout-with-list', '12.6', '> [!note]\n> - a\n> - b\n', '> [!note]\n> - [ ] a\n')
add('callout-unknown-type', '12.6', '> [!danger]\n> body\n', '> [!Danger-Zone]\n> body\n')
add('callout-empty', '12.6', '> [!info]\n', '> [!]\n')
add('callout-nested-quote', '12.6', '> [!info]\n> > inner\n', '> [!info]\n>> inner\n')
add('code-fence', '12.6', `${F}\ncode\n${F}\n`, `${F}\ncode\n`)
add('code-fence-lang', '12.6', `${F}ts\nconst a = 1\n${F}\n`, `${F} ts extra words\nx\n${F}\n`)
add('code-fence-tilde', '12.6', '~~~\nx\n~~~\n', '~~\nx\n~~\n')
add('code-fence-long', '12.6', '````\n```\n````\n', '```\n````\n')
add('code-fence-empty', '12.6', `${F}\n${F}\n`, `${F}${F}\n`)
add('code-indented', '12.6', '    indented code\n', '   not code\n')
add('code-keeps-markers', '12.6', `${F}\n<!-- align:center -->\n${F}\n`, '<!-- align:center -->\n')
add('math-block', '12.6', '$$\nx^2\n$$\n', '$$x^2$$\n')
add('math-block-multiline', '12.6', '$$\na\nb\n$$\n', '  $$\na\n$$\n')
add('math-unterminated', '12.6', '$$\nx\n\ntext\n', '$$ \nx\n$$ \n')
add('divider', '12.6', 'a\n\n---\n\nb\n', 'a\n--\nb\n')
add('divider-star', '12.6', '***\n', '**\n')
add('divider-underscore', '12.6', '___\n', '__\n')
add('table', '12.6', '| a | b |\n| - | - |\n| 1 | 2 |\n', '| a | b |\n| 1 | 2 |\n')
add(
  'table-align',
  '12.6',
  '| a | b |\n| :- | -: |\n| 1 | 2 |\n',
  '| a | b |\n| :-: :- |\n| 1 | 2 |\n'
)
add('table-ragged', '12.6', '| a | b |\n| - | - |\n| 1 |\n', '| a | b |\n| - |\n| 1 | 2 |\n')
add(
  'table-pipe-escape',
  '12.6',
  '| a \\| b | c |\n| - | - |\n| 1 | 2 |\n',
  '| a | b |\n| - | - |\n| 1 \\\n'
)
add('table-empty-cell', '12.6', '| a | b |\n| - | - |\n|  | 2 |\n', '| a | b |\n| - | - |\n||\n')
add(
  'table-inline',
  '12.6',
  '| **a** | `b` |\n| - | - |\n| [l](u) | ~~s~~ |\n',
  '| **a | b** |\n| - | - |\n'
)
add(
  'table-html',
  '12.6',
  '<table><tr><td colspan="2">x</td></tr><tr><td>a</td><td>b</td></tr></table>\n',
  '<table><tr><td colspan="x">x</td></tr></table>\n'
)
add(
  'table-rowspan',
  '12.6',
  '<table><tr><td rowspan="2">x</td><td>a</td></tr><tr><td>b</td></tr></table>\n',
  '<table><tr><td rowspan="0">x</td></tr></table>\n'
)
add(
  'table-align-marker',
  '12.6',
  '<!-- table-align:["left","center"] -->\n| a | b |\n| - | - |\n| 1 | 2 |\n',
  '<!-- table-align:[left] -->\n| a | b |\n| - | - |\n'
)
add(
  'table-colors-marker',
  '12.6',
  '<!-- table-colors:{"0:0":{"textColor":"red"}} -->\n| a |\n| - |\n| 1 |\n',
  '<!-- table-colors:{ -->\n| a |\n| - |\n'
)
add('image', '12.6', '![alt](https://example.com/a.png)\n', '![alt] (https://example.com/a.png)\n')
add('image-title', '12.6', '![alt](a.png "title")\n', '![alt](a.png title)\n')
add('image-width', '12.6', '![alt|300](a.png)\n', '![alt|3x0](a.png)\n')
add('image-relative', '12.6', '![](./img/a b.png)\n', '![](<>)\n')
add('image-reserved-char', '12.6', '![a](http://h/a^b|c)\n', '![a](http://h/a b)\n')
add('image-file-url', '12.6', '![a](file:///C|/x.png)\n', '![a](file:/x.png\n')
add(
  'file-marker',
  '12.6',
  '<!-- file:{"url":"a.pdf","name":"a.pdf","size":10,"mimeType":"application/pdf"} -->\n',
  '<!-- file:{"url":"a.pdf" -->\n'
)
add(
  'file-marker-order',
  '12.6',
  '<!-- file:{"url":"a.pdf","name":"a","size":1,"mimeType":"x/y","width":5,"height":6} -->\n',
  '<!-- file:{"name":"a","url":"a.pdf"} -->\n'
)
add(
  'file-marker-link',
  '12.6',
  '<!-- file:{"url":"a.pdf","name":"a","size":1,"mimeType":"application/pdf","display":"link"} -->\n',
  '<!-- file:{"url":"a.pdf","name":"a","size":1,"mimeType":"x/y","display":"odd"} -->\n'
)
add(
  'file-marker-align',
  '12.6',
  '<!-- file:{"url":"a.png","name":"a","size":1,"mimeType":"image/png","align":"center"} -->\n',
  '<!-- file:{"url":"a.png","name":"a","size":1,"mimeType":"image/png","align":"left"} -->\n'
)
add(
  'file-marker-escape',
  '12.6',
  '<!-- file:{"url":"a.pdf","name":"a--b.pdf","size":1,"mimeType":"x/y"} -->\n',
  '<!-- file:{"url":"a.pdf","name":"a-->b","size":1,"mimeType":"x/y"} -->\n'
)
add(
  'whiteboard',
  '12.6',
  '![whiteboard](memry://canvas/V1StGXR8_Z5jdHi6B-myT)\n',
  '![whiteboard](https://example.com/c.png)\n'
)
add(
  'whiteboard-inline',
  '12.6',
  'text\n\n![whiteboard](memry://canvas/abc)\n',
  'text ![whiteboard](memry://canvas/abc) more\n'
)
add(
  'whiteboard-empty-id',
  '12.6',
  '![whiteboard](memry://canvas/)\n',
  '![whiteboard](memry://canvas/a b)\n'
)
add(
  'whiteboard-in-fence',
  '12.6',
  `${F}\n![whiteboard](memry://canvas/abc)\n${F}\n`,
  '    ![whiteboard](memry://canvas/abc)\n'
)
add(
  'toggle',
  '12.6',
  '<details>\n<summary>Title</summary>\n\nbody\n\n</details>\n',
  '<details>\n<summary>Title</summary>\nbody\n'
)
add(
  'toggle-open',
  '12.6',
  '<details open>\n<summary>T</summary>\n\nb\n\n</details>\n',
  '<details closed>\n<summary>T</summary>\n\nb\n\n</details>\n'
)
add(
  'toggle-nested',
  '12.6',
  '<details>\n<summary>O</summary>\n\n<details>\n<summary>I</summary>\n\nx\n\n</details>\n\n</details>\n',
  '<details><details>\n'
)
add(
  'toggle-inline-summary',
  '12.6',
  '<details>\n<summary>**bold** `c`</summary>\n\nb\n\n</details>\n',
  '<details>\n<summary></summary>\n\nb\n\n</details>\n'
)
add(
  'toggle-list',
  '12.6',
  '<details>\n<summary>T</summary>\n\n- a\n- b\n\n</details>\n',
  '<details>\n<summary>T</summary>\n- a\n</details>\n'
)
add(
  'columns',
  '12.6',
  '<!-- memry:columns -->\n<div data-column-list>\n<div data-column>\n\na\n\n</div>\n<div data-column>\n\nb\n\n</div>\n</div>\n',
  '<div data-column>\n\na\n\n</div>\n'
)
add('align-marker-center', '12.6', '<!-- align:center -->\ntext\n', '<!-- align:middle -->\ntext\n')
add('align-marker-right', '12.6', '<!-- align:right -->\ntext\n', '<!-- align:right-->\ntext\n')
add(
  'align-marker-justify',
  '12.6',
  '<!-- align:justify -->\ntext\n',
  '<!--align:justify-->\ntext\n'
)
add(
  'align-marker-heading',
  '12.6',
  '<!-- align:center -->\n# H\n',
  '<!-- align:center -->\n\n\n# H\n'
)
add('align-marker-orphan', '12.6', '<!-- align:center -->\n', '<!-- align:center --> trailing\n')
add(
  'colors-marker',
  '12.6',
  '<!-- colors:{"textColor":"red"} -->\ntext\n',
  '<!-- colors:{"textColor":} -->\ntext\n'
)
add(
  'colors-marker-background',
  '12.6',
  '<!-- colors:{"backgroundColor":"blue"} -->\n# H\n',
  '<!-- colors: -->\n# H\n'
)
add(
  'link-card-marker',
  '12.6',
  '<!-- link-card:{"display":"card"} -->\n[a](https://example.com)\n',
  '<!-- link-card:{"display":"card" -->\n[a](https://example.com)\n'
)
add(
  'block-nesting-marker',
  '12.6',
  '<!-- memry:block-nesting-level=1 -->\ntext\n',
  '<!-- memry:block-nesting-level=x -->\ntext\n'
)
add(
  'view-block',
  '12.6',
  `${F}memry-view\n{"query":"x"}\n${F}\n`,
  `${F}memry-views\n{"query":"x"}\n${F}\n`
)
add(
  'portal-block',
  '12.6',
  `${F}memry-portal\n{"noteId":"n1"}\n${F}\n`,
  `${F}memry-portal extra\n{}\n${F}\n`
)
add('html-block', '12.6', '<div>raw</div>\n', '<div>raw\n')
add(
  'html-block-figure',
  '12.6',
  '<figure><img src="a.png" alt="a"><figcaption>c</figcaption></figure>\n',
  '<figure>\n'
)
add('html-comment-block', '12.6', '<!-- note -->\n\ntext\n', '<!-- note\n\ntext\n')
add('html-comment-multiline', '12.6', '<!--\nline\n\nbreak\n-->\n\ntext\n', '<!--\nline\n\nbreak\n')
add('percent-comment', '12.6', 'a %%hidden%% b\n', 'a %%unclosed b\n')
add('blank-lines', '12.6', 'a\n\n\n\nb\n', 'a\n\nb\n')
add('crlf', '12.6', 'a\r\n\r\nb\r\n', 'a\rb\r')
add('empty-body', '12.6', '', '\n\n')
add('frontmatter', '12.6', '---\ntitle: T\n---\nbody\n', '---\ntitle: T\nbody\n')
add('frontmatter-empty', '12.6', '---\n---\nbody\n', '--- \n---\nbody\n')
add(
  'frontmatter-crlf',
  '12.6',
  '---\r\ntitle: T\r\n---\r\nbody\r\n',
  '---\r\ntitle: T\r\n--\r\nbody\r\n'
)
add('frontmatter-bom', '12.6', '\uFEFF---\ntitle: T\n---\nbody\n', '\uFEFF\n---\ntitle: T\n---\n')
add(
  'frontmatter-unicode-title',
  '12.6',
  '---\ntitle: Çay ☕\n---\nbody\n',
  '---\ntitle: [unclosed\n---\nbody\n'
)

// 12.7 inlines
add('bold', '12.7', '**b**\n', '** b**\n')
add('bold-underscore', '12.7', '__b__\n', '__ b__\n')
add('italic', '12.7', '*i*\n', '* i*\n')
add('italic-underscore', '12.7', '_i_\n', 'snake_case_word\n')
add('bold-italic', '12.7', '***bi***\n', '***bi*\n')
add('strike', '12.7', '~~s~~\n', '~~ s~~\n')
add('inline-code', '12.7', '`code`\n', '`code\n')
add('inline-code-double', '12.7', '`` a`b ``\n', '`` a`b `\n')
add('inline-code-spaces', '12.7', '`  a  `\n', '` `\n')
add('underline', '12.7', '<u>u</u>\n', '<u>u\n')
add('highlight', '12.7', '==h==\n', '== h==\n')
add('superscript', '12.7', 'x<sup>2</sup>\n', 'x<sup>2\n')
add('subscript', '12.7', 'H<sub>2</sub>O\n', 'H<sub>2\n')
add('text-color', '12.7', '<span style="color: red">t</span>\n', '<span style="color:">t</span>\n')
add(
  'background-color',
  '12.7',
  '<span style="background-color: yellow">t</span>\n',
  '<span style="background-color">t</span>\n'
)
add('link', '12.7', '[t](https://example.com)\n', '[t] (https://example.com)\n')
add('link-title', '12.7', '[t](https://example.com "T")\n', '[t](https://example.com T)\n')
add('link-angle', '12.7', '[t](<a b>)\n', '[t](<a b)\n')
add('link-parens', '12.7', '[t](https://e.com/a_(b))\n', '[t](https://e.com/a_(b)\n')
add('link-reference', '12.7', '[t][r]\n\n[r]: https://example.com\n', '[t][r]\n')
add('link-reference-title', '12.7', '[t][r]\n\n[r]: https://example.com "T"\n', '[r]: \n')
add('link-autolink', '12.7', '<https://example.com>\n', '<https://example.com\n')
add('link-bare', '12.7', 'see https://example.com/a now\n', 'see https:// now\n')
add('link-in-code', '12.7', '`[t](u)`\n', '[`t`](u)\n')
add('link-hard-break', '12.7', '[one  \ntwo](https://example.com)\n', '[one\\\ntwo](u)\n')
add('wiki-link', '12.7', '[[Target]]\n', '[[Target]\n')
add('wiki-link-alias', '12.7', '[[Target|alias]]\n', '[[Target|]]\n')
add('wiki-link-empty', '12.7', '[[]]\n', '[[ ]]\n')
add('wiki-link-in-code', '12.7', '`[[Target]]`\n', '[ [Target]]\n')
add('hash-tag', '12.7', '#tag\n\ntext #tag-two\n', '#\n\n# \n')
add('hash-tag-digits', '12.7', 'a #2024 b\n', 'a#tag\n')
add('date-mention', '12.7', '((date:2026-01-02))\n', '((date:2026 01))\n')
add('date-mention-range', '12.7', '((date:2026-01-02;2026-01-05))\n', '((date:))\n')
add('link-mention', '12.7', '((mention:https%3A%2F%2Fexample.com))\n', '((mention:))\n')
add('inline-image', '12.7', 'text ![a](a.png) more\n', 'text !\\[a](a.png) more\n')
add('inline-image-width', '12.7', 'text ![a|20](a.png) more\n', 'text ![a|](a.png) more\n')
add('inline-checkbox', '12.7', '| a |\n| - |\n| [ ] x |\n', '| a |\n| - |\n| [] x |\n')
add('html-comment-inline', '12.7', 'a <!-- hidden --> b\n', 'a <!- hidden --> b\n')
add('html-comment-in-code', '12.7', 'use `<!-- x -->` here\n', 'use <!-- x here\n')
add('html-comment-in-link', '12.7', '[a <!-- c --> b](u)\n', '[a <!-- c b](u)\n')
add(
  'html-comment-in-table',
  '12.7',
  '| a | b |\n| - | - |\n| x <!-- c --> | y |\n',
  '| a | b |\n| - | - |\n| x <!-- c | y |\n'
)
add('html-comment-bold', '12.7', '**a <!-- b --> c**\n', '**a <!-- b c**\n')
add('escape-star', '12.7', 'a \\* b\n', 'a * b\n')
add('escape-bracket', '12.7', '\\[a\\](b)\n', '\\[a](b)\n')
add('escape-backtick', '12.7', 'a \\` b\n', 'a ` b\n')
add('escape-hash', '12.7', '\\# no\n', '\\#no\n')
add('escape-pipe-in-table', '12.7', '| a \\| b |\n| - |\n| 1 |\n', '| a \\\\| b |\n| - |\n| 1 |\n')
add('entity-amp', '12.7', 'a &amp; b\n', 'a &ampx b\n')
add('entity-numeric', '12.7', '&#65;&#x42;\n', '&#x;\n')
add('emoji', '12.7', 'a 😀 b\n', 'a \uFFFD b\n')
add('cjk', '12.7', '日本語の文章 **強調**\n', '日本語**強調 \n')
add('combining-marks', '12.7', 'e\u0301 a\u0308\n', '\u0301\n')
add('rtl', '12.7', 'مرحبا **بالعالم**\n', 'مرحبا ** بالعالم**\n')
add(
  'non-ascii-writing-run',
  '12.7',
  'çay <!--ghost-->x<!--/ghost--> ☕\n',
  'çay <!--ghost-->x ☕\n'
)

// 12.8 out-of-band encodings
add('critic-addition', '12.8', 'a {++add++} b\n', 'a {++add b\n')
add('critic-deletion', '12.8', 'a {--del--} b\n', 'a {--del-} b\n')
add('critic-substitution', '12.8', 'a {~~old~>new~~} b\n', 'a {~~old~new~~} b\n')
add('critic-comment', '12.8', 'a {>>note<<} b\n', 'a {>>note} b\n')
add('critic-highlight', '12.8', 'a {==hi==} b\n', 'a {==hi=} b\n')
add('critic-in-code', '12.8', '`{++a++}`\n', '{ ++a++ }\n')
add('critic-in-fence', '12.8', `${F}\n{++a++}\n${F}\n`, '    {++a++}\n')
add('critic-nested-marks', '12.8', '{++**b**++}\n', '{++**b++}**\n')
add('writing-ghost', '12.8', 'a <!--ghost-->g<!--/ghost--> b\n', 'a <!--ghost--> b\n')
add('writing-alt', '12.8', 'a <!--alt:k1-->x<!--/alt:k1--> b\n', 'a <!--alt:-->x<!--/alt:--> b\n')
add(
  'writing-ghost-unclosed',
  '12.8',
  '<!--ghost-->g<!--/ghost-->\n',
  '<!--/ghost-->g<!--ghost-->\n'
)
add('writing-in-code', '12.8', '`<!--ghost-->`\n', '<!-- ghost -->\n')
add('writing-in-fence', '12.8', `${F}\n<!--ghost-->\n${F}\n`, '<!--ghost-->\n')
add('source-spelling-bullet', '12.8', '* a\n* b\n', '*a\n')
add('source-spelling-emphasis', '12.8', '__a__ and *b*\n', '__ a__\n')
add('source-spelling-heading-setext', '12.8', 'Title\n=====\n', 'Title\n=\n')
add('source-spelling-setext-2', '12.8', 'Title\n-----\n', 'Title\n--\n')
add('source-spelling-hr', '12.8', '***\n', '* *\n')
add('source-spelling-ordered', '12.8', '1) a\n2) b\n', '1)a\n')
add('source-spelling-blank-gaps', '12.8', 'a\n\n\n\nb\n', 'a\n\n\nb\n')
add('source-spelling-fence-tilde', '12.8', '~~~js\nx\n~~~\n', '~~js\nx\n~~\n')
add('source-spelling-trailing-ws', '12.8', 'a  \nb\t\n', 'a \nb\n')
add('source-spelling-no-final-newline', '12.8', 'a\n\nb', 'a\n\nb\n\n')
add('source-spelling-crlf', '12.8', 'a\r\n\r\nb\r\n', 'a\r\nb\n\r\n')
add('frontmatter-keys-order', '12.8', '---\nz: 1\na: 2\n---\nbody\n', '---\nz: 1\na: 2\nbody\n')
add(
  'frontmatter-writing',
  '12.8',
  '---\nwriting:\n  alt: []\n---\nbody\n',
  '---\nwriting: [\n---\nbody\n'
)

// More 12.6 and 12.7 near misses: the same rule at the edges of its alphabet.
for (const lang of ['js', 'python', 'cpp', 'csharp', 'shell-session', 'memry-view']) {
  add(
    `code-fence-lang-${lang.replace(/\W+/g, '-')}`,
    '12.6',
    `${F}${lang}\nx\n${F}\n`,
    `${F}${lang} \`x\nx\n${F}\n`
  )
}
for (const depth of [2, 3, 5]) {
  add(
    `bullet-depth-${depth}`,
    '12.6',
    Array.from({ length: depth }, (_, i) => `${'  '.repeat(i)}- l${i}\n`).join(''),
    Array.from({ length: depth }, (_, i) => `${' '.repeat(i)}- l${i}\n`).join('')
  )
  add(`quote-depth-${depth}`, '12.6', `${'> '.repeat(depth)}x\n`, `${'>'.repeat(depth)}x\n`)
}
for (const cell of ['**b**', '`c`', '[l](u)', '~~s~~', '==h==', '<u>u</u>', '[[w]]', '#tag']) {
  add(
    `table-cell-${cell.replace(/\W+/g, '') || 'x'}`,
    '12.6',
    `| a |\n| - |\n| ${cell} |\n`,
    `| a |\n| - |\n| ${cell}\n`
  )
}
for (const [name, mark] of [
  ['bold', '**'],
  ['italic', '*'],
  ['strike', '~~'],
  ['highlight', '=='],
  ['code', '`']
]) {
  add(`inline-mark-${name}-around-link`, '12.7', `${mark}[t](u)${mark}\n`, `${mark}[t](u)\n`)
  add(`inline-mark-${name}-around-wiki`, '12.7', `${mark}[[w]]${mark}\n`, `${mark}[[w]\n`)
}

export const GRAMMAR_RULES: readonly GrammarRule[] = rules
