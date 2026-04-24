// S3 Option C bench harness — hybrid: simple CRUD via plugin-sql, hot paths
// via Tauri commands.

import { invoke } from '@tauri-apps/api/core'
import {
  blobRead,
  blobWrite,
  bulkInsertNotes,
  EMBEDDING_DIM,
  ftsSearch,
  getNote,
  listNotes,
  seedEmbeddings,
  seedNotes,
  vectorSearch,
} from './db-option-c'

export const OPTION = 'C' as const

const SEED_NOTES = 1000
const SEED_EMBEDDINGS = 10_000

interface BenchTest {
  name: string
  warmup?: number
  runs: number
  fn: (i: number) => Promise<void>
}

export interface TestRun {
  option: 'A' | 'B' | 'C'
  test: string
  samples: number[]
  p50: number
  p95: number
  unit: string
  pass: boolean
  notes: string
}

function randomVector(): number[] {
  const v = new Array<number>(EMBEDDING_DIM)
  for (let i = 0; i < EMBEDDING_DIM; i++) v[i] = Math.random() * 2 - 1
  return v
}

function makeBlob(sizeBytes: number): Uint8Array {
  const out = new Uint8Array(sizeBytes)
  for (let i = 0; i < sizeBytes; i++) out[i] = i & 0xff
  return out
}

function randomNoteId(): string {
  const idx = Math.floor(Math.random() * SEED_NOTES)
  return `note-${String(idx).padStart(6, '0')}`
}

function buildBulkBatch(prefix: string) {
  const now = Date.now()
  const lorem = 'Lorem ipsum dolor sit amet '.repeat(4)
  const out = []
  for (let i = 0; i < 1000; i++) {
    out.push({
      id: `${prefix}-${i}`,
      title: `Bulk Note ${i}`,
      body: `${lorem} idx-${i}`,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    })
  }
  return out
}

function makeTests(): BenchTest[] {
  return [
    {
      name: 'test-1-list-1000',
      warmup: 1,
      runs: 10,
      fn: async () => {
        await listNotes(1000)
      },
    },
    {
      name: 'test-2-get-by-id',
      warmup: 5,
      runs: 100,
      fn: async () => {
        await getNote(randomNoteId())
      },
    },
    {
      name: 'test-3-bulk-insert-1000',
      warmup: 0,
      runs: 1,
      fn: async (i) => {
        await bulkInsertNotes(buildBulkBatch(`bulk-C-${i}`))
      },
    },
    {
      name: 'test-4-vector-knn-10k',
      warmup: 1,
      runs: 10,
      fn: async () => {
        await vectorSearch(randomVector(), 10)
      },
    },
    {
      name: 'test-5-fts-search',
      warmup: 1,
      runs: 10,
      fn: async () => {
        await ftsSearch('lorem', 100)
      },
    },
    {
      name: 'test-6-blob-50kb-write',
      warmup: 1,
      runs: 10,
      fn: async (i) => {
        await blobWrite(`bench-blob-${i}`, makeBlob(50 * 1024))
      },
    },
    {
      name: 'test-6b-blob-50kb-read',
      warmup: 1,
      runs: 10,
      fn: async () => {
        await blobRead('bench-blob-0')
      },
    },
  ]
}

async function runBench(tests: BenchTest[]): Promise<TestRun[]> {
  const out: TestRun[] = []
  for (const t of tests) {
    try {
      for (let w = 0; w < (t.warmup ?? 0); w++) await t.fn(w)
      const samples: number[] = []
      for (let i = 0; i < t.runs; i++) {
        const start = performance.now()
        await t.fn(i)
        samples.push(performance.now() - start)
      }
      samples.sort((a, b) => a - b)
      out.push({
        option: OPTION,
        test: t.name,
        samples,
        p50: samples[Math.floor(samples.length * 0.5)] ?? 0,
        p95: samples[Math.floor(samples.length * 0.95)] ?? 0,
        unit: 'ms',
        pass: true,
        notes: '',
      })
    } catch (err) {
      out.push({
        option: OPTION,
        test: t.name,
        samples: [],
        p50: 0,
        p95: 0,
        unit: 'ms',
        pass: false,
        notes: String(err),
      })
    }
  }
  return out
}

export async function runAllBench(onProgress: (msg: string) => void): Promise<TestRun[]> {
  onProgress('seeding 1000 notes')
  await seedNotes(SEED_NOTES)
  onProgress(`seeding ${SEED_EMBEDDINGS} embeddings`)
  await seedEmbeddings(SEED_EMBEDDINGS)
  await blobWrite('bench-blob-0', makeBlob(50 * 1024))
  const tests = makeTests()
  const results: TestRun[] = []
  for (const t of tests) {
    onProgress(`running ${t.name}`)
    const partial = await runBench([t])
    results.push(...partial)
  }
  onProgress('dumping results')
  await invoke('bench_dump_results', {
    option: OPTION,
    json: JSON.stringify({ runs: results }),
  })
  onProgress('done')
  return results
}
