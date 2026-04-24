import Database from '@tauri-apps/plugin-sql'

export const EMBEDDING_DIM = 128
const SEED = 0xdeadbeef

export interface Note {
  id: string
  title: string
  body: string
  created_at: number
  updated_at: number
  deleted_at: number | null
}

let dbCache: Database | null = null

export async function getOptionBDb(): Promise<Database> {
  if (!dbCache) {
    dbCache = await Database.load('sqlite:s3-plugin-sql.db')
  }
  return dbCache
}

export async function listNotes(limit: number): Promise<Note[]> {
  const db = await getOptionBDb()
  return db.select<Note[]>(
    'SELECT id, title, body, created_at, updated_at, deleted_at FROM notes WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT $1',
    [limit],
  )
}

export async function getNote(id: string): Promise<Note | null> {
  const db = await getOptionBDb()
  const rows = await db.select<Note[]>(
    'SELECT id, title, body, created_at, updated_at, deleted_at FROM notes WHERE id = $1',
    [id],
  )
  return rows[0] ?? null
}

export async function bulkInsertNotes(notes: Note[]): Promise<number> {
  const db = await getOptionBDb()
  await db.execute('BEGIN')
  try {
    for (const n of notes) {
      await db.execute(
        'INSERT INTO notes (id, title, body, created_at, updated_at, deleted_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [n.id, n.title, n.body, n.created_at, n.updated_at, n.deleted_at],
      )
    }
    await db.execute('COMMIT')
  } catch (err) {
    await db.execute('ROLLBACK')
    throw err
  }
  return notes.length
}

// Multi-row INSERT batch size keeps placeholder count under SQLite's
// SQLITE_MAX_VARIABLE_NUMBER (default 999 in older builds, 32766 in newer).
// notes has 5 cols → 100 rows = 500 placeholders (safe everywhere).
const BATCH_NOTES = 100
const BATCH_EMBEDDINGS = 100

function rowPlaceholders(rowCount: number, colCount: number, valueExtras: string[] = []): string {
  const groups: string[] = []
  let n = 1
  for (let r = 0; r < rowCount; r++) {
    const cells: string[] = []
    for (let c = 0; c < colCount; c++) cells.push(`$${n++}`)
    cells.push(...valueExtras)
    groups.push(`(${cells.join(', ')})`)
  }
  return groups.join(', ')
}

export async function seedNotes(n: number): Promise<number> {
  const db = await getOptionBDb()
  await db.execute('DELETE FROM notes')
  await db.execute('DELETE FROM notes_fts')
  const now = Date.now()
  const lorem = 'Lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(8)
  await db.execute('BEGIN')
  try {
    for (let start = 0; start < n; start += BATCH_NOTES) {
      const end = Math.min(start + BATCH_NOTES, n)
      const rows = end - start
      const noteParams: unknown[] = []
      const ftsParams: unknown[] = []
      for (let i = start; i < end; i++) {
        const id = `note-${String(i).padStart(6, '0')}`
        const title = `Test Note #${i}`
        const body = `${lorem} body-tag-${i}`
        const ts = now - i * 60_000
        noteParams.push(id, title, body, ts, ts)
        ftsParams.push(id, title, body)
      }
      await db.execute(
        `INSERT INTO notes (id, title, body, created_at, updated_at, deleted_at) VALUES ${rowPlaceholders(rows, 5, ['NULL'])}`,
        noteParams,
      )
      await db.execute(
        `INSERT INTO notes_fts (id, title, body) VALUES ${rowPlaceholders(rows, 3)}`,
        ftsParams,
      )
    }
    await db.execute('COMMIT')
  } catch (err) {
    await db.execute('ROLLBACK')
    throw err
  }
  return n
}

function seededRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return (s & 0x7fffffff) / 0x7fffffff
  }
}

export async function seedEmbeddings(n: number): Promise<number> {
  const db = await getOptionBDb()
  await db.execute('DELETE FROM embeddings')
  const rng = seededRng(SEED)
  await db.execute('BEGIN')
  try {
    for (let start = 0; start < n; start += BATCH_EMBEDDINGS) {
      const end = Math.min(start + BATCH_EMBEDDINGS, n)
      const rows = end - start
      const params: unknown[] = []
      for (let i = start; i < end; i++) {
        const id = `emb-${String(i).padStart(6, '0')}`
        const buf = new ArrayBuffer(EMBEDDING_DIM * 4)
        const view = new DataView(buf)
        for (let j = 0; j < EMBEDDING_DIM; j++) {
          view.setFloat32(j * 4, rng() * 2 - 1, true)
        }
        params.push(id, Array.from(new Uint8Array(buf)))
      }
      await db.execute(
        `INSERT INTO embeddings (note_id, embedding) VALUES ${rowPlaceholders(rows, 2)}`,
        params,
      )
    }
    await db.execute('COMMIT')
  } catch (err) {
    await db.execute('ROLLBACK')
    throw err
  }
  return n
}

export async function vectorSearch(query: number[], k: number): Promise<Array<[string, number]>> {
  if (query.length !== EMBEDDING_DIM) {
    throw new Error(`query dim ${query.length} != expected ${EMBEDDING_DIM}`)
  }
  const db = await getOptionBDb()
  const rows = await db.select<Array<{ note_id: string; embedding: number[] }>>(
    'SELECT note_id, embedding FROM embeddings',
  )
  const scored: Array<[string, number]> = []
  for (const row of rows) {
    const bytes = new Uint8Array(row.embedding)
    if (bytes.byteLength !== EMBEDDING_DIM * 4) continue
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let dot = 0
    let na = 0
    let nb = 0
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      const v = view.getFloat32(i * 4, true)
      const q = query[i]!
      dot += v * q
      na += v * v
      nb += q * q
    }
    const cos = na > 0 && nb > 0 ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
    scored.push([row.note_id, cos])
  }
  scored.sort((a, b) => b[1] - a[1])
  return scored.slice(0, k)
}

export async function ftsSearch(query: string, limit: number): Promise<string[]> {
  const db = await getOptionBDb()
  const rows = await db.select<Array<{ id: string }>>(
    'SELECT id FROM notes_fts WHERE notes_fts MATCH $1 LIMIT $2',
    [query, limit],
  )
  return rows.map((r) => r.id)
}

export async function blobWrite(key: string, data: Uint8Array): Promise<number> {
  const db = await getOptionBDb()
  await db.execute('INSERT OR REPLACE INTO blobs (key, data) VALUES ($1, $2)', [
    key,
    Array.from(data),
  ])
  return data.byteLength
}

export async function blobRead(key: string): Promise<Uint8Array | null> {
  const db = await getOptionBDb()
  const rows = await db.select<Array<{ data: number[] }>>(
    'SELECT data FROM blobs WHERE key = $1',
    [key],
  )
  if (rows.length === 0) return null
  return new Uint8Array(rows[0]!.data)
}

export async function countNotes(): Promise<number> {
  const db = await getOptionBDb()
  const rows = await db.select<Array<{ c: number }>>('SELECT COUNT(*) AS c FROM notes')
  return rows[0]?.c ?? 0
}
