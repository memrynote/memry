// Runs one scenario's steps through the TypeScript CLI with the desktop registry adapter, in the
// scenario's temp folder (generate.mjs sets cwd, HOME and MEMRY_GOLDEN_CONFIG).
import fs from 'node:fs'

import { runCli } from '../../../../../apps/cli/src/run.ts'
import { createDesktopCliVaultRegistry } from '../../../../../apps/desktop/src/main/cli/vault-registry.ts'
import { expandTokens } from '../normalize.mjs'

interface Step {
  argv: string[]
  sleepMs?: number
  capture?: Record<string, string>
}

const input = process.argv[2]
const { scenario, dirs } = JSON.parse(fs.readFileSync(input, 'utf8'))
const aliases: Record<string, unknown> = {}
const results = []
for (const step of scenario.steps as Step[]) {
  let stdout = ''
  let stderr = ''
  const exit = await runCli(
    expandTokens(step.argv, dirs, aliases),
    {
      stdout: (line) => (stdout += `${line}\n`),
      stderr: (line) => (stderr += `${line}\n`)
    },
    { vaultRegistry: createDesktopCliVaultRegistry() }
  )
  results.push({ exit, stdout, stderr })
  for (const [alias, where] of Object.entries(step.capture ?? {})) {
    let value: unknown = JSON.parse(stdout)
    for (const key of where.split('.')) value = (value as Record<string, unknown>)[key]
    aliases[alias] = value
  }
  if (step.sleepMs) await new Promise((resolve) => setTimeout(resolve, step.sleepMs))
}
fs.writeFileSync(`${input}.out`, JSON.stringify(results))
