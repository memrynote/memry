// When you add or rename a subcommand/flag in this file, update
// apps/docs/src/user-guide/cli-reference.md to match.

import { createMemryApp as defaultCreateMemryApp, type MemryApp } from './app-core/memry-app.ts'
import {
  parseCli,
  resolveDefaultVaultPath,
  type CliIo,
  type CliRuntimeDeps,
  type ParsedCli
} from './cli-support.ts'
import {
  runFolders,
  runFolderView,
  runNotes,
  runProperties,
  runVault,
  runVaultRegistryCommand
} from './cli-commands-vault.ts'
import { runInbox, runJournal, runProjects, runTags, runTasks } from './cli-commands-work.ts'
import {
  runBookmarks,
  runLocale,
  runReminders,
  runSavedFilters,
  runSettings,
  runTemplates
} from './cli-commands-library.ts'
import { runAgent, runCalendar, runGraph, runSearch, runSync } from './cli-commands-misc.ts'

export type { CliIo, CliKnownVault, CliRuntimeDeps, CliVaultRegistry } from './cli-support.ts'

async function route(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.command) {
    case 'vault':
      return runVault(app, parsed, io)
    case 'notes':
      return runNotes(app, parsed, io)
    case 'folders':
      return runFolders(app, parsed, io)
    case 'properties':
      return runProperties(app, parsed, io)
    case 'folder-view':
      return runFolderView(app, parsed, io)
    case 'tasks':
      return runTasks(app, parsed, io)
    case 'projects':
      return runProjects(app, parsed, io)
    case 'inbox':
      return runInbox(app, parsed, io)
    case 'journal':
      return runJournal(app, parsed, io)
    case 'tags':
      return runTags(app, parsed, io)
    case 'settings':
      return runSettings(app, parsed, io)
    case 'locale':
      return runLocale(app, parsed, io)
    case 'reminders':
      return runReminders(app, parsed, io)
    case 'templates':
      return runTemplates(app, parsed, io)
    case 'bookmarks':
      return runBookmarks(app, parsed, io)
    case 'saved-filters':
      return runSavedFilters(app, parsed, io)
    case 'calendar':
      return runCalendar(app, parsed, io)
    case 'sync':
      return runSync(app, parsed, io)
    case 'agent':
      return runAgent(app, parsed, io)
    case 'graph':
      return runGraph(app, parsed, io)
    case 'search':
      return runSearch(app, parsed, io)
    default:
      throw new Error(
        'Usage: memrynote [--vault <path>] <vault|notes|folders|properties|folder-view|tasks|projects|inbox|journal|tags|settings|locale|reminders|templates|bookmarks|saved-filters|calendar|sync|agent|graph|search>'
      )
  }
}

export async function runCli(
  args: string[],
  io: CliIo = {},
  deps: CliRuntimeDeps = {}
): Promise<number> {
  const parsed = parseCli(args)
  const stderr = io.stderr ?? ((line: string) => process.stderr.write(`${line}\n`))
  const stdout = io.stdout ?? ((line: string) => process.stdout.write(`${line}\n`))

  let app: MemryApp | null = null
  try {
    if (
      parsed.command === 'vault' &&
      (await runVaultRegistryCommand(parsed, { stdout, stderr }, deps.vaultRegistry))
    ) {
      return 0
    }

    const vaultPath = parsed.vaultPath ?? (await resolveDefaultVaultPath(deps.vaultRegistry))
    const createApp = deps.createApp ?? defaultCreateMemryApp
    app = await createApp({ vaultPath })
    await route(app, parsed, { stdout, stderr })
    return 0
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error))
    return 1
  } finally {
    app?.close()
  }
}
