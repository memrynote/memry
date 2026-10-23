import type { MemryApp } from '../app-core/memry-app.ts'
import {
  getFlag,
  hasFlag,
  parseNumber,
  print,
  requireFirst,
  type CliIo,
  type ParsedCli
} from '../run.ts'

const usage =
  'Usage: memrynote [--vault <path>] vault reindex|set-icon <icon|null>|activity list|clear|locks list|set'

async function runActivity(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  const action = parsed.positionals[0]
  if (action === 'list') {
    const filter = hasFlag(parsed.flags, 'problems') ? 'problems' : 'all'
    const limit = hasFlag(parsed.flags, 'limit')
      ? parseNumber(getFlag(parsed.flags, 'limit'), 200)
      : undefined
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) {
      throw new Error('--limit must be an integer from 1 to 1000')
    }
    print(io, parsed.json, await app.vault.listActivity({ limit, filter }))
    return
  }
  if (action === 'clear') {
    if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to clear the vault activity log')
    print(io, parsed.json, await app.vault.clearActivity())
    return
  }
  throw new Error(
    'Usage: memrynote [--vault <path>] vault activity list [--problems] [--limit <n>] | clear --yes'
  )
}

function runLocks(app: MemryApp, parsed: ParsedCli, io: CliIo): void {
  const action = parsed.positionals[0]
  if (action === 'list') {
    print(io, parsed.json, app.vault.listLocks())
    return
  }
  if (action === 'set') {
    // Locking also makes the files read-only on disk, keeps a baseline of each locked note
    // and enqueues the sync record. Desktop owns all three, so a row written here alone
    // would claim a lock nothing enforces.
    throw new Error(
      'Setting a lock needs the desktop app: it protects the files on disk and syncs the lock. Lock it from the note or folder menu in Memry.'
    )
  }
  throw new Error('Usage: memrynote [--vault <path>] vault locks list')
}

export async function runVaultAdmin(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'reindex':
      print(io, parsed.json, await app.vault.reindex())
      return
    case 'set-icon': {
      const value = requireFirst(parsed.positionals, 'icon (icon:<Name>, an emoji, or null)')
      print(io, parsed.json, await app.vault.setIcon(value === 'null' ? null : value))
      return
    }
    case 'activity':
      return runActivity(app, parsed, io)
    case 'locks':
      return runLocks(app, parsed, io)
    default:
      throw new Error(usage)
  }
}
