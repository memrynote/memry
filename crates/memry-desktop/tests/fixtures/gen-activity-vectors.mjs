// Regenerates electron-vault/activity-jsonl.json from the Electron code:
//   cd apps/desktop && npx tsx ../../crates/memry-desktop/tests/fixtures/gen-activity-vectors.mjs
//   pnpm exec oxfmt crates/memry-desktop/tests/fixtures/electron-vault/activity-jsonl.json
// Each read case is a `.memry/activity.jsonl` (and maybe `activity-settings.json`) as Electron
// builds, people and other tools leave them. The vector holds what Electron's log lists from it,
// newest first, and the file it writes back once it compacted. `kept` holds the lines this app
// keeps byte for byte (every JSON object inside the retention window); Electron keeps only the
// ones its schema reads, rewritten. The `electron-writes` case is a file Electron's own writers
// left, built by calling them. The record cases are the lines Electron appends for given fields,
// and the scan cases the lines `recordScanActivity` appends for what a walk found.
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The log notifies windows through Electron; no window exists here.
const require = createRequire(join(process.cwd(), 'package.json'))
const electron = require.resolve('electron')
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { BrowserWindow: { getAllWindows: () => [] } }
}
const load = async (path) => {
  const ns = await import(path)
  return ns.default ?? ns
}
const log = await load('../../../../apps/desktop/src/main/vault/activity-log.ts')
console.log = console.warn = console.info = console.debug = () => {}

const NOW = Date.parse('2026-10-30T12:00:00.000Z')
const DAY = 86_400_000
let clock = NOW
Date.now = () => clock
const iso = (ms) => new Date(ms).toISOString()

const here = dirname(fileURLToPath(import.meta.url))
const memry = (vault) => join(vault, '.memry')
const freshVault = () => {
  const vault = mkdtempSync(join(tmpdir(), 'memry-activity-'))
  mkdirSync(memry(vault))
  return vault
}
const readLog = (vault) => {
  const path = join(memry(vault), 'activity.jsonl')
  return existsSync(path) ? readFileSync(path, 'utf-8') : null
}
// A lone surrogate is U+FFFD once read as UTF-8 text, which is what the Rust side compares.
const wellFormed = (value) =>
  JSON.parse(JSON.stringify(value, (_, v) => (typeof v === 'string' ? v.toWellFormed() : v)))

const line = (fields) => JSON.stringify(fields)
const entry = (ageDays, fields) => ({
  v: 1,
  id: `e${ageDays}-${fields.kind}`,
  at: iso(NOW - ageDays * DAY),
  ...fields
})

// ---------------------------------------------------------------------------------------------
// Files Electron's own writers leave.

async function electronWrites() {
  const vault = freshVault()
  log.openActivityLog(vault)
  let n = 0
  const tick = () => (clock = NOW - DAY + ++n * 1000)
  const record = (input) => (tick(), log.recordActivity(input))
  record({ kind: 'added', source: 'watcher', path: 'notes/a.md' })
  record({ kind: 'removed', source: 'watcher', path: 'notes/gone.md' })
  record({ kind: 'renamed', source: 'watcher', path: 'b/new name.md', oldPath: 'a/old name.md' })
  tick()
  log.recordSkippedFile('inbox/Photo.HEIC', 'watcher')
  tick()
  log.recordSkippedFile('inbox/Makefile', 'scan')
  record({
    kind: 'failed',
    source: 'watcher',
    path: 'x.md',
    reason: 'index-failed',
    message: 'EACCES: permission denied, open "x.md"\n\tat C:\\vault\\x.md \u0001'
  })
  tick()
  log.recordDropCopyFailure('photo (1).png', 'ENOSPC: no space left on device')
  record({
    kind: 'failed',
    source: 'sync',
    reason: 'note-too-large',
    message: 'Journal 2026 \u{1F4D3}',
    dedupeKey: 'k',
    dedupeWindowMs: 1000
  })
  record({
    kind: 'failed',
    source: 'sync',
    path: '\u65e5\u672c/\u00e9t\u00e9.pdf',
    reason: 'attachment-upload-failed',
    message: 'quota'
  })
  // The importer's order (importer before reason) and Readwise's (importer before message).
  record({
    kind: 'import',
    source: 'import',
    importer: 'notion',
    reason: 'import-canceled',
    counts: { imported: 3, attachments: 1, skipped: 0, failed: 2 },
    items: ['a \u2014 bad', 'b']
  })
  record({
    kind: 'import',
    source: 'import',
    importer: 'readwise',
    message: 'Readwise: 2 books',
    counts: { imported: 2, failed: 0 }
  })
  record({
    kind: 'failed',
    source: 'import',
    importer: 'obsidian',
    reason: 'import-failed',
    message: 'x'.repeat(700)
  })
  // Cut inside a surrogate pair: Electron writes the lone high surrogate.
  record({
    kind: 'failed',
    source: 'watcher',
    path: 'e.md',
    reason: 'read-failed',
    message: `${'a'.repeat(499)}\u{1F600}tail`
  })
  record({
    kind: 'scan',
    source: 'scan',
    counts: { added: 61, unsupported: 2 },
    items: Array.from({ length: 60 }, (_, i) => `f${i}.md`)
  })
  tick()
  log.recordScanActivity(
    { added: [], addedCount: 0, failed: [], failedCount: 0, unsupported: [], unsupportedCount: 0 },
    'rebuild'
  )
  await log.flushActivityLog()
  await log.closeActivityLog()
  const text = readLog(vault)
  rmSync(vault, { recursive: true, force: true })
  clock = NOW
  return text
}

// ---------------------------------------------------------------------------------------------
// Read cases.

async function readCase(name, lines, { settings = null, raw = null } = {}) {
  const vault = freshVault()
  const input = raw ?? lines.map((l) => `${l.text}\n`).join('')
  writeFileSync(join(memry(vault), 'activity.jsonl'), input)
  if (settings !== null) writeFileSync(join(memry(vault), 'activity-settings.json'), settings)
  clock = NOW
  log.openActivityLog(vault)
  const listed = log.listActivity({ limit: 100000 })
  const problems = log.listActivity({ limit: 100000, filter: 'problems' }).map((e) => e.id)
  const retentionDays = log.getActivityRetentionDays()
  await log.flushActivityLog()
  const rewritten = readLog(vault)
  await log.closeActivityLog()
  rmSync(vault, { recursive: true, force: true })
  return {
    name,
    input,
    settings,
    retentionDays,
    listed: wellFormed(listed),
    problems,
    electronRewritten: rewritten === input ? null : rewritten,
    kept: raw === null ? lines.filter((l) => l.keep).map((l) => l.text) : null
  }
}

const keep = (text) => ({ text, keep: true })
const drop = (text) => ({ text, keep: false })

const appended = await electronWrites()
const reads = []
reads.push(await readCase('electron-writes', [], { raw: appended }))

const canonical = [
  entry(40, { kind: 'added', source: 'watcher', path: 'old.md' }),
  entry(3, { kind: 'added', source: 'watcher', path: 'a.md' }),
  entry(2, {
    kind: 'skipped',
    source: 'watcher',
    path: 'p.heic',
    reason: 'unsupported-type',
    message: '.heic'
  }),
  entry(1, { kind: 'scan', source: 'scan', reason: 'index-rebuilt', counts: { added: 4 } }),
  entry(0, {
    kind: 'failed',
    source: 'drop',
    path: 'x.png',
    reason: 'copy-failed',
    message: 'nope'
  })
]
reads.push(
  await readCase('canonical-compaction', [
    drop(line(canonical[0])),
    keep(line(canonical[1])),
    drop('{"v":1,"id":"torn","at":"2026-10-'),
    keep(line(canonical[2])),
    keep(line(canonical[3])),
    keep(line(canonical[4]))
  ])
)

reads.push(
  await readCase('mixed', [
    keep(line(entry(1, { kind: 'added', source: 'watcher', path: 'a.md' }))),
    drop('not json at all'),
    drop('[1,2,3]'),
    drop('42'),
    drop('"a string"'),
    drop('null'),
    // A JSON object this build's schema refuses is kept, unlisted (Electron drops it).
    keep(
      line({ v: 1, id: 'np', at: iso(NOW - DAY), kind: 'added', source: 'watcher', path: null })
    ),
    keep(
      line({ v: 1, id: 'nk', at: iso(NOW - DAY), kind: 'moved', source: 'watcher', path: 'm.md' })
    ),
    keep(line({ v: 2, id: 'v2', at: iso(NOW - DAY), kind: 'added', source: 'watcher' })),
    keep(
      line({
        v: 1,
        id: 'big',
        at: iso(NOW - DAY),
        kind: 'scan',
        source: 'scan',
        items: Array.from({ length: 51 }, (_, i) => `${i}`)
      })
    ),
    keep(line({ v: 1, id: '', at: iso(NOW - DAY), kind: 'added', source: 'watcher' })),
    keep('{"note":"hand edit"}'),
    // Fields no build's schema names survive here; Electron strips them.
    keep(
      line({
        v: 1,
        id: 'xf',
        at: iso(NOW - DAY),
        kind: 'removed',
        source: 'watcher',
        path: 'r.md',
        device: 'laptop',
        extra: { n: 1 }
      })
    ),
    keep(
      `{"v":1.0,"id":"f1","at":"${iso(NOW - 2 * DAY)}","kind":"failed","source":"sync","counts":{"failed":1.5,"a":1e2}}`
    ),
    keep(
      `{"v":1,"id":"dup","id":"dup2","at":"${iso(NOW - 2 * DAY)}","kind":"added","source":"watcher"}`
    ),
    drop(line(entry(31, { kind: 'removed', source: 'watcher', path: 'old.md' }))),
    drop(line({ v: 1, id: 'nk-old', at: iso(NOW - 31 * DAY), kind: 'moved', source: 'watcher' })),
    keep(
      line(entry(0, { kind: 'skipped', source: 'scan', path: 'z.xyz', reason: 'unsupported-type' }))
    )
  ])
)

reads.push(
  await readCase(
    'retention-7',
    [
      drop(line(entry(8, { kind: 'added', source: 'watcher', path: 'eight.md' }))),
      keep(line(entry(6, { kind: 'added', source: 'watcher', path: 'six.md' })))
    ],
    { settings: '{\n  "retentionDays": 7\n}\n' }
  )
)
reads.push(
  await readCase(
    'retention-unknown',
    [keep(line(entry(29, { kind: 'added', source: 'watcher', path: 'kept.md' })))],
    { settings: '{"retentionDays":14}' }
  )
)
reads.push(
  await readCase(
    'retention-float',
    [
      drop(line(entry(91, { kind: 'added', source: 'watcher', path: 'old.md' }))),
      keep(line(entry(89, { kind: 'added', source: 'watcher', path: 'kept.md' })))
    ],
    { settings: '{"retentionDays":90.0,"other":true}' }
  )
)
reads.push(
  await readCase(
    'retention-garbage',
    [keep(line(entry(20, { kind: 'added', source: 'watcher', path: 'kept.md' })))],
    { settings: 'not json' }
  )
)
reads.push(
  await readCase('crlf', [], {
    raw: `${line(entry(1, { kind: 'added', source: 'watcher', path: 'a.md' }))}\r\n${line(entry(0, { kind: 'removed', source: 'watcher', path: 'b.md' }))}\r\n`
  })
)
reads.push(
  await readCase('bom', [], {
    raw: `\uFEFF${line(entry(1, { kind: 'added', source: 'watcher', path: 'a.md' }))}\n${line(entry(0, { kind: 'removed', source: 'watcher', path: 'b.md' }))}\n`
  })
)
reads.push(
  await readCase('blank-lines', [], {
    raw: `\n   \n${line(entry(1, { kind: 'added', source: 'watcher', path: 'a.md' }))}\n\u00a0\t\n`
  })
)
reads.push(
  await readCase('lone-surrogates', [], {
    raw: `{"v":1,"id":"s1","at":"${iso(NOW - DAY)}","kind":"failed","source":"watcher","path":"a\\udc00.md","message":"cut \\ud83d"}\n{"v":1,"id":"s2","at":"${iso(NOW)}","kind":"added","source":"watcher","path":"ok \\ud83d\\ude00.md"}\n`
  })
)

// ---------------------------------------------------------------------------------------------
// The lines Electron appends for given fields.

async function recordCase(name, input) {
  const vault = freshVault()
  log.openActivityLog(vault)
  clock = NOW
  const recorded = log.recordActivity(input)
  await log.flushActivityLog()
  const text = readLog(vault)
  await log.closeActivityLog()
  rmSync(vault, { recursive: true, force: true })
  const written = text.slice(0, -1)
  const { id, at } = JSON.parse(written)
  return { name, recorded, input, id, at, line: written }
}

const records = [
  await recordCase('watcher-added', { kind: 'added', source: 'watcher', path: 'notes/a b.md' }),
  await recordCase('renamed', {
    kind: 'renamed',
    source: 'watcher',
    path: 'n.md',
    oldPath: 'o.md'
  }),
  await recordCase('escapes', {
    kind: 'failed',
    source: 'watcher',
    path: 'q"uote\\back/sl.md',
    reason: 'read-failed',
    message: 'line\nbreak\ttab\r\u0000\u001f\u007f \u2028 /'
  }),
  await recordCase('long-message', {
    kind: 'failed',
    source: 'drop',
    path: 'p',
    reason: 'copy-failed',
    message: '\u00e9'.repeat(501)
  }),
  await recordCase('cut-before-pair', {
    kind: 'failed',
    source: 'watcher',
    path: 'e.md',
    reason: 'read-failed',
    message: `${'a'.repeat(498)}\u{1F600}tail`
  }),
  await recordCase('summary', {
    kind: 'scan',
    source: 'scan',
    reason: 'index-rebuilt',
    counts: { added: 3, unsupported: 0 },
    items: Array.from({ length: 55 }, (_, i) => `i${i}`)
  }),
  await recordCase('empty-counts', { kind: 'scan', source: 'scan', counts: {} })
]
// Electron keeps a lone high surrogate where its cut falls inside a pair.
const surrogateCut = await recordCase('cut-inside-pair', {
  kind: 'failed',
  source: 'watcher',
  path: 'e.md',
  reason: 'read-failed',
  message: `${'a'.repeat(499)}\u{1F600}tail`
})

// ---------------------------------------------------------------------------------------------
// The lines Electron's `recordScanActivity` appends for what a walk found, over a log that may
// already hold lines (an unsupported file reported before is not reported again).

async function scanCase(name, scan, mode, before = []) {
  const vault = freshVault()
  const prior = before.map((fields) => line(fields)).join('\n')
  if (before.length > 0) writeFileSync(join(memry(vault), 'activity.jsonl'), `${prior}\n`)
  log.openActivityLog(vault)
  clock = NOW
  log.recordScanActivity(scan, mode)
  await log.flushActivityLog()
  const text = readLog(vault) ?? ''
  await log.closeActivityLog()
  rmSync(vault, { recursive: true, force: true })
  const lines = text
    .split('\n')
    .filter((l) => l !== '')
    .slice(before.length)
  return { name, scan, mode, before: before.map((fields) => line(fields)), lines }
}

const walk = (fields) => ({
  added: [],
  addedCount: 0,
  failed: [],
  failedCount: 0,
  unsupported: [],
  unsupportedCount: 0,
  ...fields
})
const paths = (n, at) => Array.from({ length: n }, (_, i) => at(i))
const scans = [
  await scanCase(
    'a-few-of-each',
    walk({
      added: ['a.md', 'b/c d.md'],
      addedCount: 2,
      failed: [
        { path: 'locked.md', reason: 'read-failed', message: 'EACCES' },
        { path: 'odd.md', reason: 'index-failed' }
      ],
      failedCount: 2,
      unsupported: ['x.HEIC', 'board.canvas', '~$lock.docx', 'notes.md~', 'dir\\Makefile'],
      unsupportedCount: 5
    }),
    'scan'
  ),
  await scanCase(
    'many-added',
    walk({ added: paths(60, (i) => `new/${i}.md`), addedCount: 61 }),
    'scan'
  ),
  await scanCase(
    'twenty-added-each-listed',
    walk({ added: paths(20, (i) => `n${i}.md`), addedCount: 20 }),
    'scan'
  ),
  await scanCase(
    'first-build',
    walk({ added: ['a.md', 'b.md'], addedCount: 2, unsupported: ['x.bin'], unsupportedCount: 1 }),
    'rebuild'
  ),
  await scanCase('rebuild-of-nothing', walk({}), 'rebuild'),
  await scanCase(
    'failures-past-fifty',
    walk({
      failed: paths(55, (i) => ({ path: `f${i}.md`, reason: 'read-failed', message: `E${i}` })),
      failedCount: 70
    }),
    'scan'
  ),
  await scanCase(
    'skips-past-the-per-walk-cap-and-the-collection-cap',
    walk({ unsupported: paths(530, (i) => `u/${i}.bin`), unsupportedCount: 600 }),
    'scan'
  ),
  await scanCase(
    'a-skip-reported-before',
    walk({ unsupported: ['old.heic', 'new.heic'], unsupportedCount: 2 }),
    'scan',
    [
      {
        v: 1,
        id: 'before',
        at: iso(NOW - DAY),
        kind: 'skipped',
        source: 'watcher',
        path: 'old.heic',
        reason: 'unsupported-type',
        message: '.heic'
      }
    ]
  ),
  await scanCase(
    'twenty-one-added-summarized',
    walk({ added: paths(21, (i) => `n${i}.md`), addedCount: 21 }),
    'scan'
  ),
  await scanCase(
    'fifty-failures-each-listed',
    walk({
      failed: paths(50, (i) => ({ path: `f${i}.md`, reason: 'read-failed', message: `E${i}` })),
      failedCount: 50
    }),
    'scan'
  )
]

// ---------------------------------------------------------------------------------------------
// The settings file Electron writes.

async function settingsCase(days) {
  const vault = freshVault()
  log.openActivityLog(vault)
  await log.setActivityRetentionDays(days)
  const written = readFileSync(join(memry(vault), 'activity-settings.json'), 'utf-8')
  await log.closeActivityLog()
  rmSync(vault, { recursive: true, force: true })
  return { days, written }
}
const settings = [await settingsCase(7), await settingsCase(30), await settingsCase(90)]

writeFileSync(
  join(here, 'electron-vault', 'activity-jsonl.json'),
  `${JSON.stringify({ now: NOW, reads, records, surrogateCut, settings, scans }, null, 2)}\n`
)
process.exit(0)
