import { existsSync, rmSync, mkdirSync } from 'fs'
import { resolve, sep } from 'path'
import { homedir } from 'os'

const FORBIDDEN_PATHS = new Set(
  ['/', homedir(), resolve(homedir(), 'Documents'), resolve(homedir(), 'Desktop')].map((p) =>
    resolve(p)
  )
)

function ensureSafeVaultPath(vaultPath: string): string {
  const absolute = resolve(vaultPath)

  if (FORBIDDEN_PATHS.has(absolute)) {
    throw new Error(`Refusing to operate on protected path: ${absolute}`)
  }

  if (absolute.split(sep).filter(Boolean).length < 2) {
    throw new Error(`Vault path looks too shallow, refusing: ${absolute}`)
  }

  return absolute
}

export function wipeVault(vaultPath: string): void {
  const absolute = ensureSafeVaultPath(vaultPath)

  if (existsSync(absolute)) {
    rmSync(absolute, { recursive: true, force: true })
  }

  mkdirSync(absolute, { recursive: true })
  mkdirSync(resolve(absolute, '.memry'), { recursive: true })
  mkdirSync(resolve(absolute, 'notes'), { recursive: true })
  mkdirSync(resolve(absolute, 'journal'), { recursive: true })
  mkdirSync(resolve(absolute, 'attachments'), { recursive: true })
}
