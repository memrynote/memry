import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { BrowserWindow } from 'electron'
import { getStatus } from '../vault'
import type {
  DebugMemorySnapshot,
  MemorySnapshotRequest,
  ProcessMemorySnapshot,
  RendererMemorySnapshot,
  WorkerMemorySnapshot
} from './memory-snapshot-types'

const execFileAsync = promisify(execFile)

const rendererMemoryScript = `
(async () => {
  const memory = performance.memory || {}
  let specific

  if (typeof performance.measureUserAgentSpecificMemory === 'function') {
    try {
      const measured = await performance.measureUserAgentSpecificMemory()
      specific = {
        bytes: Number(measured?.bytes ?? 0),
        breakdown: Array.isArray(measured?.breakdown)
          ? measured.breakdown.map((entry) => ({
              bytes: Number(entry?.bytes ?? 0),
              types: Array.isArray(entry?.types) ? entry.types.map(String) : undefined,
              attribution: Array.isArray(entry?.attribution)
                ? entry.attribution.map((item) => ({
                    url: typeof item?.url === 'string' ? item.url : undefined,
                    scope: typeof item?.scope === 'string' ? item.scope : undefined
                  }))
                : undefined
            }))
          : undefined
      }
    } catch {
      specific = undefined
    }
  }

  const numberOrNull = (value) => Number.isFinite(value) ? Number(value) : null

  return {
    jsHeapSizeLimit: numberOrNull(memory.jsHeapSizeLimit),
    totalJSHeapSize: numberOrNull(memory.totalJSHeapSize),
    usedJSHeapSize: numberOrNull(memory.usedJSHeapSize),
    measureUserAgentSpecificMemory: specific
  }
})()
`

export function isMemoryDebugEnabled(): boolean {
  return process.env.MEMRY_DEBUG_MEMORY === '1'
}

function collectMainMemory(): ProcessMemorySnapshot {
  const usage = process.memoryUsage()
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers
  }
}

function findRendererWindow(): Electron.BrowserWindow {
  const window = BrowserWindow.getAllWindows().find((candidate) => {
    if (candidate.isDestroyed()) return false
    return !candidate.webContents.isDestroyed()
  })

  if (!window) {
    throw new Error('No active renderer window is available for memory snapshot')
  }

  return window
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

async function collectRendererMemory(): Promise<RendererMemorySnapshot> {
  const window = findRendererWindow()
  const result = (await window.webContents.executeJavaScript(
    rendererMemoryScript,
    true
  )) as RendererMemorySnapshot

  return {
    jsHeapSizeLimit: numberOrNull(result.jsHeapSizeLimit),
    totalJSHeapSize: numberOrNull(result.totalJSHeapSize),
    usedJSHeapSize: numberOrNull(result.usedJSHeapSize),
    measureUserAgentSpecificMemory: result.measureUserAgentSpecificMemory
  }
}

function parsePsOutput(stdout: string): WorkerMemorySnapshot[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
      if (!match) return []

      const [, ppid, pid, rssKiB, command] = match
      if (Number(ppid) !== process.pid) return []

      return [
        {
          name: `${path.basename(command)}:${pid}`,
          rss: Number(rssKiB) * 1024
        }
      ]
    })
}

async function collectWorkerMemory(): Promise<WorkerMemorySnapshot[]> {
  if (process.platform === 'win32') return []

  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'ppid=,pid=,rss=,comm='])
    return parsePsOutput(stdout)
  } catch {
    return []
  }
}

export async function captureDebugMemorySnapshot(
  request: MemorySnapshotRequest
): Promise<DebugMemorySnapshot> {
  if (!isMemoryDebugEnabled()) {
    throw new Error('Memory snapshot debug harness requires MEMRY_DEBUG_MEMORY=1')
  }

  const capturedAt = new Date().toISOString()
  const vaultPath = getStatus().path ?? null

  return {
    timestamp: capturedAt,
    main: collectMainMemory(),
    renderer: await collectRendererMemory(),
    workers: await collectWorkerMemory(),
    metadata: {
      vaultPath,
      scenario: request.scenario,
      branch: request.branch,
      label: request.label,
      hostname: os.hostname(),
      capturedAt
    }
  }
}
