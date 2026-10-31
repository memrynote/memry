/**
 * The cases of the `note-stats.json` vector file: what `syncNoteToCache` measures in a vault
 * file. `oracle-serve.oracle.ts` runs Electron's own `extractNoteMetadata` (note-sync.ts) and
 * the task id scan of note-derived-state-projector.ts on each; the Rust core reproduces the
 * file (`crates/memry-core/tests/note_stats_vectors.rs`).
 */
import type { OracleCase } from './cases-frontmatter'

const FM = (yaml: string): string => `---\n${yaml}---\n`
const words = (count: number, word = 'word'): string =>
  Array.from({ length: count }, (_, i) => `${word}${i}`).join(' ')

/** The body of `note-fidelity-roundtrip.test.ts`, the note a sync round trip carries whole. */
const NOTE_FIDELITY = [
  FM('tags:\n  - reading\n  - focus\nproperties:\n  status: reading\n  rating: 5\n'),
  'Reading notes.\n\n![Cover](../../attachments/note-fidelity-1/cover.png)\n\n',
  '[Paper](../../attachments/note-fidelity-1/paper.pdf)'
].join('')

export function noteStatsCases(): OracleCase[] {
  const texts: Record<string, string> = {
    'note-fidelity': NOTE_FIDELITY,
    empty: '',
    'frontmatter-only': FM('a: 1\n'),
    'plain-words': 'one two  three\n\nfour\tfive\n',
    'js-whitespace': 'a\u00a0b\u2028c\u3000d\ufeffe\u0085f',
    'fenced-code': 'before\n```ts\nconst a = 1\n```\nafter ``` lone',
    'two-fences': '```\nx y\n```\nmid\n```\nz\n```\nend',
    'inline-code': 'run `npm test` now and `` this ` too',
    'unclosed-span': 'tick `left open here',
    headings: '# Title\n## Sub heading\n#not-a-heading\n   # indented',
    links: 'see [the docs](https://x.test/a) and [[Target|alias]] and [[Note#Part]] and [[#Only]]',
    images: '![alt](img.png) text ![](b.png)',
    emphasis: '**bold** _it_ ***both*** __under__ a*b*c',
    comments: 'keep <!-- hidden --> this %% and that %% end\n<!--\nblock\n-->\nafter',
    'comment-in-code': '`<!-- shown -->` and\n```\n%% kept %%\n```',
    'span-tags': 'a <span style="color: red">red</span> word',
    'snippet-word-cut': words(40),
    'snippet-hard-cut': `${'x'.repeat(190)} ${'y'.repeat(30)}`,
    'snippet-exact': 'z'.repeat(200),
    'snippet-surrogates': `${'é'.repeat(150)} ${'😀'.repeat(40)}`,
    crlf: '---\r\ntags: [a]\r\n---\r\nline one\r\nline two\r\n',
    bom: `\ufeff${FM('tags: solo\n')}body text`,
    'tags-scalar-number': `${FM('tags: 42\n')}x`,
    'tags-duplicates': `${FM('tags:\n  - Work\n  - work\n  - " spaced "\n  - ""\n')}x`,
    'tags-false': `${FM('tags: false\n')}x`,
    'tags-empty-list': `${FM('tags: []\n')}x`,
    'cover-wash': `${FM('cover: wash:sage\n')}x`,
    'cover-unknown-wash': `${FM('cover: wash:teal\n')}x`,
    'cover-url': `${FM('cover: HTTPS://img.test/a\n')}x`,
    'cover-path-query': `${FM('cover: covers/A.PNG?v=2\n')}x`,
    'cover-prose': `${FM('cover: Hardback\n')}x`,
    'cover-number': `${FM('cover: 7\n')}x`,
    'broken-frontmatter': `${FM('tags: [a, b\ncover: wash:sage\n')}still counted words`,
    'list-frontmatter': `${FM('- a\n- b\n')}x`,
    'task-ids':
      '- [ ] first {task:t1}\n- [x] second {task:t2}\n  - [ ] nested {task:t3}\n- [ ] first again {task:t1}\n- [ ] plain',
    'unclosed-frontmatter': '---\ntags: [a]\nno close',
    'tags-true': `${FM('tags: true\n')}x`,
    'tags-date': `${FM('tags: 2024-01-01\n')}x`,
    'tags-nan': `${FM('tags: .nan\n')}x`,
    'wiki-embed': 'before ![[embed.png]] after ![[Note#Part|shown]] end',
    cjk: `漢字かなまじり文です。 한국어 문장 中文句子\n\n${'字'.repeat(250)}`,
    rtl: 'مرحبا بالعالم هذا نص عربي\nשלום עולם זה טקסט בעברית\n'
  }
  return Object.entries(texts).map(([slug, text]) => ({
    id: `note-stats/${slug}`,
    op: 'note-stats',
    input: { text }
  }))
}
