// Regenerates electron-vault/properties-md.json from the Electron code:
//   cd apps/desktop && npx tsx ../../crates/memry-desktop/tests/fixtures/gen-properties-vectors.mjs
// Each case is a `.memry/properties.md` as Electron builds, people and other tools leave it. The
// vector holds what Electron reads from it and the bytes its rewrite writes; the ops cases also
// change definitions the way the service does (`cache.set`, `cache.delete`) before the write.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const load = async (path) => {
  const ns = await import(path)
  return ns.default ?? ns
}
const { PropertyDefinitionsService } = await load(
  '../../../../apps/desktop/src/main/vault/property-definitions.ts'
)
const { parsePropertyDefinitionEntries } = await load(
  '../../../../packages/contracts/src/property-types.ts'
)
const matter = (await import('gray-matter')).default

// The service logs to the console (no database here); the vectors go to a file.
console.log = console.warn = console.info = console.debug = () => {}

const ELECTRON = `---
properties:
  Status:
    type: status
    categories:
      todo:
        label: To-do
        options:
          - value: Not started
            color: stone
            default: true
      in_progress:
        label: In progress
        options:
          - value: In Progress
            color: amber
      done:
        label: Complete
        options:
          - value: Done
            color: emerald
          - value: Abandoned
            color: rose
  Stage:
    type: select
    options:
      - value: Idea
        color: sky
      - value: Draft
        color: violet
        default: false
    defaultValue: Idea
    color: sky
  Tags:
    type: multiselect
    options: []
  Notes:
    type: text
    options: []
  Score:
    type: number
    options: []
  Done:
    type: checkbox
    options: []
  Link:
    type: url
    options: []
  Due:
    type: date
    showOnCalendar: true
  Started:
    type: date
    showOnCalendar: false
    color: amber
  project:
    type: project
---

`

const cases = [
  ['electron', ELECTRON],
  [
    'one-bad-entry-and-a-newer-type',
    `---
properties:
  Stage:
    type: select
    options:
      - value: Idea
        color: sky
  Broken:
    type: select
    options: not-a-list
  Rating:
    type: stars
    max: 5
    when: 2024-01-02
  Due:
    type: date
    showOnCalendar: true
---
`
  ],
  [
    'relation-is-dropped',
    '---\nproperties:\n  Rel:\n    type: relation\n  A:\n    type: text\n---\n\n'
  ],
  [
    'unknown-keys-inside-valid-entries',
    `---
properties:
  Stage:
    type: select
    newerKey: [1, 2]
    categories: {}
    options:
      - value: Idea
        color: sky
        icon: star
  Due:
    type: date
    options: [{value: a, color: b}]
  S:
    type: status
    options: []
    categories:
      done: {label: D, options: []}
      todo: {label: T, options: [], extra: 1}
      in_progress: {label: P, options: []}
      later: {label: L, options: []}
---
`
  ],
  [
    'names-that-need-care',
    `---
properties:
  "2024": {type: text}
  "10": {type: text}
  b: {type: text}
  "a: b": {type: text}
  "#hash": {type: text}
  "- dash": {type: text}
  "": {type: text}
  "Ünïcødé 日本": {type: text}
  "true": {type: text}
  "007": {type: text}
  "multi\\nline": {type: text}
  long: {type: text, defaultValue: "${'a very long default value '.repeat(5)}"}
  quoted: {type: text, defaultValue: "it's \\"quoted\\" and: colon"}
  empties: {type: text, defaultValue: "", color: ""}
---
`
  ],
  [
    'shapes-that-fail-the-schema',
    `---
properties:
  nullDefault: {type: select, options: [{value: a, color: b, default: null}]}
  emptyValue: {type: select, options: [{value: "", color: b}]}
  numberValue: {type: select, options: [{value: 1, color: b}]}
  stringFlag: {type: date, showOnCalendar: "yes"}
  noOptions: {type: select}
  capital: {type: Select, options: []}
  noType: {options: []}
  aString: hello
  aNull: null
  aList: [1, 2]
  numberColor: {type: text, color: 3}
  nullColor: {type: text, color: null}
  badCategory: {type: status, categories: {todo: {label: "", options: []}, in_progress: {label: P, options: []}, done: {label: D, options: []}}}
  missingCategory: {type: status, categories: {todo: {label: T, options: []}, done: {label: D, options: []}}}
  typeNumber: {type: 1}
  fine: {type: text}
---
`
  ],
  [
    'aliases',
    `---
properties:
  A:
    type: select
    options: &opts
      - value: x
        color: red
  B:
    type: multiselect
    options: *opts
  U1:
    type: stars
    shared: &shared {k: [1, 2]}
  U2:
    type: stars
    shared: *shared
---
`
  ],
  ['empty-map', '---\nproperties: {}\n---\n\n'],
  ['empty-file', ''],
  ['whitespace-only', '  \n'],
  ['no-frontmatter', 'just a body\n'],
  ['no-properties-key', '---\nother: 1\n---\n'],
  ['properties-null', '---\nproperties:\n---\n'],
  ['properties-a-list', '---\nproperties: [1]\n---\n'],
  ['properties-a-string', '---\nproperties: text\n---\n'],
  ['yaml-error', '---\nproperties:\n  A: {type: text\n---\n'],
  ['duplicate-key', '---\nproperties:\n  A: {type: text}\n  A: {type: url}\n---\n'],
  ['unclosed', '---\nproperties:\n  A: {type: text}\n'],
  ['crlf', '---\r\nproperties:\r\n  A:\r\n    type: text\r\n---\r\n\r\n'],
  ['bom', '\uFEFF---\nproperties:\n  A:\n    type: text\n---\n\n'],
  ['body-and-other-keys', '---\nother: top\nproperties:\n  A: {type: text}\n---\nbody text\n'],
  ['top-level-list', '---\n- a\n---\n'],
  ['comment-only', '---\n# nothing\n---\n']
]

// Definitions the ops set, in file form; each is read the way the service reads a file.
const SET = {
  Stage: { type: 'select', options: [{ value: 'Done', color: 'green' }] },
  New: { type: 'date', showOnCalendar: true, defaultValue: 'today' },
  Broken: { type: 'text' },
  Status: {
    type: 'status',
    categories: {
      todo: { label: 'T', options: [] },
      in_progress: { label: 'P', options: [] },
      done: { label: 'D', options: [{ value: 'ok', color: 'green' }] }
    }
  }
}
const opsCases = [
  ['replace-keeps-position', 'electron', [['set', 'Stage']]],
  ['new-goes-last', 'electron', [['set', 'New']]],
  [
    'delete',
    'electron',
    [
      ['delete', 'Due'],
      ['delete', 'Status']
    ]
  ],
  ['set-over-unparsed', 'one-bad-entry-and-a-newer-type', [['set', 'Broken']]],
  [
    'first-write-of-a-missing-file',
    null,
    [
      ['set', 'Status'],
      ['set', 'New']
    ]
  ]
]

const temp = mkdtempSync(join(tmpdir(), 'memry-propvec-'))
let n = 0
const service = (input) => {
  const vault = join(temp, String(n++))
  mkdirSync(join(vault, '.memry'), { recursive: true })
  const file = join(vault, '.memry', 'properties.md')
  if (input !== null) writeFileSync(file, input)
  return { s: new PropertyDefinitionsService(vault), file }
}
const definitionOf = async (name, entry) => {
  const { s } = service(matter.stringify('', { properties: { [name]: entry } }))
  await s.reload()
  return s.get(name)
}

const vectors = []
for (const [name, input] of cases) {
  const { s, file } = service(input)
  const ok = await s.reload()
  let parsed = null
  try {
    const raw = input === '' ? null : matter(input).data.properties
    parsed = parsePropertyDefinitionEntries(raw)
  } catch {
    parsed = null
  }
  const unreadable = s['fileUnreadable']
  if (!unreadable) await s['persistToFile']()
  vectors.push({
    name,
    input,
    readable: ok && !unreadable,
    definitions: unreadable ? [] : s.getAll().map((def) => def.name),
    unparsed: parsed ? [...parsed.unparsed.keys()] : [],
    healed: parsed ? parsed.healed : false,
    rewritten: unreadable ? null : readFileSync(file, 'utf8')
  })
}

const opsVectors = []
for (const [name, base, ops] of opsCases) {
  const input = base === null ? null : cases.find(([caseName]) => caseName === base)[1]
  const { s, file } = service(input)
  await s.reload()
  for (const [op, target] of ops) {
    if (op === 'set') s['cache'].set(target, await definitionOf(target, SET[target]))
    else s['cache'].delete(target)
  }
  await s['persistToFile']()
  opsVectors.push({
    name,
    input,
    ops: ops.map(([op, target]) =>
      op === 'set'
        ? { set: target, entry: matter.stringify('', { properties: { [target]: SET[target] } }) }
        : { delete: target }
    ),
    written: existsSync(file) ? readFileSync(file, 'utf8') : null
  })
}
rmSync(temp, { recursive: true, force: true })

const here = dirname(fileURLToPath(import.meta.url))
mkdirSync(join(here, 'electron-vault'), { recursive: true })
writeFileSync(
  join(here, 'electron-vault', 'properties-md.json'),
  JSON.stringify({ reads: vectors, ops: opsVectors }, null, 2) + '\n'
)
