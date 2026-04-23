// Collects hardware/OS/tooling snapshot for reproducible benchmarks.
// Used by all bench-*.ts scripts to tag their output.

import { execSync } from 'node:child_process'
import { platform, arch, release } from 'node:os'
import { writeFileSync } from 'node:fs'

export interface Environment {
  timestamp: string
  os: { platform: string; arch: string; release: string; cpuModel: string | null }
  runtimes: {
    node: string
    rust: string | null
    cargo: string | null
    tauri_cli: string | null
  }
  libraries: {
    yjs: string | null
    yrs: string | null
    tauri_core: string | null
    blocknote_core: string | null
  }
}

function tryRun(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

function getCpuModel(): string | null {
  if (platform() === 'darwin') {
    return tryRun('sysctl -n machdep.cpu.brand_string')
  }
  if (platform() === 'linux') {
    return tryRun("awk -F: '/model name/ { print $2; exit }' /proc/cpuinfo")?.trim() ?? null
  }
  if (platform() === 'win32') {
    const out = tryRun('wmic cpu get Name /value')
    return out?.split('=')[1]?.trim() ?? null
  }
  return null
}

export async function collectEnvironment(): Promise<Environment> {
  return {
    timestamp: new Date().toISOString(),
    os: {
      platform: platform(),
      arch: arch(),
      release: release(),
      cpuModel: getCpuModel()
    },
    runtimes: {
      node: process.version,
      rust: tryRun('rustc --version'),
      cargo: tryRun('cargo --version'),
      tauri_cli: tryRun('cargo tauri --version') ?? tryRun('tauri --version')
    },
    libraries: {
      yjs:
        tryRun(
          `pnpm list yjs --depth 0 --json 2>/dev/null | grep '"version"' | head -1 | cut -d'"' -f4`
        ) ?? null,
      yrs: null,
      tauri_core: null,
      blocknote_core:
        tryRun(
          `pnpm list @blocknote/core --depth 0 --json 2>/dev/null | grep '"version"' | head -1 | cut -d'"' -f4`
        ) ?? null
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  collectEnvironment().then((env) => {
    const output = 'docs/spikes/tauri-risk-discovery/benchmarks/environment.json'
    writeFileSync(output, JSON.stringify(env, null, 2))
    console.log(`Environment snapshot written to ${output}`)
    console.log(JSON.stringify(env, null, 2))
  })
}
