/**
 * Generates `export.json` by running Electron's note export renderer
 * (`src/main/lib/export-utils.ts` and `export-image-inliner.ts`) in place as
 * the oracle.
 *
 *   pnpm --filter @memry/desktop vectors:export          # write the file
 *   pnpm --filter @memry/desktop vectors:export:check    # regenerate in memory, diff, write nothing
 *
 * The file lives in `packages/contracts/test-vectors/`; the Rust port
 * (`crates/memry-desktop/src/export/`) reproduces every case in
 * `crates/memry-desktop/tests/export_vectors.rs`. Images resolve against the
 * fixture vault `crates/memry-desktop/tests/fixtures/export/vault`, so every
 * inlined image is a `data:` URI and no absolute path reaches the file.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as hugeicons from '@hugeicons/core-free-icons'

import { inlineExportImages } from '../../src/main/lib/export-image-inliner'
import {
  getEmbeddedStyles,
  renderNoteAsHtml,
  sanitizeFilename,
  type ExportCustomIcon,
  type ExportLibraryIcon
} from '../../src/main/lib/export-utils'

// `formatDate` prints the local date; the Rust test reads the same UTC dates.
process.env.TZ = 'UTC'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const repoRoot = resolve(appRoot, '../..')
const PATH = join(repoRoot, 'packages/contracts/test-vectors/export.json')
const VAULT = join(repoRoot, 'crates/memry-desktop/tests/fixtures/export/vault')

const libraryIcons: Record<string, ExportLibraryIcon | undefined> = hugeicons

const SVG_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="#09c"/></svg>'
const HOSTILE_SVG_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><circle r="4"/></svg>'

const CUSTOM_ICONS: Record<string, ExportCustomIcon> = {
  png: { ext: 'png', data: 'iVBORw0KGgo=' },
  svg: { ext: 'svg', data: Buffer.from(SVG_ICON).toString('base64') },
  hostile: { ext: 'svg', data: Buffer.from(HOSTILE_SVG_ICON).toString('base64') },
  gif: { ext: 'gif', data: 'R0lGODlhAQABAAAAACw=' }
}

interface Case {
  name: string
  content: string
  title?: string
  emoji?: string | null
  tags?: string[]
  path?: string
  includeMetadata?: boolean
  includeTaskMarkers?: boolean
}

const BODY_CASES: Case[] = [
  { name: 'empty body', content: '' },
  { name: 'plain paragraph', content: 'Just one line of prose.' },
  { name: 'hard breaks', content: 'Line one\nLine two\nLine three\n\nNew paragraph' },
  {
    name: 'headings',
    content:
      '# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n\nSetext\n===\n\nSub\n---'
  },
  {
    name: 'emphasis and inline code',
    content: 'Some **bold**, *italic*, ***both***, ~~struck~~ and `code <b>` text.'
  },
  {
    name: 'links and autolinks',
    content:
      'A [link](https://example.com "Title") and <https://auto.example.com> and www.example.org and mail me@example.com.'
  },
  {
    name: 'nested lists',
    content:
      '- one\n- two\n  - two a\n  - two b\n    1. deep\n    2. deeper\n- three\n\n1. first\n2. second\n3. third'
  },
  { name: 'loose list', content: '- one\n\n- two\n\n- three' },
  { name: 'ordered list start', content: '3. three\n4. four' },
  {
    name: 'task list',
    content: '- [ ] open task\n- [x] done task\n- [X] upper done\n  - [ ] nested open'
  },
  {
    name: 'task markers stripped',
    content:
      '- [ ] Buy milk {task:abc123}\n- [x] Done thing {task:def_456}\n- [ ] No id {task:}\nplain {task:zzz}'
  },
  {
    name: 'task markers kept',
    content: '- [ ] Buy milk {task:abc123}\n- [x] Done thing {task:def_456}',
    includeTaskMarkers: true
  },
  {
    name: 'table',
    content:
      '| Name | Qty | Price |\n| :--- | :-: | ----: |\n| Apple | 2 | 1.50 |\n| Pear | 10 | 0.25 |\n| `code` | **b** | [[Link]] |'
  },
  { name: 'table without alignment', content: '| a | b |\n|---|---|\n| 1 | 2 |' },
  {
    name: 'fenced code',
    content: '```ts\nconst a = 1 < 2 && "x"\n[[Not a link]]\n```\n\n~~~\nplain tilde\n~~~'
  },
  { name: 'indented code', content: 'Intro [[Intro]]\n\n    [[Indented]]\n\n\tsee [[Tabbed]]\n' },
  { name: 'blockquote', content: '> quoted line\n> second line\n>\n> > nested quote\n\nafter' },
  { name: 'horizontal rules', content: 'above\n\n---\n\nmiddle\n\n***\n\nbelow' },
  {
    name: 'raw html block',
    content: '<div class="custom">\n<b>bold</b> raw\n</div>\n\nAfter the block.'
  },
  { name: 'raw inline html', content: 'Text with <kbd>Ctrl</kbd> and <mark>marked</mark>.' },
  {
    name: 'escaped characters',
    content: 'Escaped \\*star\\* and \\[bracket\\] and 5 > 3 & "quotes" \'single\''
  },
  { name: 'entities', content: 'Copy &copy; and &amp; and &#x1F600; and &nbsp;space' },
  {
    name: 'wiki links',
    content: 'See [[Note Title]], [[Page|Display]], [[Sprint Notes#Retro]] and [[#Local heading]].'
  },
  {
    name: 'wiki links in code (BBF-47)',
    content: 'After [[After]] and `[[Code]]`\n\n```\n[[Fenced]]\n```\n'
  },
  {
    name: 'wiki link with markup label',
    content: 'A [[<b>Bold</b> & co|<i>alias</i>]] link and [[ spaced ]].'
  },
  {
    name: 'html and %% comments (FB-011)',
    content: [
      '<!-- hidden [[Alpha]] -->',
      'Visible <!-- [[Beta]] --> text %% [[Gamma]] %% here.',
      '',
      '%%',
      'block [[Delta]]',
      '%%',
      '',
      'Code `%% kept %%` and `<!-- kept -->`.'
    ].join('\n')
  },
  {
    name: 'comment reopened on close line (BBF-87)',
    content: '<!-- a --> <!-- b\nmore [[F]]\nc -->'
  },
  {
    name: 'multiline comment reopened (BBF-87)',
    content: '<!-- a\nx --> <!-- b\nmore [[F]]\nc -->'
  },
  { name: 'unclosed comment (BBF-98)', content: '<!-- never closes\nmore [[F]]' },
  {
    name: 'unclosed comment after paragraph (BBF-98)',
    content: 'a\n\n<!-- a --> <!-- never closes\nmore [[F]]'
  },
  { name: 'memry file block markers', content: 'Before\n<!-- file:{id:123} -->\nAfter' },
  {
    name: 'footnotes (BBF-24)',
    content: [
      'Claim[^src] and another[^2], then the claim again[^src].',
      '',
      '[^2]: Second note.',
      '[^src]: From [[Source Note]], *really*.',
      '[^unused]: Never referenced.',
      '',
      'Code keeps `[^src]` as text.'
    ].join('\n')
  },
  {
    name: 'footnote continuation lines',
    content:
      'Ref[^long].\n\n[^long]: First line\n    continued line\n\n    after a blank\nback to prose'
  },
  { name: 'footnote without definition', content: 'Plain [^x] text.' },
  {
    name: 'footnote labels case-insensitive',
    content: 'One[^Note] two[^note].\n\n[^NOTE]: Shared.\n[^note]: Repeat ignored.'
  },
  {
    name: 'emoji and unicode',
    content: 'Emoji 😀🎉 and accents café naïve, RTL שלום, CJK 漢字, ZWJ 👩‍💻.'
  },
  {
    name: 'images every type',
    content: [
      '![png](attachments/dot.png)',
      '![jpg](<attachments/photo one.jpg>)',
      '![jpg encoded](attachments/photo%20one.jpg)',
      '![gif](attachments/dot.gif)',
      '![webp](attachments/dot.webp)',
      '![svg](attachments/shape.svg)',
      '![bmp](attachments/dot.bmp)',
      '![upper](attachments/UPPER.PNG)'
    ].join('\n\n')
  },
  {
    name: 'images that stay as written',
    content: [
      '![missing](attachments/missing.png)',
      '![escape](../../outside.png)',
      '![text](attachments/notes.txt)',
      '![remote](https://example.com/a.png)',
      '![data](data:image/png;base64,iVBORw0KGgo=)'
    ].join('\n\n')
  },
  {
    name: 'images relative to a nested note',
    path: 'Folder/Sub/Nested.md',
    content:
      '![up](../img/local.png)\n\n![dot](./../../attachments/dot.png)\n\n![too far](../../../dot.png)'
  },
  {
    name: 'raw img tags',
    content:
      'Inline <img src="attachments/dot.png" alt="a"> and <IMG SRC=\'attachments/dot.gif\'> and <img alt="no src">.\n\n<img src="attachments/dot.png" width="10">'
  },
  {
    name: 'image with title in a link',
    content: '[![logo](attachments/dot.png "Logo")](https://example.com)'
  },
  {
    name: 'strikethrough and mixed inline',
    content: '~~gone~~ and ~single~ and **bold `code` inside** and _under_score_word'
  },
  {
    name: 'long note',
    content: Array.from(
      { length: 30 },
      (_, i) =>
        `## Section ${i + 1}\n\nParagraph ${i + 1} with **bold** and a [[Link ${i + 1}]].\n\n- item a\n- item b`
    ).join('\n\n')
  },
  {
    name: 'crlf line endings',
    content:
      'Line one\r\nLine two\r\n\r\n- [ ] task {task:crlf1}\r\n\r\nRef[^a].\r\n\r\n[^a]: Note.\r\n'
  },
  { name: 'trailing spaces hard break', content: 'two spaces  \nnext\\\nbackslash break' },
  {
    name: 'bare urls and trailing punctuation',
    content:
      'Visit https://example.com/path?x=1&y=2. Or (https://example.com/a). Or http://x.org/a_b_c, then ftp://nope.example.'
  },
  {
    name: 'hashtags and heading look-alikes',
    content:
      '#tag at line start\n\n#not-a-heading\n\n## Closed heading ##\n\n2024. A year, not a list\n\n1) paren list'
  },
  {
    name: 'intraword emphasis',
    content: 'snake_case_word and foo*bar*baz and __init__ and 2*3*4'
  },
  {
    name: 'table in a list and pipes',
    content: '- item\n\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n\nEscaped \\| pipe | here'
  },
  {
    name: 'details and inline html across lines',
    content:
      '<details>\n<summary>More</summary>\n\nHidden **body**\n\n</details>\n\nText <span\nclass="x">split</span> tag'
  },
  {
    name: 'mixed bullets and spacing',
    content: '* star\n+ plus\n- dash\n\n10. ten\n11. eleven\n\n-not a list\n\n  - indented two'
  },
  {
    name: 'link reference definitions',
    content:
      'See [the docs][docs] and [Docs] and [missing][nope].\n\n[docs]: https://example.com/docs "Docs title"'
  },
  {
    name: 'html entities in links and code',
    content:
      '[a & b](https://example.com/?a=1&b=2) and `a &amp; b` and <a href="https://e.com">raw &amp; link</a>'
  },
  {
    name: 'apostrophes in text and code',
    content: "It's `don't` here\n\n```js\nit's \"q\" & <b>\n```\n\n```\n```"
  },
  {
    name: 'link hrefs encoded',
    content:
      "[space](<https://e.com/ä b>) and [title](https://e.com/a_(b) \"It's\") and ![alt](<pic é.png> 'T')"
  },
  {
    name: 'html block then blank lines',
    content: '<div>\nx\n</div>\n\n\n\nafter\n\n<p>end</p>\n\n'
  },
  { name: 'loose task list', content: '- [ ] one\n\n- [x] two\n  more' },
  {
    name: 'list with code and quote',
    content: '1. step\n\n   ```\n   code in list\n   ```\n\n2. next\n   > quoted in list'
  }
]

const META_CASES: Case[] = [
  {
    name: 'metadata with tags',
    title: 'Export <Test> & "Quotes"',
    tags: ['alpha', 'beta <b>', 'çok'],
    content: 'Hello **world**'
  },
  { name: 'metadata without tags', tags: [], content: 'Body' },
  { name: 'metadata off', includeMetadata: false, tags: ['hidden'], content: 'Body only' },
  { name: 'emoji icon', emoji: '🚀', content: 'Rocket note' },
  { name: 'text icon escaped', emoji: '<b>&</b>', content: 'Escaped icon' },
  { name: 'library icon', emoji: 'icon:Home01Icon', content: 'Library icon' },
  { name: 'library icon with many parts', emoji: 'icon:Calendar03Icon', content: 'Calendar' },
  { name: 'library icon unknown', emoji: 'icon:NoSuchIcon', content: 'Unknown library icon' },
  { name: 'custom png icon', emoji: 'custom:png', content: 'Custom png' },
  { name: 'custom svg icon', emoji: 'custom:svg', content: 'Custom svg' },
  { name: 'custom hostile svg icon', emoji: 'custom:hostile', content: 'Sanitized svg' },
  { name: 'custom icon of other type', emoji: 'custom:gif', content: 'Unsupported type' },
  { name: 'custom icon missing', emoji: 'custom:gone', content: 'Missing custom icon' },
  { name: 'icon without metadata', emoji: '📝', includeMetadata: false, content: 'Icon only' }
]

const FILENAMES = [
  'Plain title',
  'a/b\\c:d*e?f"g<h>i|j',
  '  spaced\t\tout  name  ',
  '..',
  '#tag [x] ^y',
  'x'.repeat(250),
  '🚀 Launch notes'
]

const CREATED = '2026-01-02T08:30:00.000Z'
const MODIFIED = '2026-03-15T23:59:59.000Z'

async function renderCase(input: Case): Promise<Record<string, unknown>> {
  const note = {
    title: input.title ?? input.name,
    content: input.content,
    emoji: input.emoji ?? null,
    tags: input.tags ?? ['export'],
    path: input.path ?? `${input.name}.md`,
    created: CREATED,
    modified: MODIFIED
  }
  const options = {
    includeMetadata: input.includeMetadata ?? true,
    includeTaskMarkers: input.includeTaskMarkers ?? false
  }
  const rendered = renderNoteAsHtml(
    {
      id: 'note-1',
      title: note.title,
      content: note.content,
      emoji: note.emoji,
      tags: note.tags,
      created: new Date(note.created),
      modified: new Date(note.modified)
    },
    {
      ...options,
      findCustomIcon: (id) => CUSTOM_ICONS[id],
      findLibraryIcon: (name) => libraryIcons[name]
    }
  )
  const html = await inlineExportImages(rendered, { notePath: note.path, vaultPath: VAULT })
  return { name: input.name, note, options, html }
}

async function render(): Promise<string> {
  const cases = []
  for (const input of [...BODY_CASES, ...META_CASES]) cases.push(await renderCase(input))
  const document = {
    meta: {
      spec: 'tauri-v2-3551-export-html',
      oracle:
        'apps/desktop/scripts/export-oracle (Electron src/main/lib/export-utils.ts and export-image-inliner.ts run in place, TZ=UTC)',
      vault: 'crates/memry-desktop/tests/fixtures/export/vault',
      customIcons: CUSTOM_ICONS,
      caseCount: cases.length
    },
    styles: getEmbeddedStyles(),
    filenames: FILENAMES.map((input) => ({ input, output: sanitizeFilename(input) })),
    cases
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

async function main(): Promise<void> {
  const fresh = await render()
  if (!process.argv.includes('--check')) {
    writeFileSync(PATH, fresh, 'utf8')
    process.stdout.write(`wrote ${PATH}\n`)
    return
  }
  let committed = ''
  try {
    committed = readFileSync(PATH, 'utf8')
  } catch {
    committed = ''
  }
  if (committed !== fresh) {
    process.stderr.write(
      'vectors:export:check failed: export.json is missing or regenerates differently.\n' +
        'Regenerate with `pnpm --filter @memry/desktop vectors:export`.\n'
    )
    process.exit(1)
  }
  process.stdout.write('vectors:export:check passed\n')
}

void main()
