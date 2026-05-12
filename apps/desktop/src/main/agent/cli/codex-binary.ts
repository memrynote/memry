import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { platform } from 'node:os'

import type { BinaryStatus } from '@memry/contracts/ipc-agent'

export const MIN_CODEX_VERSION = '0.130.0'

const INSTALL_HINT = 'Install Codex CLI, then run `codex login` to sign in to your OpenAI account.'

function locate(): string | null {
  const which = platform() === 'win32' ? 'where' : 'which'
  const result = spawnSync(which, ['codex'])
  if (result.status !== 0) {
    return null
  }

  const binaryPath = result.stdout.toString().split(/\r?\n/).filter(Boolean)[0]
  if (!binaryPath || !existsSync(binaryPath)) {
    return null
  }

  return binaryPath
}

function readVersion(binaryPath: string): string | null {
  const result = spawnSync(binaryPath, ['--version'], { encoding: 'utf8' })
  if (result.status !== 0) {
    return null
  }

  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const match = output.match(/(\d+\.\d+\.\d+)/)
  return match ? match[1] : null
}

function compareSemver(a: string, b: string): number {
  const parts = (version: string): number[] =>
    version.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const [majorA, minorA, patchA] = parts(a)
  const [majorB, minorB, patchB] = parts(b)

  if (majorA !== majorB) {
    return majorA - majorB
  }
  if (minorA !== minorB) {
    return minorA - minorB
  }
  return patchA - patchB
}

export async function detectCodexBinary(): Promise<BinaryStatus> {
  const binaryPath = locate()
  if (!binaryPath) {
    return {
      detected: false,
      version: null,
      meetsMinimum: false,
      minimumRequired: MIN_CODEX_VERSION,
      installHint: INSTALL_HINT
    }
  }

  const version = readVersion(binaryPath)
  if (!version) {
    return {
      detected: true,
      version: null,
      meetsMinimum: false,
      minimumRequired: MIN_CODEX_VERSION,
      installHint: INSTALL_HINT
    }
  }

  const meetsMinimum = compareSemver(version, MIN_CODEX_VERSION) >= 0
  return {
    detected: true,
    version,
    meetsMinimum,
    minimumRequired: MIN_CODEX_VERSION,
    installHint: meetsMinimum ? null : INSTALL_HINT
  }
}
