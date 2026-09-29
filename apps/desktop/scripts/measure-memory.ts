/**
 * Idle memory harness for the desktop app.
 *
 * Launches the built app (`out/main/index.js`) the same way E2E does — isolated
 * temp user-data dir, a seeded temp vault opened through TEST_VAULT_PATH — waits
 * for the vault to open and the background index build to settle, idles, then
 * samples memory per process. Scenarios are interleaved so drift between runs
 * (thermal, page cache) does not bias one scenario.
 *
 *   home  the default tab session a fresh vault restores (home)
 *   note  one seeded note opened in the editor
 *
 * Usage (build first; this script never builds):
 *   pnpm --filter @memry/desktop exec electron-vite build
 *   pnpm --filter @memry/desktop measure:memory -- --out=/tmp/memry-mem/baseline.json
 *
 * Flags: --runs=3 --idle=20 --notes=120 --seed=42 --scenarios=home,note --out=<path>
 *
 * Units: every *KB field is kibibytes as reported by Electron/ps; the table is MiB.
 * workingSetSize comes from app.getAppMetrics(); rssKB from `ps` (darwin/linux)
 * as a cross-check. privateBytes is only reported on Windows.
 */

import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'

import { writeNoteFiles } from './seed-vault/file-writer'
import { generateBulkVault } from './seed-data/bulk-notes'
import {
  destroyLaunchedElectron,
  launchElectronWithWindow
} from '../tests/e2e/utils/electron-lifecycle'
import {
  dismissFirstRunOnboarding,
  SELECTORS,
  waitForVaultReady
} from '../tests/e2e/utils/electron-helpers'

type ScenarioName = 'home' | 'note'

interface CliArgs {
  runs: number
  idleSeconds: number
  notes: number
  seed: number
  scenarios: ScenarioName[]
  out: string | null
}

interface ProcessSample {
  label: string
  pid: number
  type: string
  name: string | null
  workingSetKB: number
  peakWorkingSetKB: number
  privateKB: number | null
  rssKB: number | null
}

interface MainSample {
  memoryUsage: NodeJS.MemoryUsage
  processMemoryInfo: { residentSet?: number; private: number; shared: number }
}

interface RendererSample {
  jsHeapUsedBytes: number | null
  jsHeapTotalBytes: number | null
  domNodes: number | null
  documents: number | null
  jsEventListeners: number | null
  performanceMemory: { usedJSHeapSize: number; totalJSHeapSize: number } | null
}

interface RunSample {
  scenario: ScenarioName
  run: number
  activeTab: string | null
  settleMs: number
  processes: ProcessSample[]
  totals: { workingSetKB: number; rssKB: number | null }
  main: MainSample
  renderer: RendererSample
}

const SCENARIOS: readonly ScenarioName[] = ['home', 'note']
const VAULT_READY_MS = 90_000
const INDEX_SETTLE_MS = 180_000
const NOTE_OPEN_MS = 30_000

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    runs: 3,
    idleSeconds: 20,
    notes: 120,
    seed: 42,
    scenarios: [...SCENARIOS],
    out: null
  }
  for (const raw of argv) {
    const [flag, value] = raw.replace(/^--/, '').split('=')
    if (value === undefined) continue
    if (flag === 'runs') args.runs = Number(value)
    else if (flag === 'idle') args.idleSeconds = Number(value)
    else if (flag === 'notes') args.notes = Number(value)
    else if (flag === 'seed') args.seed = Number(value)
    else if (flag === 'out') args.out = path.resolve(value)
    else if (flag === 'scenarios') {
      args.scenarios = value.split(',').map((name) => {
        if (!SCENARIOS.includes(name as ScenarioName)) throw new Error(`unknown scenario: ${name}`)
        return name as ScenarioName
      })
    }
  }
  for (const key of ['runs', 'idleSeconds', 'notes'] as const) {
    if (!Number.isInteger(args[key]) || args[key] < 1) {
      throw new Error(`--${key} must be a positive integer`)
    }
  }
  return args
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function medianOrNull(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => typeof v === 'number')
  return present.length > 0 ? median(present) : null
}

function seedVault(noteCount: number, seed: number): { vaultPath: string; noteTitle: string } {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-mem-vault-'))
  // Same skeleton the E2E fixture creates before launch.
  fs.mkdirSync(path.join(vaultPath, '.memry'), { recursive: true })
  fs.mkdirSync(path.join(vaultPath, 'notes'), { recursive: true })
  fs.mkdirSync(path.join(vaultPath, 'journal'), { recursive: true })
  const vault = generateBulkVault(noteCount, seed)
  writeNoteFiles(
    vaultPath,
    vault.notes.map((note) => note.file)
  )
  return { vaultPath, noteTitle: vault.notes[0].title }
}

/** RSS in KiB per pid via `ps`. Empty on Windows or if ps fails. */
function readRssKB(pids: number[]): Map<number, number> {
  const rss = new Map<number, number>()
  if (process.platform === 'win32' || pids.length === 0) return rss
  const result = spawnSync('ps', ['-o', 'pid=,rss=', '-p', pids.join(',')], { encoding: 'utf8' })
  if (result.status !== 0 || !result.stdout) return rss
  for (const line of result.stdout.trim().split('\n')) {
    const [pid, kb] = line.trim().split(/\s+/).map(Number)
    if (Number.isFinite(pid) && Number.isFinite(kb)) rss.set(pid, kb)
  }
  return rss
}

async function waitForIndexSettled(page: Page): Promise<number> {
  const startedAt = Date.now()
  await page.waitForFunction(
    async () => {
      const status = await window.api.vault.getStatus()
      return status?.isOpen === true && status.isIndexing === false
    },
    undefined,
    { timeout: INDEX_SETTLE_MS, polling: 500 }
  )
  return Date.now() - startedAt
}

async function openNote(page: Page, title: string): Promise<void> {
  const handle = await page.evaluate(async (t) => {
    const match = await window.api.notes.resolveByTitle(t)
    return match ? { id: match.id, title: match.title, emoji: null } : null
  }, title)
  if (!handle) throw new Error(`seeded note not indexed: "${title}"`)

  // The renderer's test-only 'memry:test-open-note' listener (App.tsx) mounts
  // with AppContent; re-dispatch until the tab exists (OPEN_TAB dedupes by id).
  const tab = page.locator(SELECTORS.tab).filter({ hasText: handle.title }).first()
  const deadline = Date.now() + NOTE_OPEN_MS
  while (!(await tab.isVisible().catch(() => false))) {
    if (Date.now() > deadline) throw new Error(`note tab never opened: "${title}"`)
    await page.evaluate((detail) => {
      window.dispatchEvent(new CustomEvent('memry:test-open-note', { detail }))
    }, handle)
    await sleep(500)
  }
  await tab.click()
  await page
    .locator(SELECTORS.noteEditor)
    .first()
    .waitFor({ state: 'visible', timeout: NOTE_OPEN_MS })
}

async function sampleProcesses(app: ElectronApplication): Promise<{
  processes: ProcessSample[]
  main: MainSample
}> {
  const raw = await app.evaluate(async ({ app: electronApp, webContents }) => {
    const urlByPid = new Map<number, string>()
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed()) continue
      const url = wc.getURL()
      const page = url.split('#')[0].split('?')[0].split('/').pop() || wc.getType()
      const pid = wc.getOSProcessId()
      urlByPid.set(pid, urlByPid.has(pid) ? `${urlByPid.get(pid)}+${page}` : page)
    }
    return {
      metrics: electronApp.getAppMetrics().map((metric) => ({
        pid: metric.pid,
        type: metric.type,
        name: metric.name ?? metric.serviceName ?? urlByPid.get(metric.pid) ?? null,
        workingSetKB: metric.memory.workingSetSize,
        peakWorkingSetKB: metric.memory.peakWorkingSetSize,
        privateKB: metric.memory.privateBytes ?? null
      })),
      memoryUsage: process.memoryUsage(),
      processMemoryInfo: await process.getProcessMemoryInfo()
    }
  })

  const rss = readRssKB(raw.metrics.map((m) => m.pid))
  const seen = new Map<string, number>()
  const processes = raw.metrics
    .map((metric) => {
      const base =
        metric.type === 'Browser' ? 'Main' : `${metric.type}${metric.name ? `:${metric.name}` : ''}`
      const count = (seen.get(base) ?? 0) + 1
      seen.set(base, count)
      return {
        label: count === 1 ? base : `${base}#${count}`,
        ...metric,
        rssKB: rss.get(metric.pid) ?? null
      }
    })
    .sort((a, b) => b.workingSetKB - a.workingSetKB)
  return {
    processes,
    main: { memoryUsage: raw.memoryUsage, processMemoryInfo: raw.processMemoryInfo }
  }
}

async function sampleRenderer(page: Page): Promise<RendererSample> {
  const sample: RendererSample = {
    jsHeapUsedBytes: null,
    jsHeapTotalBytes: null,
    domNodes: null,
    documents: null,
    jsEventListeners: null,
    performanceMemory: null
  }
  try {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable')
    const { metrics } = await cdp.send('Performance.getMetrics')
    const byName = new Map(metrics.map((m) => [m.name, m.value]))
    sample.jsHeapUsedBytes = byName.get('JSHeapUsedSize') ?? null
    sample.jsHeapTotalBytes = byName.get('JSHeapTotalSize') ?? null
    sample.domNodes = byName.get('Nodes') ?? null
    sample.documents = byName.get('Documents') ?? null
    sample.jsEventListeners = byName.get('JSEventListeners') ?? null
    await cdp.detach()
  } catch (error) {
    console.warn(`CDP Performance.getMetrics unavailable: ${String(error)}`)
  }
  sample.performanceMemory = await page
    .evaluate(() => {
      const memory = (
        performance as Performance & {
          memory?: { usedJSHeapSize: number; totalJSHeapSize: number }
        }
      ).memory
      return memory
        ? { usedJSHeapSize: memory.usedJSHeapSize, totalJSHeapSize: memory.totalJSHeapSize }
        : null
    })
    .catch(() => null)
  return sample
}

async function runOnce(scenario: ScenarioName, run: number, args: CliArgs): Promise<RunSample> {
  const { vaultPath, noteTitle } = seedVault(args.notes, args.seed)
  const launched = await launchElectronWithWindow({ testVaultPath: vaultPath })
  try {
    const { app, page } = launched
    await waitForVaultReady(page, VAULT_READY_MS)
    const settleMs = await waitForIndexSettled(page)
    if (scenario === 'note') await openNote(page, noteTitle)
    await dismissFirstRunOnboarding(page)

    await sleep(args.idleSeconds * 1000)

    const activeTab = await page
      .locator(SELECTORS.activeTab)
      .first()
      .innerText({ timeout: 2000 })
      .then((text) => text.trim() || null)
      .catch(() => null)
    const { processes, main } = await sampleProcesses(app)
    const renderer = await sampleRenderer(page)
    const rssValues = processes.map((p) => p.rssKB)
    return {
      scenario,
      run,
      activeTab,
      settleMs,
      processes,
      totals: {
        workingSetKB: processes.reduce((sum, p) => sum + p.workingSetKB, 0),
        rssKB: rssValues.every((v) => v !== null)
          ? rssValues.reduce<number>((sum, v) => sum + (v ?? 0), 0)
          : null
      },
      main,
      renderer
    }
  } finally {
    await destroyLaunchedElectron(launched)
    fs.rmSync(vaultPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

function summarize(samples: RunSample[]) {
  const labels = [...new Set(samples.flatMap((s) => s.processes.map((p) => p.label)))]
  const processes = labels.map((label) => {
    const hits = samples.flatMap((s) => s.processes.filter((p) => p.label === label))
    return {
      label,
      presentInRuns: hits.length,
      workingSetKB: median(hits.map((p) => p.workingSetKB)),
      peakWorkingSetKB: median(hits.map((p) => p.peakWorkingSetKB)),
      privateKB: medianOrNull(hits.map((p) => p.privateKB)),
      rssKB: medianOrNull(hits.map((p) => p.rssKB))
    }
  })
  const mainUsage = (key: keyof NodeJS.MemoryUsage): number =>
    median(samples.map((s) => s.main.memoryUsage[key]))
  return {
    processes: processes.sort((a, b) => b.workingSetKB - a.workingSetKB),
    totals: {
      workingSetKB: median(samples.map((s) => s.totals.workingSetKB)),
      rssKB: medianOrNull(samples.map((s) => s.totals.rssKB))
    },
    main: {
      rss: mainUsage('rss'),
      heapUsed: mainUsage('heapUsed'),
      heapTotal: mainUsage('heapTotal'),
      external: mainUsage('external'),
      arrayBuffers: mainUsage('arrayBuffers'),
      privateKB: median(samples.map((s) => s.main.processMemoryInfo.private))
    },
    renderer: {
      jsHeapUsedBytes: medianOrNull(samples.map((s) => s.renderer.jsHeapUsedBytes)),
      jsHeapTotalBytes: medianOrNull(samples.map((s) => s.renderer.jsHeapTotalBytes)),
      domNodes: medianOrNull(samples.map((s) => s.renderer.domNodes)),
      jsEventListeners: medianOrNull(samples.map((s) => s.renderer.jsEventListeners))
    },
    activeTabs: samples.map((s) => s.activeTab),
    settleMs: samples.map((s) => s.settleMs)
  }
}

const mib = (kb: number | null): string => (kb === null ? '-' : (kb / 1024).toFixed(1))
const mibBytes = (bytes: number | null): string =>
  bytes === null ? '-' : (bytes / 1024 / 1024).toFixed(1)

function printTable(scenario: string, s: ReturnType<typeof summarize>): void {
  const rows = [
    ['process', 'runs', 'ws MiB', 'peak MiB', 'rss MiB'],
    ...s.processes.map((p) => [
      p.label,
      String(p.presentInRuns),
      mib(p.workingSetKB),
      mib(p.peakWorkingSetKB),
      mib(p.rssKB)
    ]),
    ['TOTAL', '', mib(s.totals.workingSetKB), '', mib(s.totals.rssKB)]
  ]
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col].length)))
  console.log(`\n== ${scenario} (median; active tab: ${s.activeTabs.join(' | ')}) ==`)
  for (const row of rows) {
    console.log(
      row
        .map((cell, col) => (col === 0 ? cell.padEnd(widths[col]) : cell.padStart(widths[col])))
        .join('  ')
    )
  }
  console.log(
    `main process.memoryUsage MiB: rss ${mibBytes(s.main.rss)}, heapUsed ${mibBytes(s.main.heapUsed)}, ` +
      `heapTotal ${mibBytes(s.main.heapTotal)}, external ${mibBytes(s.main.external)}, ` +
      `arrayBuffers ${mibBytes(s.main.arrayBuffers)}`
  )
  console.log(
    `renderer JS heap MiB: used ${mibBytes(s.renderer.jsHeapUsedBytes)}, ` +
      `total ${mibBytes(s.renderer.jsHeapTotalBytes)}; DOM nodes ${s.renderer.domNodes ?? '-'}`
  )
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const mainEntry = path.join(__dirname, '..', 'out', 'main', 'index.js')
  if (!fs.existsSync(mainEntry)) {
    throw new Error(
      `${mainEntry} missing: run \`pnpm --filter @memry/desktop exec electron-vite build\``
    )
  }

  const samples: Record<ScenarioName, RunSample[]> = { home: [], note: [] }
  for (let run = 1; run <= args.runs; run++) {
    for (const scenario of args.scenarios) {
      console.log(`[measure-memory] ${scenario} run ${run}/${args.runs}...`)
      const sample = await runOnce(scenario, run, args)
      console.log(
        `[measure-memory]   total ws ${mib(sample.totals.workingSetKB)} MiB, ` +
          `index settled in ${sample.settleMs} ms, active tab: ${sample.activeTab ?? '?'}`
      )
      samples[scenario].push(sample)
    }
  }

  const git = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' })
  const report = {
    meta: {
      measuredAt: new Date().toISOString(),
      gitHead: git.status === 0 ? git.stdout.trim() : null,
      mainEntryBuiltAt: fs.statSync(mainEntry).mtime.toISOString(),
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      totalMemMiB: Math.round(os.totalmem() / 1024 / 1024),
      runs: args.runs,
      idleSeconds: args.idleSeconds,
      notes: args.notes,
      seed: args.seed
    },
    scenarios: Object.fromEntries(
      args.scenarios.map((scenario) => [
        scenario,
        { median: summarize(samples[scenario]), runs: samples[scenario] }
      ])
    )
  }

  const json = JSON.stringify(report, null, 2)
  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true })
    fs.writeFileSync(args.out, json + '\n', 'utf8')
    console.log(`\n[measure-memory] wrote ${args.out}`)
  } else {
    console.log(json)
  }
  for (const scenario of args.scenarios) {
    printTable(scenario, report.scenarios[scenario].median)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
