import { app } from 'electron'
import { runCli as defaultRunCli } from '@memry/cli'
import { runMigrateInstallerCommand } from './migrate-installer'
import { createDesktopCliVaultRegistry } from './vault-registry'

export function getHeadlessCliArgs(argv: string[]): string[] | null {
  const cliIndex = argv.indexOf('--cli')
  if (cliIndex === -1) return null
  return argv.slice(cliIndex + 1)
}

interface HeadlessCliDeps {
  runCli?: (args: string[]) => Promise<number>
  migrateInstaller?: (args: string[]) => Promise<number>
  exit?: (code: number) => void
}

export async function runHeadlessCli(args: string[], deps: HeadlessCliDeps = {}): Promise<void> {
  const exit = deps.exit ?? ((code: number) => app.exit(code))
  const code = await runCommand(args, deps)
  exit(code)
}

async function runCommand(args: string[], deps: HeadlessCliDeps): Promise<number> {
  if (args[0] === 'migrate-installer') {
    return (deps.migrateInstaller ?? runMigrateInstallerCommand)(args.slice(1))
  }
  if (deps.runCli) {
    return deps.runCli(args)
  }
  return defaultRunCli(args, undefined, { vaultRegistry: createDesktopCliVaultRegistry() })
}
