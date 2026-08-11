import type { BinaryStatus } from '@memry/contracts/ipc-agent'

import { cacheBinaryDetection, locateBinary, runBinaryCommand } from './binary-detection'

export const MIN_CODEX_VERSION = '0.130.0'

const INSTALL_HINT = 'Install Codex CLI, then run `codex login` to sign in to your OpenAI account.'

async function readVersion(binaryPath: string): Promise<string | null> {
  const result = await runBinaryCommand(binaryPath, ['--version'])
  if (!result) {
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

async function probeCodexBinary(): Promise<BinaryStatus> {
  const binaryPath = await locateBinary('codex')
  if (!binaryPath) {
    return {
      detected: false,
      version: null,
      meetsMinimum: false,
      minimumRequired: MIN_CODEX_VERSION,
      installHint: INSTALL_HINT
    }
  }

  const version = await readVersion(binaryPath)
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

export const detectCodexBinary: () => Promise<BinaryStatus> = cacheBinaryDetection(probeCodexBinary)
