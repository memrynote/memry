// `pnpm sandbox --vault=<path>`: builds a new, fully populated showcase vault.
// Runs under Electron's Node via bin/sandbox.mjs.
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'

import { generateSandboxAt } from './generate.ts'
import { errorCode } from '../app-core/errno.ts'

async function isMissingOrEmpty(dir: string): Promise<boolean> {
  try {
    return (await fs.readdir(dir)).length === 0
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return true
    throw error
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { vault: { type: 'string' } } })
  if (!values.vault) throw new Error('Usage: pnpm sandbox --vault=<path to a new or empty folder>')

  const target = path.resolve(values.vault)
  if (!(await isMissingOrEmpty(target))) {
    throw new Error(
      `${target} is not empty. The sandbox never writes into an existing vault; pick a new folder.`
    )
  }

  const counts = await generateSandboxAt(target, new Date())

  const width = Math.max(...Object.keys(counts).map((name) => name.length))
  process.stdout.write(`Sandbox vault created at ${target}\n\n`)
  for (const [name, count] of Object.entries(counts)) {
    process.stdout.write(`  ${name.padEnd(width)}  ${count}\n`)
  }
  process.stdout.write(`\nOpen it: run \`pnpm dev\`, then choose Open vault and pick ${target}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`sandbox: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
