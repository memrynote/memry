// `pnpm sandbox --vault=<path>`: builds a new, fully populated showcase vault.
// Runs under Electron's Node via bin/sandbox.mjs.
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'

import { generateSandbox } from './generate.ts'

async function isMissingOrEmpty(dir: string): Promise<boolean> {
  try {
    return (await fs.readdir(dir)).length === 0
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
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

  // Build next to the target and rename on success, so a failure never leaves a half-made vault.
  await fs.mkdir(path.dirname(target), { recursive: true })
  const staging = await fs.mkdtemp(
    path.join(path.dirname(target), `.${path.basename(target)}.sandbox-`)
  )
  let counts: Awaited<ReturnType<typeof generateSandbox>>
  try {
    counts = await generateSandbox(staging, new Date())
    await fs.rm(target, { recursive: true, force: true })
    await fs.rename(staging, target)
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true })
    throw error
  }

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
