import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  MEMORY_DEBUG_DEFAULT_PORT,
  type MemoryCaptureFile,
  type MemoryScenario,
  type MemorySnapshotRequest,
  type MemorySample
} from './memory-snapshot-types'
import type { MemoryControlClient } from './memory-control-client'

export interface MemorySnapshotOptions {
  scenario: MemoryScenario
  vaultPath: string
  label: string
  port: number
  outputDir: string
}

interface CaptureOptions extends MemorySnapshotRequest {
  client: MemoryControlClient
  vaultPath: string
  wait: (ms: number) => Promise<void>
}

const scenarios = new Set<MemoryScenario>(['boot', 'idle-60s'])
const vaultOpenSettleMs = 5_000

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

export function normalizeVaultPath(
  vaultPath: string,
  homeDir = os.homedir(),
  cwd = process.cwd()
): string {
  if (vaultPath === '~') return homeDir
  if (vaultPath.startsWith('~/')) {
    return path.resolve(homeDir, vaultPath.slice(2))
  }
  return path.resolve(cwd, vaultPath)
}

export function parseMemorySnapshotArgs(
  argv: string[],
  defaults: { outputDir?: string; port?: number; cwd?: string } = {}
): MemorySnapshotOptions {
  let scenario: MemoryScenario | null = null
  let vaultPath: string | null = null
  let label: string | null = null
  let port =
    defaults.port ?? Number(process.env.MEMRY_DEBUG_MEMORY_PORT ?? MEMORY_DEBUG_DEFAULT_PORT)
  let outputDir = defaults.outputDir ?? path.join('tmp', 'memory')
  const cwd = defaults.cwd ?? process.cwd()

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    switch (arg) {
      case '--scenario': {
        const value = requireValue(argv, i, arg)
        if (!scenarios.has(value as MemoryScenario)) {
          throw new Error('--scenario must be boot or idle-60s')
        }
        scenario = value as MemoryScenario
        i += 1
        break
      }
      case '--vault':
        vaultPath = normalizeVaultPath(requireValue(argv, i, arg), os.homedir(), cwd)
        i += 1
        break
      case '--label':
        label = requireValue(argv, i, arg)
        i += 1
        break
      case '--port':
        port = Number(requireValue(argv, i, arg))
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
          throw new Error('--port must be a valid TCP port')
        }
        i += 1
        break
      case '--output-dir':
        outputDir = path.resolve(cwd, requireValue(argv, i, arg))
        i += 1
        break
      case '--help':
        throw new Error('help')
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!scenario) throw new Error('--scenario is required')
  if (!vaultPath) throw new Error('--vault is required')
  if (!label) throw new Error('--label is required')

  return { scenario, vaultPath, label, port, outputDir }
}

function samePath(a: string | null, b: string): boolean {
  return a !== null && path.resolve(a) === path.resolve(b)
}

export async function captureMemorySamples(options: CaptureOptions): Promise<MemoryCaptureFile> {
  await options.client.openVault(options.vaultPath)

  const activeVaultPath = await options.client.getVaultPath()
  if (!samePath(activeVaultPath, options.vaultPath)) {
    throw new Error(
      `Active vault mismatch: expected ${options.vaultPath}, got ${activeVaultPath ?? 'none'}`
    )
  }
  await options.wait(vaultOpenSettleMs)

  const samples: MemorySample[] = []
  const capture = async (phase: MemorySample['phase']): Promise<void> => {
    samples.push({
      phase,
      snapshot: await options.client.captureSnapshot({
        scenario: options.scenario,
        label: options.label,
        branch: options.branch
      })
    })
  }

  await capture('T0')
  if (options.scenario === 'idle-60s') {
    await options.wait(60_000)
  }
  await capture('T1')
  await options.wait(60_000)
  await capture('T2')

  const capturedAt = samples[0]?.snapshot.metadata.capturedAt ?? new Date().toISOString()
  const hostname = samples[0]?.snapshot.metadata.hostname ?? os.hostname()

  return {
    version: 1,
    scenario: options.scenario,
    label: options.label,
    branch: options.branch,
    vaultPath: options.vaultPath,
    hostname,
    capturedAt,
    samples
  }
}

export function getCurrentGitBranch(cwd = process.cwd()): string {
  try {
    return execFileSync('git', ['branch', '--show-current'], {
      cwd,
      encoding: 'utf-8'
    }).trim()
  } catch {
    return 'unknown'
  }
}

export async function writeMemoryCaptureFile(
  capture: MemoryCaptureFile,
  outputDir: string
): Promise<string> {
  const stamp = capture.capturedAt.replace(/[:.]/g, '-')
  const fileName = `${capture.label}-${capture.scenario}-${stamp}.json`
  const outputPath = path.resolve(outputDir, fileName)
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(capture, null, 2)}\n`, 'utf-8')
  return outputPath
}
