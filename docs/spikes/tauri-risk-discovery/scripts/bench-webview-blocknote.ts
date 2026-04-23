// S1 benchmark runner. Orchestrates Playwright tests + collects results
// into ../benchmarks/s1-feature-matrix.csv. Manual tests (IME, paste HTML,
// resize, sigma) are marked "manual-pending" and completed via checklist.

import { execSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectEnvironment } from './collect-environment'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_DIR = resolve(__dirname, '../../../../spikes/tauri-risk-discovery/app')
const OUT_CSV = resolve(__dirname, '../benchmarks/s1-feature-matrix.csv')
const PLAYWRIGHT_JSON = resolve(APP_DIR, 'playwright-report/results.json')

interface TestResult {
  id: number
  name: string
  platform: 'macOS' | 'Windows'
  method: 'playwright' | 'manual'
  status: 'pass' | 'fail' | 'skipped' | 'manual-pending'
  notes: string
  evidence?: string
}

const TESTS: Omit<TestResult, 'status' | 'notes' | 'evidence'>[] = [
  { id: 1, name: 'ASCII typing', platform: 'macOS', method: 'playwright' },
  { id: 2, name: 'Turkish typing', platform: 'macOS', method: 'playwright' },
  { id: 3, name: 'IME Japanese input', platform: 'macOS', method: 'manual' },
  { id: 4, name: 'Paste plain text 500 char', platform: 'macOS', method: 'playwright' },
  { id: 5, name: 'Paste rich HTML', platform: 'macOS', method: 'manual' },
  { id: 6, name: 'Paste image clipboard', platform: 'macOS', method: 'playwright' },
  { id: 7, name: 'Drag-drop image file', platform: 'macOS', method: 'playwright' },
  { id: 8, name: 'Slash menu', platform: 'macOS', method: 'playwright' },
  { id: 9, name: 'Undo/redo 10-op chain', platform: 'macOS', method: 'playwright' },
  { id: 10, name: 'Table editing', platform: 'macOS', method: 'playwright' },
  { id: 11, name: 'Code block syntax highlight', platform: 'macOS', method: 'playwright' },
  { id: 12, name: 'Link insertion', platform: 'macOS', method: 'playwright' },
  { id: 13, name: 'Large doc stress 10k char', platform: 'macOS', method: 'playwright' },
  { id: 14, name: 'Window resize mid-typing', platform: 'macOS', method: 'manual' },
  { id: 15, name: '@react-sigma graph smoke', platform: 'macOS', method: 'manual' },
  // Windows smoke subset (not executed in Phase 1 — placeholders)
  { id: 1, name: 'ASCII typing', platform: 'Windows', method: 'playwright' },
  { id: 4, name: 'Paste plain text 500 char', platform: 'Windows', method: 'playwright' },
  { id: 5, name: 'Paste rich HTML', platform: 'Windows', method: 'manual' },
  { id: 8, name: 'Slash menu', platform: 'Windows', method: 'playwright' },
  { id: 9, name: 'Undo/redo 10-op chain', platform: 'Windows', method: 'playwright' }
]

function runPlaywright(): void {
  try {
    execSync('pnpm exec playwright test --reporter=json', {
      cwd: APP_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8'
    })
  } catch (e) {
    // Playwright exits non-zero on any failure — that's fine, we parse the report anyway.
    console.warn('[bench] Playwright reported failures. Parsing results.json...')
  }
}

function parsePlaywrightResults(): Record<number, { status: 'pass' | 'fail'; notes: string }> {
  const results: Record<number, { status: 'pass' | 'fail'; notes: string }> = {}
  if (!existsSync(PLAYWRIGHT_JSON)) {
    console.warn(`[bench] No playwright results at ${PLAYWRIGHT_JSON}`)
    return results
  }
  const report = JSON.parse(readFileSync(PLAYWRIGHT_JSON, 'utf8'))
  const walkSuites = (suites: any[]): void => {
    for (const suite of suites ?? []) {
      for (const spec of suite.specs ?? []) {
        const idMatch = spec.title.match(/test-(\d+)-/)
        if (idMatch) {
          const id = parseInt(idMatch[1], 10)
          const testRun = spec.tests?.[0]?.results?.[0]
          const status = testRun?.status === 'passed' ? 'pass' : 'fail'
          const errorMessage = testRun?.error?.message ?? ''
          results[id] = { status, notes: errorMessage.replace(/\n/g, ' ').slice(0, 200) }
        }
      }
      if (suite.suites) walkSuites(suite.suites)
    }
  }
  walkSuites(report.suites ?? [])
  return results
}

function csvEscape(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

async function main(): Promise<void> {
  const env = await collectEnvironment()
  console.log('[bench] Environment:', JSON.stringify(env.os))
  console.log('[bench] Node:', env.runtimes.node, 'BlockNote:', env.libraries.blocknote_core)

  console.log('[bench] Running macOS Playwright tests...')
  runPlaywright()
  const macResults = parsePlaywrightResults()

  const rows: TestResult[] = TESTS.map((test) => {
    if (test.method === 'manual') {
      return { ...test, status: 'manual-pending', notes: 'See benchmarks/s1-manual-checklist.md' }
    }
    if (test.platform === 'Windows') {
      return { ...test, status: 'skipped', notes: 'Windows smoke is Phase 4 — not yet executed' }
    }
    const pw = macResults[test.id]
    return pw
      ? { ...test, status: pw.status, notes: pw.notes }
      : { ...test, status: 'skipped', notes: 'no playwright result parsed' }
  })

  const header = 'id,name,platform,method,status,notes,evidence'
  const csvLines = [header]
  for (const r of rows) {
    csvLines.push(
      [
        r.id,
        csvEscape(r.name),
        r.platform,
        r.method,
        r.status,
        csvEscape(r.notes),
        r.evidence ?? ''
      ].join(',')
    )
  }
  writeFileSync(OUT_CSV, csvLines.join('\n') + '\n')
  console.log(`[bench] CSV written to ${OUT_CSV}`)

  const manualPending = rows.filter((r) => r.status === 'manual-pending').length
  const passed = rows.filter((r) => r.status === 'pass').length
  const failed = rows.filter((r) => r.status === 'fail').length
  const skipped = rows.filter((r) => r.status === 'skipped').length
  console.log(
    `[bench] Summary: pass=${passed} fail=${failed} manual-pending=${manualPending} skipped=${skipped}`
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
