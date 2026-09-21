import type { BinaryStatus } from '@memry/contracts/ipc-agent'

import { cacheBinaryDetection, locateBinary, runBinaryCommand } from './binary-detection'

/**
 * 1.2.7 is the floor Memry is built against: it is the first release where the
 * MCP config lives at `config/mcp_config.json` (older builds also wrote the
 * legacy path and disagreed with themselves about which one they read), where
 * `url`/`headers` HTTP servers are supported, and where a headless `-p` run has
 * no 5-minute timeout.
 */
export const MIN_AGY_VERSION = '1.2.7'

const INSTALL_HINT =
  'Install Antigravity CLI (agy) from https://antigravity.google/docs/cli, then run `agy` once to sign in to your Google account.'

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

async function probeAgyBinary(): Promise<BinaryStatus> {
  const binaryPath = await locateBinary('agy')
  if (!binaryPath) {
    return {
      detected: false,
      version: null,
      meetsMinimum: false,
      minimumRequired: MIN_AGY_VERSION,
      installHint: INSTALL_HINT
    }
  }

  const version = await readVersion(binaryPath)
  if (!version) {
    return {
      detected: true,
      version: null,
      meetsMinimum: false,
      minimumRequired: MIN_AGY_VERSION,
      installHint: INSTALL_HINT
    }
  }

  const meetsMinimum = compareSemver(version, MIN_AGY_VERSION) >= 0
  return {
    detected: true,
    version,
    meetsMinimum,
    minimumRequired: MIN_AGY_VERSION,
    installHint: meetsMinimum ? null : INSTALL_HINT
  }
}

export const detectAgyBinary: () => Promise<BinaryStatus> = cacheBinaryDetection(probeAgyBinary)
