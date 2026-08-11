import type { BinaryStatus } from '@memry/contracts/ipc-agent'

import { cacheBinaryDetection, locateBinary, runBinaryCommand } from './binary-detection'

export const MIN_CLAUDE_VERSION = '2.1.0'

const INSTALL_HINT =
  'Install Claude Code CLI from https://claude.ai/code, then run `claude login` to sign in to your subscription.'

async function readVersion(binaryPath: string): Promise<string | null> {
  const result = await runBinaryCommand(binaryPath, ['--version'])
  if (!result) {
    return null
  }

  const match = result.stdout.match(/(\d+\.\d+\.\d+)/)
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

async function probeClaudeBinary(): Promise<BinaryStatus> {
  const binaryPath = await locateBinary('claude')
  if (!binaryPath) {
    return {
      detected: false,
      version: null,
      meetsMinimum: false,
      minimumRequired: MIN_CLAUDE_VERSION,
      installHint: INSTALL_HINT
    }
  }

  const version = await readVersion(binaryPath)
  if (!version) {
    return {
      detected: true,
      version: null,
      meetsMinimum: false,
      minimumRequired: MIN_CLAUDE_VERSION,
      installHint: INSTALL_HINT
    }
  }

  const meetsMinimum = compareSemver(version, MIN_CLAUDE_VERSION) >= 0
  return {
    detected: true,
    version,
    meetsMinimum,
    minimumRequired: MIN_CLAUDE_VERSION,
    installHint: meetsMinimum ? null : INSTALL_HINT
  }
}

export const detectClaudeBinary: () => Promise<BinaryStatus> =
  cacheBinaryDetection(probeClaudeBinary)
