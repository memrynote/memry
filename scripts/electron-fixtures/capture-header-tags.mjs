// Captures Electron's header tag edits for the Tauri port (Step 13f-3, #3530):
// crates/memry-core/tests/fixtures/header-tags.json.gz.
//
//   pnpm install                           (repo root)
//   node scripts/electron-fixtures/capture-header-tags.mjs
//
// Electron's own code computes each case: `extractInlineTagsFromMarkdown` (a body's `#tags`),
// `applyHeaderTagEdit` (a delta on a list), and `nextHeaderTags` with `compareHeaderTags` (the
// header tags an `updateNote` writes: an explicit delta, the agent API's whole `tags` list, the
// `#tags` a body change typed or deleted, `ignoreInlineTags`). `tagsWithFields` is stubbed with
// each case's set of tags with fields, which the Rust side takes as an argument. Inputs are held
// once and named by index. The fixture is replaced whole, gzipped (a recapture of unchanged
// cases is the same bytes: gzip writes no time).
//
// The capture runs under the desktop app's vitest config, so it writes its test into
// apps/desktop/src/main/vault for the run and removes it after.
import { spawnSync } from 'node:child_process'
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
const desktop = path.join(root, 'apps/desktop')
const testFile = path.join(desktop, 'src/main/vault/header-tags-fixture.capture.test.ts')
const out = path.join(root, 'crates/memry-core/tests/fixtures/header-tags.json.gz')
const raw = path.join(root, 'crates/memry-core/tests/fixtures/header-tags.capture.json')

const TEST = `/**
 * Writes the Electron header tag edits of the Tauri port
 * (\`crates/memry-core/tests/fixtures/header-tags.json.gz\`, Step 13f-3 #3530). Runs only with
 * \`MEMRY_HEADER_TAGS_OUT=<file>\`.
 */
import { describe, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { extractInlineTagsFromMarkdown } from '@memry/shared/inline-tags'
import { applyHeaderTagEdit, parseNote } from './frontmatter'
import { compareHeaderTags, nextHeaderTags } from './note-write'

const fields = vi.hoisted(() => ({ keys: new Set<string>() }))
vi.mock('../tags/schema/read', () => ({ tagsWithFields: () => fields.keys }))

const OUT = process.env.MEMRY_HEADER_TAGS_OUT

const BODIES: string[] = [
  '',
  'Plain text with no tags.\\n',
  '#alpha at the start\\n',
  'Text #Alpha and #beta/child and #beta.\\n',
  '\`\`\`\\n#incode\\n\`\`\`\\n#after the fence\\n',
  'x \`#inline\` y #real\\n',
  '#1number #a-b_c #x9\\n',
  'a#notatag #ok,#glued (#paren) #end.\\n',
  '#parent/ #trail/x #deep/a/b #slash/\\n',
  '#Tag #TAG #tag #Other\\n',
  'line\\r\\n#crlf\\r\\nmore #two\\r\\n',
  'nbsp\\u00a0#nbsp tab\\t#tab nel\\u0085#nel bom\\ufeff#bom ideographic\\u3000#wide\\n',
  '\`\`#notcode\`\` #yes\\n',
  '\`\`\`unclosed #x\\n#y\\n',
  '\`a\` \`\` #b \`c\`\\n',
  '\`\`\`a\`\`\` #mid \`\`\`b #c\`\`\` #last\\n',
  '#İstanbul #istanbul #Iİ #ıi\\n',
  '#project review with #work/sub and #beta\\n',
  '## Heading #h2tag\\n\\n- [ ] task #todo\\n> quote #q\\n',
  'url http://x.io/#anchor and #real-one\\n'
]

const HEADERS: string[][] = [
  [],
  ['alpha'],
  ['Alpha', 'beta'],
  ['project', 'Work/Sub', 'x'],
  ['İstanbul', 'tag', 'Other']
]

const WITH_FIELDS: string[][] = [[], ['beta', 'work/sub', 'yes', 'istanbul']]

type Edit = { add?: string[]; remove?: string[]; rename?: Array<{ from: string; to: string }>; source?: 'inline' }

const EDITS: Edit[] = [
  {},
  { add: ['new'] },
  { add: ['  spaced  ', ' ', 'NEW', 'new'] },
  { remove: ['ALPHA', 'missing'] },
  { remove: [' beta '], add: ['Beta'] },
  { rename: [{ from: 'alpha', to: 'Omega' }] },
  { rename: [{ from: 'BETA', to: 'alpha' }] },
  { rename: [{ from: 'x', to: '  ' }, { from: 'project', to: 'P' }] },
  { rename: [{ from: 'alpha', to: 'one' }, { from: 'Alpha', to: 'two' }] },
  { remove: ['alpha'], rename: [{ from: 'alpha', to: 'kept?' }] },
  { add: ['istanbul', 'ISTANBUL'], remove: ['tag'] },
  { add: ['beta', 'plain'], remove: ['alpha', 'work/sub'], source: 'inline' },
  { add: ['Yes', 'Fresh'], source: 'inline' }
]

const LISTS: string[][] = [
  [],
  ['alpha'],
  ['ALPHA', 'gamma'],
  ['beta', 'real', 'yes', 'alpha'],
  ['project', 'work/sub', 'x', 'extra'],
  ['  padded ', 'tag']
]

describe.skipIf(!OUT)('electron header tag fixture', () => {
  it('writes the cases', () => {
    const golden = path.join(__dirname, '__fixtures__', 'golden-vault')
    const goldenBodies = fs.readdirSync(golden).filter((name) => name.endsWith('.md')).sort()
      .map((name) => parseNote(fs.readFileSync(path.join(golden, name), 'utf8'), name).content)
    const bodies = [...BODIES, ...goldenBodies]

    const inline = bodies.map((content) => extractInlineTagsFromMarkdown(content))

    const apply: unknown[] = []
    for (const current of [...HEADERS, ['a', 'A', ' b ', 'c']]) {
      for (const edit of EDITS) apply.push({ current, edit, next: applyHeaderTagEdit(current, edit) })
    }

    // Inputs by index into \`bodies\`, \`headers\`, \`withFields\`, \`edits\` and \`lists\`, so the
    // fixture holds each text once.
    const db = {} as never
    const updates: unknown[] = []
    type Input = { edit?: number; list?: number; content?: number; ignoreInlineTags?: true }
    const push = (f: number, h: number, b: number, input: Input) => {
      fields.keys = new Set(WITH_FIELDS[f])
      const existing = { headerTags: HEADERS[h], content: bodies[b] }
      const next = nextHeaderTags(db, existing, {
        headerTags: input.edit === undefined ? undefined : EDITS[input.edit],
        tags: input.list === undefined ? undefined : LISTS[input.list],
        content: input.content === undefined ? undefined : bodies[input.content],
        ignoreInlineTags: input.ignoreInlineTags
      })
      updates.push({ withFields: f, header: h, body: b, ...input, next, change: compareHeaderTags(HEADERS[h], next) })
    }
    const nextBody = (b: number, step: number) => (b + step) % bodies.length
    for (const f of WITH_FIELDS.keys()) {
      for (const h of HEADERS.keys()) {
        push(f, h, 0, {})
        for (const edit of EDITS.keys()) {
          push(f, h, 3, { edit })
          for (const b of [1, 3, 9, 17, 18]) push(f, h, b, { edit, content: nextBody(b, 5) })
        }
        for (const b of bodies.keys()) {
          if (b < BODIES.length) for (const list of LISTS.keys()) push(f, h, b, { list })
          if (b % 4 === 0) {
            for (const list of LISTS.keys()) push(f, h, b, { list, content: nextBody(b, 2) })
            push(f, h, b, { list: 3, edit: 1 })
          }
          for (const step of [1, 13]) {
            push(f, h, b, { content: nextBody(b, step) })
            push(f, h, b, { content: nextBody(b, step), ignoreInlineTags: true })
          }
        }
      }
    }

    const meta = {
      oracle: 'apps/desktop extractInlineTagsFromMarkdown, applyHeaderTagEdit, nextHeaderTags, compareHeaderTags',
      capture: 'scripts/electron-fixtures/capture-header-tags.mjs',
      counts: { inline: inline.length, apply: apply.length, updates: updates.length }
    }
    const inputs = { bodies, headers: HEADERS, withFields: WITH_FIELDS, edits: EDITS, lists: LISTS }
    fs.writeFileSync(OUT as string, JSON.stringify({ meta, ...inputs, inline, apply, updates }))
  })
})
`

fs.writeFileSync(testFile, TEST)
try {
  const run = spawnSync(
    'pnpm',
    ['exec', 'vitest', 'run', '--config', 'config/vitest.config.ts', '--project', 'main', testFile],
    { cwd: desktop, stdio: 'inherit', env: { ...process.env, MEMRY_HEADER_TAGS_OUT: raw } }
  )
  if (run.status !== 0) process.exitCode = run.status ?? 1
  else fs.writeFileSync(out, zlib.gzipSync(fs.readFileSync(raw), { level: 9 }))
} finally {
  fs.rmSync(testFile, { force: true })
  fs.rmSync(raw, { force: true })
}
