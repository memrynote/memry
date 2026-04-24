// S3 Option A bench harness.
//
// Runs all configured tests against rusqlite via Tauri commands. Times each
// invoke roundtrip with performance.now() (includes IPC + Rust + SQLite).
// Dumps results via `bench_dump_results` Tauri command for the orchestrator.

import { invoke } from '@tauri-apps/api/core'

export const OPTION = 'A' as const

const SEED_NOTES = 1000
const SEED_EMBEDDINGS = 10_000
const EMBEDDING_DIM = 128

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

function makeBlob(sizeBytes: number): number[] {
  const out = new Array<number>(sizeBytes)
  for (let i = 0; i < sizeBytes; i++) out[i] = i & 0xff
  return out
}

function randomNoteId(): string {
  const idx = Math.floor(Math.random() * SEED_NOTES)
  return `note-${String(idx).padStart(6, '0')}`
}

function buildBulkBatch(prefix: string): unknown {
  const now = Date.now()
  const lorem = 'Lorem ipsum dolor sit amet '.repeat(4)
  const notes = []
  for (let i = 0; i < 1000; i++) {
    notes.push({
      id: `${prefix}-${i}`,
      title: `Bulk Note ${i}`,
      body: `${lorem} idx-${i}`,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    })
  }
  return notes
}

function makeTests(): BenchTest[] {
  return [
    {
      name: 'test-1-list-1000',
      warmup: 1,
      runs: 10,
      fn: async () => {
        await invoke('option_a_list_notes', { limit: 1000 })
      },
    },
    {
      name: 'test-2-get-by-id',
      warmup: 5,
      runs: 100,
      fn: async () => {
        await invoke('option_a_get_note', { id: randomNoteId() })
      },
    },
    {
      name: 'test-3-bulk-insert-1000',
      warmup: 0,
      runs: 1,
      fn: async (i) => {
        await invoke('option_a_bulk_insert', { notes: buildBulkBatch(`bulk-A-${i}`) })
      },
    },
    {
      name: 'test-4-vector-knn-10k',
      warmup: 1,
      runs: 10,
      fn: async () => {
        await invoke('option_a_vector_search', { query: randomVector(), k: 10 })
      },
    },
    {
      name: 'test-5-fts-search',
      warmup: 1,
      runs: 10,
      fn: async () => {
        await invoke('option_a_fts_search', { query: 'lorem', limit: 100 })
      },
    },
    {
      name: 'test-6-blob-50kb-write',
      warmup: 1,
      runs: 10,
      fn: async (i) => {
        await invoke('option_a_blob_write', { key: `bench-blob-${i}`, data: makeBlob(50 * 1024) })
      },
    },
    {
      name: 'test-6b-blob-50kb-read',
      warmup: 1,
      runs: 10,
      fn: async () => {
        await invoke('option_a_blob_read', { key: 'bench-blob-0' })
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
  await invoke('option_a_seed_notes', { n: SEED_NOTES })
  onProgress(`seeding ${SEED_EMBEDDINGS} embeddings`)
  await invoke('option_a_seed_embeddings', { n: SEED_EMBEDDINGS })
  // priming write so test-6b read has something
  await invoke('option_a_blob_write', { key: 'bench-blob-0', data: makeBlob(50 * 1024) })
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
