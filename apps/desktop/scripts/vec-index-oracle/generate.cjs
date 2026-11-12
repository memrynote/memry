// Writes the index fixture of the Rust vector tables
// (`crates/memry-core/src/storage/vec_tests.rs`): an index.db at index
// migration 6, as a Tauri build before the vector tables left it, holding vec0
// rows written by Electron's sqlite-vec, and the answers Electron's nearest
// query gives over them.
//
// better-sqlite3 is built for Electron's ABI, so this runs in Electron's Node:
//   cd apps/desktop && ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/vec-index-oracle/generate.cjs
// (on Linux and Windows, the `electron` binary under node_modules/electron/dist).
//
// The vec0 DDL is `ensureVecNotesTable` (`src/main/database/client.ts`) and
// `ensureVoiceVectorTables` (`src/main/database/voice-vectors.ts`) verbatim; the
// query is `nearest` of `src/main/search/semantic.ts`. `vec_images` is built at
// width 768, as a table from an older model, which the Rust open must drop.

const { mkdtempSync, readFileSync, readdirSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { gzipSync } = require('node:zlib')
const Database = require('better-sqlite3')
const sqliteVec = require('sqlite-vec')

const ROOT = join(__dirname, '..', '..', '..', '..')
const MIGRATIONS = join(ROOT, 'crates/memry-core/src/storage/migrations/index')
const FIXTURES = join(ROOT, 'crates/memry-core/tests/fixtures')
const DIMENSION = 256
const OLD_DIMENSION = 768
const K = 30

// mulberry32: the same vectors on every run.
let seed = 0x5eed2023
function random() {
  seed = (seed + 0x6d2b79f5) | 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

function unit(values) {
  const norm = Math.hypot(...values)
  return Float32Array.from(values, (v) => v / norm)
}

const noise = (n) => Array.from({ length: n }, () => random() * 2 - 1)
// Four topics, so a query has near and far neighbours instead of all at cosine ~0.
const topics = Array.from({ length: 4 }, () => unit(noise(DIMENSION)))
const nearTopic = (i) => unit(noise(DIMENSION).map((v, d) => topics[i % 4][d] * 8 + v * 0.6))

const dir = mkdtempSync(join(tmpdir(), 'vec-index-oracle-'))
const path = join(dir, 'index.db')
const db = new Database(path)
db.pragma('journal_mode = DELETE')

const migrations = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql'))
  .toSorted()
  .slice(0, 6)
if (migrations.length !== 6 || !migrations[5].startsWith('0006_')) {
  throw new Error(`expected index migrations 0001-0006, found ${migrations.join(', ')}`)
}
for (const name of migrations) db.exec(readFileSync(join(MIGRATIONS, name), 'utf8'))
db.pragma('user_version = 6')

sqliteVec.load(db)
for (const [table, id] of [
  ['vec_notes', 'note_id'],
  ['vec_note_chunks', 'chunk_id'],
  ['vec_note_similar', 'note_id']
]) {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(
      ${id} TEXT PRIMARY KEY,
      embedding float[${DIMENSION}] distance_metric=cosine
    )
  `)
}
db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_voice USING vec0(
      chunk_id TEXT PRIMARY KEY,
      embedding float[${DIMENSION}] distance_metric=cosine
    );
    CREATE TABLE IF NOT EXISTS voice_embedding_state (
      item_id TEXT PRIMARY KEY NOT NULL,
      source TEXT NOT NULL,
      input_version INTEGER NOT NULL,
      chunks INTEGER NOT NULL
    );
  `)
db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_images USING vec0(
      image_key TEXT PRIMARY KEY,
      embedding float[${OLD_DIMENSION}] distance_metric=cosine
    )
  `)

const ids = (prefix, n, suffix = '') =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(2, '0')}${suffix}`)
const rows = {
  vec_notes: ids('n', 48),
  vec_note_chunks: ids('n', 12, '#1'),
  vec_note_similar: ids('n', 48),
  vec_voice: ids('voice-', 6, '#0')
}
const idColumn = { vec_note_chunks: 'chunk_id', vec_voice: 'chunk_id' }
const stored = {}
for (const [table, keys] of Object.entries(rows)) {
  const insert = db.prepare(
    `INSERT INTO ${table} (${idColumn[table] ?? 'note_id'}, embedding) VALUES (?, ?)`
  )
  keys.forEach((key, i) => {
    const vector = nearTopic(i)
    insert.run(key, vector)
    stored[`${table}/${key}`] = vector
  })
}
const insertImage = db.prepare('INSERT INTO vec_images (image_key, embedding) VALUES (?, ?)')
for (const key of ['n00/a.png', 'n01/b.png', 'n02/']) {
  insertImage.run(key, unit(noise(OLD_DIMENSION)))
}
const insertVoiceState = db.prepare(
  "INSERT INTO voice_embedding_state VALUES (?, 'transcript', 1, 1)"
)
for (const key of rows.vec_voice) insertVoiceState.run(key.replace('#0', ''))

// One query that is a stored vector (distance 0 at the top), three that are not.
const queries = [stored['vec_note_similar/n03'], nearTopic(1), nearTopic(2), unit(noise(DIMENSION))]
const answers = {}
for (const table of Object.keys(rows)) {
  const nearest = db.prepare(
    `SELECT ${idColumn[table] ?? 'note_id'} AS id, distance FROM ${table}
           WHERE embedding MATCH ? AND k = ?
           ORDER BY distance`
  )
  answers[table] = queries.map((query) =>
    nearest.all(query, K).map((row) => [row.id, row.distance])
  )
}
const version = db.prepare('SELECT vec_version() AS v').get().v
db.close()

writeFileSync(join(FIXTURES, 'index-vec-v6.db.gz'), gzipSync(readFileSync(path), { level: 9 }))
writeFileSync(
  join(FIXTURES, 'index-vec-v6.json'),
  `${JSON.stringify(
    {
      generator: 'apps/desktop/scripts/vec-index-oracle/generate.cjs',
      sqliteVec: version,
      k: K,
      rows: Object.fromEntries(Object.entries(rows).map(([t, keys]) => [t, keys.length])),
      queries: queries.map((q) => Array.from(q)),
      answers
    },
    null,
    1
  )}\n`
)
console.log(`index-vec-v6 written with sqlite-vec ${version}`)
