import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as dataSchema from '@memry/db-schema/data-schema'
import * as indexSchema from '@memry/db-schema/index-schema'
import * as sqliteVec from 'sqlite-vec'
import { createFtsTable } from '../src/main/database/fts'
import { createFtsInboxTable } from '../src/main/database/fts-inbox'
import { createFtsTasksTable } from '../src/main/database/fts-tasks'
import { getGraphData } from '../src/main/database/queries/graph'
import { searchAll } from '../src/main/database/queries/search'
import { listTasks } from '../src/main/database/queries/tasks'
import {
  SQLITE_DATA_CACHE_KIB,
  SQLITE_INDEX_CACHE_KIB,
  SQLITE_TEMP_STORE
} from '../src/main/database/client'
import { EMBEDDING_DIMENSION } from '../src/main/lib/embeddings-constants'
import type { DataDb, IndexDb } from '../src/main/database/types'

type TempStore = 'DEFAULT' | 'FILE' | 'MEMORY'

interface Options {
  notes: number
  tasks: number
  inbox: number
  iterations: number
  dataCacheKiB: number
  indexCacheKiB: number
  tempStore: TempStore
  keep: boolean
}

interface TimingSummary {
  min: number
  p50: number
  p95: number
  max: number
  avg: number
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const desktopRoot = path.resolve(scriptDir, '..')
const dataMigrations = path.join(desktopRoot, 'src/main/database/drizzle-data')
const indexMigrations = path.join(desktopRoot, 'src/main/database/drizzle-index')

const defaultOptions: Options = {
  notes: 2500,
  tasks: 1200,
  inbox: 500,
  iterations: 40,
  dataCacheKiB: SQLITE_DATA_CACHE_KIB,
  indexCacheKiB: SQLITE_INDEX_CACHE_KIB,
  tempStore: SQLITE_TEMP_STORE as TempStore,
  keep: false
}

function parseNumber(value: string, flag: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive number`)
  }
  return Math.floor(parsed)
}

function parseArgs(argv: string[]): Options {
  const options = { ...defaultOptions }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]

    switch (arg) {
      case '--':
        break
      case '--notes':
        if (!next) throw new Error('--notes requires a value')
        options.notes = parseNumber(next, arg)
        i += 1
        break
      case '--tasks':
        if (!next) throw new Error('--tasks requires a value')
        options.tasks = parseNumber(next, arg)
        i += 1
        break
      case '--inbox':
        if (!next) throw new Error('--inbox requires a value')
        options.inbox = parseNumber(next, arg)
        i += 1
        break
      case '--iterations':
        if (!next) throw new Error('--iterations requires a value')
        options.iterations = parseNumber(next, arg)
        i += 1
        break
      case '--data-cache-kib':
        if (!next) throw new Error('--data-cache-kib requires a value')
        options.dataCacheKiB = parseNumber(next, arg)
        i += 1
        break
      case '--index-cache-kib':
        if (!next) throw new Error('--index-cache-kib requires a value')
        options.indexCacheKiB = parseNumber(next, arg)
        i += 1
        break
      case '--temp-store':
        if (!next) throw new Error('--temp-store requires a value')
        if (!['DEFAULT', 'FILE', 'MEMORY'].includes(next)) {
          throw new Error('--temp-store must be DEFAULT, FILE, or MEMORY')
        }
        options.tempStore = next as TempStore
        i += 1
        break
      case '--keep':
        options.keep = true
        break
      case '--help':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return options
}

function printHelp(): void {
  console.log(`Usage: pnpm db:benchmark [options]

Options:
  --notes <n>             Note rows to seed, default ${defaultOptions.notes}
  --tasks <n>             Task rows to seed, default ${defaultOptions.tasks}
  --inbox <n>             Inbox rows to seed, default ${defaultOptions.inbox}
  --iterations <n>        Query iterations, default ${defaultOptions.iterations}
  --data-cache-kib <n>    data.db page-cache cap in KiB, default product value
  --index-cache-kib <n>   index.db page-cache cap in KiB, default product value
  --temp-store <mode>     DEFAULT, FILE, or MEMORY, default product value
  --keep                  Keep the generated temp vault for inspection
`)
}

function bytesToMiB(value: number): string {
  return (value / 1024 / 1024).toFixed(1)
}

function measureMemoryMiB(): number {
  if (typeof global.gc === 'function') global.gc()
  return Number(bytesToMiB(process.memoryUsage().rss))
}

function summarize(values: number[]): TimingSummary {
  const sorted = [...values].sort((a, b) => a - b)
  const percentile = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))]
  const avg = sorted.reduce((sum, value) => sum + value, 0) / sorted.length
  return {
    min: Number(sorted[0].toFixed(2)),
    p50: Number(percentile(0.5).toFixed(2)),
    p95: Number(percentile(0.95).toFixed(2)),
    max: Number(sorted[sorted.length - 1].toFixed(2)),
    avg: Number(avg.toFixed(2))
  }
}

function measure(label: string, iterations: number, fn: () => unknown): [string, TimingSummary] {
  const durations: number[] = []

  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now()
    fn()
    durations.push(performance.now() - start)
  }

  return [label, summarize(durations)]
}

function configure(
  sqlite: Database.Database,
  cacheKiB: number,
  tempStore: TempStore,
  foreignKeys: boolean
): void {
  sqlite.pragma('journal_mode = WAL')
  if (foreignKeys) sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('synchronous = NORMAL')
  sqlite.pragma('busy_timeout = 5000')
  sqlite.pragma(`cache_size = -${cacheKiB}`)
  sqlite.pragma(`temp_store = ${tempStore}`)
}

function runMigrations(dbPath: string, migrationsFolder: string): void {
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  migrate(drizzle(sqlite), { migrationsFolder })
  sqlite.close()
}

function phrase(i: number): string {
  const topic = i % 5 === 0 ? 'sqlite memory search graph tasks' : 'memry local first notes'
  return `${topic} benchmark row ${i} with repeated searchable content and linked context`
}

function seedIndex(indexSqlite: Database.Database, indexDb: IndexDb, notes: number): void {
  createFtsTable(indexDb)

  sqliteVec.load(indexSqlite)
  indexSqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_notes USING vec0(
      note_id TEXT PRIMARY KEY,
      embedding float[${EMBEDDING_DIMENSION}] distance_metric=cosine
    )
  `)

  const insertNote = indexSqlite.prepare(`
    INSERT INTO note_cache (
      id, path, title, file_type, emoji, content_hash, word_count, character_count,
      snippet, date, created_at, modified_at, indexed_at
    ) VALUES (?, ?, ?, 'markdown', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertFts = indexSqlite.prepare(`
    INSERT INTO fts_notes (id, title, content, tags) VALUES (?, ?, ?, ?)
  `)
  const insertTag = indexSqlite.prepare(`
    INSERT INTO note_tags (note_id, tag, position) VALUES (?, ?, ?)
  `)
  const insertLink = indexSqlite.prepare(`
    INSERT INTO note_links (source_id, target_id, target_title) VALUES (?, ?, ?)
  `)
  const insertVec = indexSqlite.prepare(`
    INSERT INTO vec_notes (note_id, embedding) VALUES (?, ?)
  `)
  const now = new Date('2026-05-21T12:00:00.000Z').toISOString()

  const transaction = indexSqlite.transaction(() => {
    for (let i = 0; i < notes; i += 1) {
      const id = `note-${i}`
      const title = i % 5 === 0 ? `SQLite memory note ${i}` : `Local note ${i}`
      const content = phrase(i)
      const date = i % 10 === 0 ? `2026-05-${String((i % 28) + 1).padStart(2, '0')}` : null

      insertNote.run(
        id,
        `notes/${id}.md`,
        title,
        null,
        `hash-${i}`,
        content.split(/\s+/).length,
        content.length,
        content.slice(0, 120),
        date,
        now,
        now,
        now
      )
      insertFts.run(id, title, content, i % 5 === 0 ? 'sqlite memory search' : 'local notes')
      insertTag.run(id, i % 5 === 0 ? 'sqlite' : 'notes', 0)

      if (i > 0) {
        insertLink.run(id, `note-${i - 1}`, `Local note ${i - 1}`)
      }

      if (i < 250) {
        const embedding = new Float32Array(EMBEDDING_DIMENSION)
        for (let j = 0; j < EMBEDDING_DIMENSION; j += 1) {
          embedding[j] = ((i + j) % 17) / 17
        }
        insertVec.run(id, embedding)
      }
    }
  })

  transaction()
}

function seedData(
  dataSqlite: Database.Database,
  dataDb: DataDb,
  tasks: number,
  inbox: number
): void {
  createFtsTasksTable(dataDb)
  createFtsInboxTable(dataDb)

  const now = new Date('2026-05-21T12:00:00.000Z').toISOString()
  const insertProject = dataSqlite.prepare(`
    INSERT INTO projects (
      id, name, description, color, icon, position, is_inbox, created_at, modified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertStatus = dataSqlite.prepare(`
    INSERT INTO statuses (
      id, project_id, name, color, position, is_default, is_done, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertTask = dataSqlite.prepare(`
    INSERT INTO tasks (
      id, project_id, status_id, title, description, priority, position,
      due_date, created_at, modified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertTaskFts = dataSqlite.prepare(`
    INSERT INTO fts_tasks (id, title, description, tags) VALUES (?, ?, ?, ?)
  `)
  const insertInbox = dataSqlite.prepare(`
    INSERT INTO inbox_items (
      id, type, title, content, source_title, source_url, capture_source,
      processing_status, created_at, modified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'complete', ?, ?)
  `)
  const insertInboxFts = dataSqlite.prepare(`
    INSERT INTO fts_inbox (id, title, content, transcription, source_title)
    VALUES (?, ?, ?, '', ?)
  `)

  const transaction = dataSqlite.transaction(() => {
    for (let i = 0; i < 5; i += 1) {
      insertProject.run(
        `project-${i}`,
        `Project ${i}`,
        'Benchmark project',
        '#6366f1',
        'folder',
        i,
        i === 0 ? 1 : 0,
        now,
        now
      )
      insertStatus.run(`status-${i}`, `project-${i}`, 'To Do', '#6b7280', 0, 1, 0, now)
    }

    for (let i = 0; i < tasks; i += 1) {
      const project = `project-${i % 5}`
      const status = `status-${i % 5}`
      const title = i % 5 === 0 ? `SQLite memory task ${i}` : `Task ${i}`
      const description = phrase(i)
      insertTask.run(
        `task-${i}`,
        project,
        status,
        title,
        description,
        i % 4,
        i,
        `2026-06-${String((i % 28) + 1).padStart(2, '0')}`,
        now,
        now
      )
      insertTaskFts.run(`task-${i}`, title, description, i % 5 === 0 ? 'sqlite memory' : 'tasks')
    }

    for (let i = 0; i < inbox; i += 1) {
      const title = i % 5 === 0 ? `SQLite memory inbox ${i}` : `Inbox item ${i}`
      const content = phrase(i)
      insertInbox.run(
        `inbox-${i}`,
        i % 3 === 0 ? 'link' : 'note',
        title,
        content,
        `Source ${i}`,
        `https://example.com/${i}`,
        'quick-capture',
        now,
        now
      )
      insertInboxFts.run(`inbox-${i}`, title, content, `Source ${i}`)
    }
  })

  transaction()
}

function benchmark(options: Options): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-sqlite-benchmark-'))
  const dataPath = path.join(tempDir, 'data.db')
  const indexPath = path.join(tempDir, 'index.db')

  let dataSqlite: Database.Database | null = null
  let indexSqlite: Database.Database | null = null

  try {
    const memoryStart = measureMemoryMiB()
    runMigrations(dataPath, dataMigrations)
    runMigrations(indexPath, indexMigrations)

    dataSqlite = new Database(dataPath)
    indexSqlite = new Database(indexPath)
    configure(dataSqlite, options.dataCacheKiB, options.tempStore, true)
    configure(indexSqlite, options.indexCacheKiB, options.tempStore, false)

    const dataDb = drizzle(dataSqlite, { schema: dataSchema })
    const indexDb = drizzle(indexSqlite, { schema: indexSchema })

    const openLatencyStart = performance.now()
    const dataCache = dataSqlite.pragma('cache_size', { simple: true })
    const indexCache = indexSqlite.pragma('cache_size', { simple: true })
    const dataTempStore = dataSqlite.pragma('temp_store', { simple: true })
    const indexTempStore = indexSqlite.pragma('temp_store', { simple: true })
    const openLatencyMs = performance.now() - openLatencyStart

    seedData(dataSqlite, dataDb, options.tasks, options.inbox)
    seedIndex(indexSqlite, indexDb, options.notes)
    const memoryAfterSeed = measureMemoryMiB()

    const query = {
      text: 'sqlite memory',
      types: [],
      tags: [],
      dateRange: null,
      projectId: null,
      folderPath: null,
      limit: 20,
      offset: 0
    }

    searchAll(indexDb, dataDb, query)
    getGraphData(indexDb, dataDb)
    listTasks(dataDb, { limit: 100 })
    dataSqlite
      .prepare(
        `SELECT id, title FROM inbox_items
         WHERE filed_at IS NULL AND archived_at IS NULL
         ORDER BY created_at DESC LIMIT 100`
      )
      .all()
    indexSqlite
      .prepare(
        `SELECT note_id, distance FROM vec_notes
         WHERE embedding MATCH ? AND k = 5
         ORDER BY distance`
      )
      .all(new Float32Array(EMBEDDING_DIMENSION))

    const memoryAfterWarmup = measureMemoryMiB()
    const results = [
      measure('searchAll', options.iterations, () => searchAll(indexDb, dataDb, query)),
      measure('getGraphData', options.iterations, () => getGraphData(indexDb, dataDb)),
      measure('listTasks', options.iterations, () => listTasks(dataDb, { limit: 100 })),
      measure('listInbox', options.iterations, () =>
        dataSqlite
          ?.prepare(
            `SELECT id, title FROM inbox_items
             WHERE filed_at IS NULL AND archived_at IS NULL
             ORDER BY created_at DESC LIMIT 100`
          )
          .all()
      ),
      measure('vectorKnn', options.iterations, () =>
        indexSqlite
          ?.prepare(
            `SELECT note_id, distance FROM vec_notes
             WHERE embedding MATCH ? AND k = 5
             ORDER BY distance`
          )
          .all(new Float32Array(EMBEDDING_DIMENSION))
      )
    ]

    console.log(
      JSON.stringify(
        {
          config: {
            notes: options.notes,
            tasks: options.tasks,
            inbox: options.inbox,
            iterations: options.iterations,
            dataCacheKiB: options.dataCacheKiB,
            indexCacheKiB: options.indexCacheKiB,
            tempStore: options.tempStore,
            reportedPragmas: {
              dataCache,
              indexCache,
              dataTempStore,
              indexTempStore
            }
          },
          memoryMiB: {
            start: memoryStart,
            afterSeed: memoryAfterSeed,
            afterWarmup: memoryAfterWarmup
          },
          openLatencyMs: Number(openLatencyMs.toFixed(2)),
          timingsMs: Object.fromEntries(results),
          tempDir: options.keep ? tempDir : undefined
        },
        null,
        2
      )
    )
  } finally {
    dataSqlite?.close()
    indexSqlite?.close()
    if (!options.keep) {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  }
}

try {
  benchmark(parseArgs(process.argv.slice(2)))
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
