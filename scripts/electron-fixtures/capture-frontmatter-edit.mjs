// Captures the Electron property edits of note frontmatter for the Tauri port (Step 13k,
// #3530): crates/memry-core/tests/fixtures/frontmatter-edit.json.
//
//   pnpm install                           (repo root)
//   node scripts/electron-fixtures/capture-frontmatter-edit.mjs
//
// Electron's own `updateNote` path writes each case: `parseNote`, `nextNoteFrontmatter` (a
// `properties` replace as `properties:set` sends it, a `propertyPatch` as `properties:merge`
// sends it, a header tag edit) and `serializeUpdatedNote`, which edits the block in place
// (`editFrontmatterBlock`) and stringifies it again when it cannot. Every golden vault file
// takes every edit, and a few handmade files cover CRLF, comments, dates, a block at the end of
// the file, an alias, a flow mapping and the legacy nested `properties` envelope. `files` holds
// each file's text; a case names its file, Electron's reading of its frontmatter, the next
// frontmatter, whether it was edited, whether the block was edited in place, and the bytes
// Electron wrote. The fixture is replaced whole.
//
// The capture runs under the desktop app's vitest config, so it writes its test into
// apps/desktop/src/main/vault for the run and removes it after.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
const desktop = path.join(root, 'apps/desktop')
const testFile = path.join(desktop, 'src/main/vault/frontmatter-edit-fixture.capture.test.ts')
const out = path.join(root, 'crates/memry-core/tests/fixtures/frontmatter-edit.json')

const TEST = `/**
 * Writes the Electron property edits of the Tauri frontmatter port
 * (\`crates/memry-core/tests/fixtures/frontmatter-edit.json\`, Step 13k #3530). Runs only with
 * \`MEMRY_FRONTMATTER_EDIT_OUT=<file>\`.
 */
import { describe, it } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { encodeYaml } from '../../../scripts/markdown-oracle/yaml-json'
import { editFrontmatterBlock } from './frontmatter-edit'
import { extractProperties, extractTags, parseNote, serializeUpdatedNote } from './frontmatter'
import { compareHeaderTags, nextNoteFrontmatter } from './note-write'

const OUT = process.env.MEMRY_FRONTMATTER_EDIT_OUT

const HANDMADE: Record<string, string> = {
  'simple': '---\\ntitle: A\\nstatus: draft\\ndue: 2026-10-07\\ntags:\\n  - x\\n---\\nBody\\n',
  'crlf-comments': '---\\r\\n# the author\\r\\nstatus: draft # trailing\\r\\n\\r\\nrating: 3\\r\\n---\\r\\nBody\\r\\n',
  'quoted': "---\\nstatus: 'draft'\\nnote: \\"a: b\\"\\nempty:\\n---\\nBody\\n",
  'multiline': '---\\nsummary: |\\n  line one\\n  line two\\nlist:\\n  - a\\n  - b\\nstatus: x\\n---\\nBody',
  'nested-envelope': '---\\nproperties:\\n  a: 1\\n  b: 2\\nb: 3\\n---\\nBody\\n',
  'anchor': '---\\nbase: &b hello\\ncopy: *b\\nstatus: x\\n---\\nBody\\n',
  'flow-map': '---\\n{status: x, rating: 2}\\n---\\nBody\\n',
  'no-frontmatter': 'Just a body\\n',
  'empty-block': '---\\n---\\nBody\\n',
  'dates': "---\\ndue: 2026-10-07\\nwhen: '2026-10-07'\\nat: 2026-10-07T10:30:00.000Z\\n---\\n",
  'block-at-eof': '---\\nstatus: x\\n---',
  'bom': '\\ufeff---\\nstatus: x\\n---\\nBody\\n',
  'indented-comment': '---\\nstatus: draft\\n  # an indented comment\\nnext: 1\\n---\\nBody\\n',
  'column-zero-comment': '---\\nstatus: draft\\n# between\\nnext: 1\\n---\\nBody\\n',
  'tags-scalar': '---\\ntags: solo\\nstatus: x\\n---\\nBody\\n',
  'list-dash-at-column-zero': '---\\nlist:\\n- a\\n- b\\nstatus: x\\n---\\nBody\\n',
  'cover-and-writing': '---\\ncover: wash:sage\\nstatus: x\\n---\\nBody\\n'
}

type Op =
  | { kind: 'set'; properties: Record<string, unknown> }
  | { kind: 'merge'; patch: Record<string, unknown> }
  | { kind: 'tags'; headerTags: string[] }

function ops(properties: Record<string, unknown>, tags: string[]): Array<[string, Op]> {
  const names = Object.keys(properties)
  const first = names[0]
  const list: Array<[string, Op]> = [
    ['set-same', { kind: 'set', properties: { ...properties } }],
    ['set-add', { kind: 'set', properties: { ...properties, added: 'new value' } }],
    ['merge-add', { kind: 'merge', patch: { fresh: true } }],
    ['tags-add', { kind: 'tags', headerTags: [...tags, 'added-tag'] }]
  ]
  if (first !== undefined) {
    const rest = { ...properties }
    delete rest[first]
    const renamed = Object.fromEntries(
      names.map((name) => [name === first ? first + ' renamed' : name, properties[name]])
    )
    list.push(
      ['set-change-first', { kind: 'set', properties: { ...properties, [first]: 'changed' } }],
      ['set-remove-first', { kind: 'set', properties: rest }],
      ['set-rename-first', { kind: 'set', properties: renamed }],
      ['merge-set-first', { kind: 'merge', patch: { [first]: 42 } }],
      ['merge-remove-first', { kind: 'merge', patch: { [first]: null } }],
      ['merge-remove-first-and-add', { kind: 'merge', patch: { [first]: null, fresh: 'x' } }],
      ['set-remove-all', { kind: 'set', properties: {} }]
    )
  }
  if (properties.due instanceof Date) {
    list.push(
      ['merge-date-text', { kind: 'merge', patch: { due: '2027-01-02' } }],
      ['merge-date-iso', { kind: 'merge', patch: { due: '2027-01-02T10:00:00.000Z' } }],
      ['merge-date-index-text', { kind: 'merge', patch: { due: '"2027-01-02T00:00:00.000Z"' } }],
      ['merge-date-not-a-date', { kind: 'merge', patch: { due: 'soon' } }],
      ['merge-date-impossible', { kind: 'merge', patch: { due: '2027-02-30' } }]
    )
  }
  if (Array.isArray(properties.list)) {
    list.push(['merge-list', { kind: 'merge', patch: { list: ['a', 'c'] } }])
  }
  if (tags.length > 0) list.push(['tags-remove-all', { kind: 'tags', headerTags: [] }])
  return list
}

describe.skipIf(!OUT)('electron frontmatter edit fixture', () => {
  it('writes the cases', () => {
    const golden = path.join(__dirname, '__fixtures__', 'golden-vault')
    const files: Array<[string, string]> = [
      ...fs.readdirSync(golden).filter((name) => name.endsWith('.md')).sort()
        .map((name): [string, string] => ['golden/' + name, fs.readFileSync(path.join(golden, name), 'utf8')]),
      ...Object.entries(HANDMADE).map(([name, raw]): [string, string] => ['handmade/' + name, raw])
    ]
    const cases: unknown[] = []
    const raws: Record<string, string> = {}
    for (const [file, raw] of files) {
      const parsed = parseNote(raw, file)
      if (parsed.frontmatterError) continue
      raws[file] = raw
      const properties = extractProperties(parsed.frontmatter)
      const tags = extractTags(parsed.frontmatter)
      for (const [name, op] of ops(properties, tags)) {
        const existing = { title: 'Note', frontmatter: parsed.frontmatter, properties }
        const headerTags = op.kind === 'tags' ? op.headerTags : tags
        const change = op.kind === 'tags' ? compareHeaderTags(tags, headerTags) : null
        const input =
          op.kind === 'set' ? { properties: op.properties }
            : op.kind === 'merge' ? { propertyPatch: op.patch } : {}
        const { frontmatter, edited } = nextNoteFrontmatter(existing, input, headerTags, change)
        const inPlace =
          edited && parsed.rawFrontmatterBlock !== null
            ? editFrontmatterBlock(parsed.rawFrontmatterBlock, parsed.frontmatter, frontmatter) !== null
            : null
        const output = serializeUpdatedNote(parsed, frontmatter, parsed.content, {
          frontmatterEdited: edited
        })
        cases.push({
          id: file + '/' + name,
          file,
          op: encodeYaml(op),
          reading: encodeYaml(parsed.frontmatter),
          next: encodeYaml(frontmatter),
          edited,
          inPlace,
          output
        })
      }
    }
    const meta = {
      oracle: 'apps/desktop updateNote: parseNote, nextNoteFrontmatter, serializeUpdatedNote',
      capture: 'scripts/electron-fixtures/capture-frontmatter-edit.mjs',
      yamlJsonEncoding: 'apps/desktop/scripts/markdown-oracle/yaml-json.ts',
      caseCount: cases.length
    }
    fs.writeFileSync(OUT as string, JSON.stringify({ meta, files: raws, cases }))
  })
})
`

fs.writeFileSync(testFile, TEST)
try {
  const run = spawnSync(
    'pnpm',
    ['exec', 'vitest', 'run', '--config', 'config/vitest.config.ts', '--project', 'main', testFile],
    { cwd: desktop, stdio: 'inherit', env: { ...process.env, MEMRY_FRONTMATTER_EDIT_OUT: out } }
  )
  if (run.status !== 0) process.exitCode = run.status ?? 1
  // The repo's formatter owns the fixture's layout, so a recapture of unchanged cases is no diff.
  else spawnSync('pnpm', ['exec', 'oxfmt', out], { cwd: root, stdio: 'inherit' })
} finally {
  fs.rmSync(testFile, { force: true })
}
