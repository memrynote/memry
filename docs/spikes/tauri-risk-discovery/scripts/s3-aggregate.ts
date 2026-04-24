// Aggregate per-option /tmp/s3-<OPT>-results.json files into the spec'd
// s3-query-latency.json (with environment + schema_version 1).

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { collectEnvironment } from './collect-environment.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(__dirname, '../benchmarks/s3-query-latency.json')

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

interface DumpedResult {
  runs: TestRun[]
}

interface OptionStatus {
  option: 'A' | 'B' | 'C'
  file: string
  status: 'ok' | 'missing' | 'failed'
  reason?: string
  runCount?: number
}

const OPTIONS: Array<{ option: 'A' | 'B' | 'C'; file: string }> = [
  { option: 'A', file: '/tmp/s3-A-results.json' },
  { option: 'B', file: '/tmp/s3-B-results.json' },
  { option: 'C', file: '/tmp/s3-C-results.json' },
]

async function main(): Promise<void> {
  const env = await collectEnvironment()
  const allRuns: TestRun[] = []
  const optionStatus: OptionStatus[] = []

  for (const cfg of OPTIONS) {
    if (!existsSync(cfg.file)) {
      optionStatus.push({
        option: cfg.option,
        file: cfg.file,
        status: 'missing',
        reason: 'file not found — bench did not run or did not dump',
      })
      continue
    }
    try {
      const raw = readFileSync(cfg.file, 'utf8')
      const dumped = JSON.parse(raw) as DumpedResult
      const runs = dumped.runs ?? []
      allRuns.push(...runs)
      optionStatus.push({
        option: cfg.option,
        file: cfg.file,
        status: 'ok',
        runCount: runs.length,
      })
    } catch (err) {
      optionStatus.push({
        option: cfg.option,
        file: cfg.file,
        status: 'failed',
        reason: String(err),
      })
    }
  }

  const output = {
    schema_version: 1,
    spike: 's3-db-placement',
    benchmark: 'query-latency',
    timestamp: new Date().toISOString(),
    environment: env,
    runs: allRuns,
    option_status: optionStatus,
    notes:
      'Bench tests run inside live Tauri runtime via auto-bench-on-mount in App.tsx. ' +
      'Each prototype writes /tmp/s3-<OPT>-results.json via bench_dump_results Tauri command. ' +
      'This script aggregates per-option dumps into a single spec-format file. ' +
      'Bundle size + Tests #7/#9/#10 measured separately or deferred — see findings.md.',
  }

  writeFileSync(OUT, JSON.stringify(output, null, 2))
  console.log(`[aggregate] wrote ${OUT}`)
  for (const s of optionStatus) {
    console.log(
      `  ${s.option}: ${s.status}${s.runCount !== undefined ? ` (${s.runCount} runs)` : ''}${s.reason ? ` — ${s.reason}` : ''}`,
    )
  }
}

main().catch((err) => {
  console.error('[aggregate] fatal:', err)
  process.exit(1)
})
