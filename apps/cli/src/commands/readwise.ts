import { READWISE_CATEGORIES, type ReadwiseSetOptionsInput } from '@memry/contracts/import-channels'
import type { MemryApp } from '../app-core/memry-app.ts'
import { READWISE_DESKTOP_ONLY_COMMANDS } from '../app-core/readwise.ts'
import { getFlag, getFlagList, print, type CliIo, type ParsedCli } from '../run.ts'

function parseSwitch(value: string | undefined, flag: string): boolean | undefined {
  if (value === undefined) return undefined
  if (['on', 'true', 'yes'].includes(value)) return true
  if (['off', 'false', 'no'].includes(value)) return false
  throw new Error(`--${flag} takes on or off`)
}

function parseOptions(parsed: ParsedCli): ReadwiseSetOptionsInput {
  const { flags } = parsed
  const categories: Record<string, boolean> = {}
  for (const entry of getFlagList(flags, 'category')) {
    const [name, state] = entry.split('=')
    if (!(READWISE_CATEGORIES as readonly string[]).includes(name)) {
      throw new Error(`Unknown category ${name}. Use ${READWISE_CATEGORIES.join(', ')}`)
    }
    const enabled = parseSwitch(state, 'category')
    if (enabled === undefined) throw new Error('--category takes <name>=on|off')
    categories[name] = enabled
  }
  const input: Record<string, unknown> = {}
  const set = (key: string, value: unknown): void => {
    if (value !== undefined) input[key] = value
  }
  set('rootFolder', getFlag(flags, 'root-folder'))
  set('folderLayout', getFlag(flags, 'folder-layout'))
  set('cadence', getFlag(flags, 'cadence'))
  set('readerDocuments', parseSwitch(getFlag(flags, 'reader-documents'), 'reader-documents'))
  set('readerFullText', parseSwitch(getFlag(flags, 'reader-full-text'), 'reader-full-text'))
  set('journalHighlights', parseSwitch(getFlag(flags, 'journal'), 'journal'))
  if (Object.keys(categories).length > 0) input.categories = categories
  if (Object.keys(input).length === 0) {
    throw new Error(
      'Nothing to change. Pass --root-folder, --folder-layout, --cadence, --category <name>=on|off, --reader-documents, --reader-full-text, or --journal'
    )
  }
  return input as ReadwiseSetOptionsInput
}

/** `readwise` commands: the part of the Readwise importer that needs only the vault's databases. */
export async function runReadwise(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  const { readwise } = app
  const subcommand = parsed.subcommand ?? ''
  switch (subcommand) {
    case 'status':
      print(io, parsed.json, await readwise.status())
      return
    case 'list-deleted':
      print(io, parsed.json, await readwise.listDeleted())
      return
    case 'set-options':
      print(io, parsed.json, await readwise.setOptions(parseOptions(parsed)))
      return
    default:
      if ((READWISE_DESKTOP_ONLY_COMMANDS as readonly string[]).includes(subcommand)) {
        // The token sits in the OS keychain and pulls run in the desktop scheduler; a second
        // runner from here could race it, so these stay in the desktop app's Import settings.
        throw new Error(
          `readwise ${subcommand} runs in the desktop app (Settings > Import > Readwise). It needs the stored token and the app's sync scheduler, which the CLI cannot reach.`
        )
      }
      throw new Error(
        'Usage: memrynote readwise <status|list-deleted|set-options|sync-now|restore-book|reimport-book|refresh-book|take-over>'
      )
  }
}
