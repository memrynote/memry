import { app } from 'electron'
import { runCli as defaultRunCli } from '@memry/cli'
import { createDesktopCliVaultRegistry } from './vault-registry'

export function getHeadlessCliArgs(argv: string[]): string[] | null {
  const cliIndex = argv.indexOf('--cli')
  if (cliIndex === -1) return null
  return argv.slice(cliIndex + 1)
}

interface HeadlessCliDeps {
  runCli?: (args: string[]) => Promise<number>
  exit?: (code: number) => void
}

export async function runHeadlessCli(args: string[], deps: HeadlessCliDeps = {}): Promise<void> {
  const exit = deps.exit ?? ((code: number) => app.exit(code))
  const code = deps.runCli
    ? await deps.runCli(args)
    : await defaultRunCli(args, undefined, { vaultRegistry: createDesktopCliVaultRegistry() })
  exit(code)
}
