// Option C — Hybrid renderer helpers.
//
// Simple CRUD via plugin-sql (Database.load → SELECT/COUNT).
// Hot paths re-export Tauri invoke wrappers (vector search, FTS, bulk insert,
// seed, blob R/W) — Rust does the heavy lifting.

import { invoke } from '@tauri-apps/api/core'
import Database from '@tauri-apps/plugin-sql'

export const EMBEDDING_DIM = 128

export interface Note {
  id: string
  title: string
  body: string
  created_at: number
  updated_at: number
  deleted_at: number | null
}

let dbCache: Database | null = null

export async function getOptionCDb(): Promise<Database> {
  if (!dbCache) {
    dbCache = await Database.load('sqlite:s3-hybrid.db')
  }
  return dbCache
}

// === Simple CRUD via plugin-sql ===

export async function listNotes(limit: number): Promise<Note[]> {
  const db = await getOptionCDb()
  return db.select<Note[]>(
    'SELECT id, title, body, created_at, updated_at, deleted_at FROM notes WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT $1',
    [limit],
  )
}

export async function getNote(id: string): Promise<Note | null> {
  const db = await getOptionCDb()
  const rows = await db.select<Note[]>(
    'SELECT id, title, body, created_at, updated_at, deleted_at FROM notes WHERE id = $1',
    [id],
  )
  return rows[0] ?? null
}

export async function countNotes(): Promise<number> {
  const db = await getOptionCDb()
  const rows = await db.select<Array<{ c: number }>>('SELECT COUNT(*) AS c FROM notes')
  return rows[0]?.c ?? 0
}

// === Hot paths via Rust invoke ===

export async function bulkInsertNotes(notes: Note[]): Promise<number> {
  return invoke<number>('option_c_bulk_insert', { notes })
}

export async function seedNotes(n: number): Promise<number> {
  return invoke<number>('option_c_seed_notes', { n })
}

export async function seedEmbeddings(n: number): Promise<number> {
  return invoke<number>('option_c_seed_embeddings', { n })
}

export async function vectorSearch(query: number[], k: number): Promise<Array<[string, number]>> {
  return invoke<Array<[string, number]>>('option_c_vector_search', { query, k })
}

export async function ftsSearch(query: string, limit: number): Promise<string[]> {
  return invoke<string[]>('option_c_fts_search', { query, limit })
}

export async function blobWrite(key: string, data: Uint8Array): Promise<number> {
  return invoke<number>('option_c_blob_write', { key, data: Array.from(data) })
}

export async function blobRead(key: string): Promise<Uint8Array | null> {
  const result = await invoke<number[] | null>('option_c_blob_read', { key })
  return result === null ? null : new Uint8Array(result)
}
