// S3 benchmark orchestrator — runs query/seed/vector/FTS/blob bench tests
// against Options A, B, C, then aggregates `s3-query-latency.json`.
//
// Harness model:
//   - Each prototype embeds bench logic in its renderer (App.tsx → runAllBenchmarks).
//   - On Tauri runtime mount, it auto-runs all configured tests (real IPC, real
//     plugin-sql, real rusqlite — apples-to-apples).
//   - Each prototype dumps results via a `bench_dump_results` Tauri command to
//     `/tmp/s3-<OPTION>-results.json`.
//   - This orchestrator launches `pnpm tauri dev` per prototype, polls for the
//     results file, then kills the process and moves on.
//
// Bundle size (Test #8) and migration cold (Test #7) are measured separately:
//   - Bundle: `pnpm tauri build --release` + `du -sh` per prototype (run by
//     bench-db-bundle-size.ts).
//   - Migrations: also measured in-app via the bench loop (uses scratch DB, see
//     run_migrations_bench command per option).

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { collectEnvironment } from './collect-environment.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '../../../..')
const SCRIPT_DIR = __dirname
const BENCH_OUT = resolve(SCRIPT_DIR, '../benchmarks/s3-query-latency.json')

interface OptionConfig {
  option: 'A' | 'B' | 'C'
  prototypeDir: string
  resultFile: string
}

const OPTIONS: OptionConfig[] = [
  {
    option: 'A',
    prototypeDir: resolve(REPO_ROOT, 'spikes/tauri-risk-discovery/prototypes/s3-rusqlite'),
    resultFile: '/tmp/s3-A-results.json',
  },
  {
    option: 'B',
    prototypeDir: resolve(REPO_ROOT, 'spikes/tauri-risk-discovery/prototypes/s3-plugin-sql'),
    resultFile: '/tmp/s3-B-results.json',
  },
  {
    option: 'C',
    prototypeDir: resolve(REPO_ROOT, 'spikes/tauri-risk-discovery/prototypes/s3-hybrid'),
    resultFile: '/tmp/s3-C-results.json',
  },
]

const APP_BOOT_TIMEOUT_MS = 60_000
const BENCH_TIMEOUT_MS = 180_000
const POLL_INTERVAL_MS = 1_000

interface TestRun {
  option: 'A' | 'B' | 'C'
  test: string
  samples: number[]
  p50: number
  p95: number
  unit: string
  pass: boolean
  notes: string
}

async function runOptionBench(cfg: OptionConfig): Promise<TestRun[]> {
  if (existsSync(cfg.resultFile)) unlinkSync(cfg.resultFile)

  console.log(`[bench] launching ${cfg.option} via tauri dev (${cfg.prototypeDir})`)
  const proc = spawn('pnpm', ['tauri', 'dev'], {
    cwd: cfg.prototypeDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BENCH_MODE: '1' },
  })

  let proceeded = false
  proc.stdout?.on('data', (chunk) => {
    const s = chunk.toString()
    if (!proceeded && /Running.*tauri.*build|App listening on/i.test(s)) {
      proceeded = true
      console.log(`[bench] ${cfg.option} app started`)
    }
  })
  proc.stderr?.on('data', (chunk) => {
    const s = chunk.toString().trim()
    if (s.length > 0 && !s.includes('warning')) console.log(`[bench:${cfg.option}:err] ${s}`)
  })

  const deadline = Date.now() + APP_BOOT_TIMEOUT_MS + BENCH_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (existsSync(cfg.resultFile)) {
      console.log(`[bench] ${cfg.option} results detected`)
      const json = JSON.parse(readFileSync(cfg.resultFile, 'utf8'))
      proc.kill('SIGKILL')
      return (json.runs ?? []) as TestRun[]
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }

  proc.kill('SIGKILL')
  console.warn(`[bench] ${cfg.option} timed out after ${(BENCH_TIMEOUT_MS + APP_BOOT_TIMEOUT_MS) / 1000}s`)
  return []
}

async function main(): Promise<void> {
  const env = await collectEnvironment()
  const allRuns: TestRun[] = []

  for (const cfg of OPTIONS) {
    try {
      const runs = await runOptionBench(cfg)
      allRuns.push(...runs)
    } catch (err) {
      console.error(`[bench] ${cfg.option} failed:`, err)
    }
  }

  const output = {
    schema_version: 1,
    spike: 's3-db-placement',
    benchmark: 'query-latency',
    timestamp: new Date().toISOString(),
    environment: env,
    runs: allRuns,
    notes: 'Bench tests run inside live Tauri runtime via auto-bench mode. Bundle size measured separately.',
  }

  writeFileSync(BENCH_OUT, JSON.stringify(output, null, 2))
  console.log(`[bench] wrote ${BENCH_OUT} (${allRuns.length} runs across ${OPTIONS.length} options)`)
}

main().catch((err) => {
  console.error('[bench] fatal:', err)
  process.exit(1)
})
