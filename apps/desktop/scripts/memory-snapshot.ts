import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMemoryControlClient } from '../src/main/debug/memory-control-client'
import {
  captureMemorySamples,
  getCurrentGitBranch,
  parseMemorySnapshotArgs,
  writeMemoryCaptureFile
} from '../src/main/debug/memory-snapshot-cli'

function printHelp(): void {
  console.log(`Usage: pnpm memory:snapshot --scenario <boot|idle-60s> --vault <path> --label <name>

Options:
  --scenario <name>    Scenario to capture. Currently boot or idle-60s.
  --vault <path>       Vault that must be active before capture.
  --label <name>       Snapshot label, for example feat or main-baseline.
  --port <port>        Memory control port, default MEMRY_DEBUG_MEMORY_PORT or 17345.
  --output-dir <path>  Output directory, default tmp/memory at repo root.
`)
}

async function main(): Promise<void> {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const repoRoot = path.resolve(scriptDir, '../../..')
  const invocationCwd = process.env.INIT_CWD ?? repoRoot

  let options
  try {
    options = parseMemorySnapshotArgs(process.argv.slice(2), {
      outputDir: path.join(repoRoot, 'tmp', 'memory'),
      cwd: invocationCwd
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'help') {
      printHelp()
      return
    }
    throw error
  }

  const capture = await captureMemorySamples({
    client: createMemoryControlClient(options.port),
    scenario: options.scenario,
    vaultPath: options.vaultPath,
    label: options.label,
    branch: getCurrentGitBranch(repoRoot),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  })

  const outputPath = await writeMemoryCaptureFile(capture, options.outputDir)
  console.log(outputPath)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
