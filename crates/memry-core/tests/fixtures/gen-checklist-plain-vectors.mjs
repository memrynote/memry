// Regenerates the checklist marking vectors from the Electron code:
//   cd apps/desktop && npx tsx ../../crates/memry-core/tests/fixtures/gen-checklist-plain-vectors.mjs
// Writes checklist-plain.json next to this file.
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// The source is CommonJS under tsx, so named imports are read off the namespace.
const ns = await import('../../../../apps/desktop/src/main/import/_shared/checklist-tasks.ts')
const { markAddedChecklistLinesPlain } = ns.default ?? ns

// Each line exercises one rule of `markChecklistLinesPlain`.
const lines = [
  '- [ ] Buy milk',
  '* [x] Done thing',
  '+ [X] Shouted done',
  '- [y] Not a checkbox',
  '1. [ ] Ordered item',
  '2) [ ] Ordered paren',
  '-  [ ]   Extra spaces  ',
  '- [ ]',
  '- [ ]   ',
  '- [ ]x glued',
  '-\t[ ] tab after marker',
  '\t- [ ] tab indent',
  '    - [ ] nested four',
  '  * [ ] nested two',
  '- [ ] Task {task:abc123}',
  '- [ ] Empty id {task:}',
  '- [ ] Already plain {check}',
  '- [ ] Plain with space {check}   ',
  '- [ ] Linked line ^block-1',
  '- [ ] Has id 🆔 abc123',
  '- [ ] Depends ⛔ abc123',
  '- [ ] Inline id [id:: abc123]',
  '- [ ] Due 📅 2026-11-01',
  '- [ ] Recurs 🔁 every week',
  '- [ ] Trailing nbsp\u00a0',
  '- [ ] Mid\rreturn',
  '- [ ] Line sep\u2028inside',
  '- [ ] Para sep\u2029inside',
  '> - [ ] Quoted',
  '- plain bullet',
  'Some paragraph',
  '',
  '   ',
  '```',
  '~~~',
  '````md',
  '```js `tick`',
  '- [ ] Ünïcödé 日本語 ✅',
  '-[ ] no space',
  '- [ ] Ends in tab\t',
  '- [ ]\tTab after box',
  '- [x]Glued done'
]

const docs = []
// Each line alone, LF and CRLF.
for (const line of lines) {
  docs.push(line)
  docs.push(`${line}\r\n${line}\r\n`)
}
// Fences: a checkbox inside is documentation.
docs.push('```\n- [ ] inside fence\n```\n- [ ] after fence')
docs.push('~~~~\n- [ ] inside\n~~~\n- [ ] still inside\n~~~~\n- [ ] out')
docs.push('```js `x`\n- [ ] not a fence opener\n```')
docs.push('   ```\n- [ ] inside indented fence\n   ```\n- [ ] out')
docs.push('    ```\n- [ ] four spaces is not a fence\n')
docs.push('```\r\n- [ ] crlf fence\r\n```\r\n- [ ] after\r\n')

// Seeded mixes of the lines above, so line interplay (fences, duplicates) is covered.
let seed = 20261030
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}
for (let n = 0; n < 200; n++) {
  const count = 1 + Math.floor(random() * 12)
  const picked = []
  for (let i = 0; i < count; i++) picked.push(lines[Math.floor(random() * lines.length)])
  docs.push(picked.join(random() < 0.2 ? '\r\n' : '\n'))
}

const cases = []
for (const markdown of docs) {
  cases.push({ markdown, previous: '', output: markAddedChecklistLinesPlain(markdown, '') })
}
// A write over an older body: only added lines are marked, each old line matched once.
const rewrites = [
  ['- [ ] old\n- [ ] new', '- [ ] old'],
  ['- [ ] same\n- [ ] same', '- [ ] same'],
  ['- [ ] same\n- [ ] same\n- [ ] same', '- [ ] same\nother\n- [ ] same'],
  ['- [ ] a\r\n- [ ] b\r\n', '- [ ] a\n- [ ] b\n'],
  ['- [ ] a\r\n- [ ] b\r\n', '- [ ] a\r\n'],
  ['\n- [ ] after blank', ''],
  ['- [ ] a', '- [ ] a'],
  ['```\n- [ ] x\n```\n- [ ] y', '- [ ] y']
]
for (const [markdown, previous] of rewrites) {
  cases.push({ markdown, previous, output: markAddedChecklistLinesPlain(markdown, previous) })
}
for (let n = 0; n < 60; n++) {
  const markdown = docs[Math.floor(random() * docs.length)]
  const previous = markdown
    .split('\n')
    .filter(() => random() < 0.5)
    .join('\n')
  cases.push({ markdown, previous, output: markAddedChecklistLinesPlain(markdown, previous) })
}

const out = join(dirname(fileURLToPath(import.meta.url)), 'checklist-plain.json')
writeFileSync(out, JSON.stringify({ cases }, null, 2) + '\n')
console.log(
  `wrote ${cases.length} cases, ${cases.filter((c) => c.output !== c.markdown).length} changed`
)
