import type { MemryApp } from '../app-core/memry-app.ts'
import {
  getFlag,
  getFlagList,
  hasFlag,
  parseBooleanFlag,
  print,
  requireFirst,
  type CliIo,
  type ParsedCli
} from '../cli-support.ts'

function requireFlag(parsed: ParsedCli, key: string): string {
  const value = getFlag(parsed.flags, key)
  if (value === undefined || value === 'true') throw new Error(`Missing --${key}`)
  return value
}

function requireSuccess<T extends { success: boolean; error?: string }>(result: T): T {
  if (!result.success) throw new Error(result.error ?? 'Inbox operation failed')
  return result
}

function printBulk(
  io: CliIo,
  json: boolean,
  result: {
    success: boolean
    processedCount: number
    errors: Array<{ itemId: string; error: string }>
  }
): void {
  print(io, json, result)
  if (!result.success) {
    throw new Error(
      `${result.errors.length} inbox item(s) failed: ${result.errors[0]?.error ?? ''}`
    )
  }
}

/** Inbox commands added for desktop parity. Returns false for a subcommand it does not own. */
export async function runInboxExtras(
  app: MemryApp,
  parsed: ParsedCli,
  io: CliIo
): Promise<boolean> {
  const { inboxFiling } = app
  switch (parsed.subcommand) {
    case 'file':
      print(
        io,
        parsed.json,
        requireSuccess(
          await inboxFiling.file(
            requireFirst(parsed.positionals, 'inbox item id'),
            requireFlag(parsed, 'folder'),
            getFlagList(parsed.flags, 'tag')
          )
        )
      )
      return true
    case 'bulk-file':
      if (parsed.positionals.length === 0) throw new Error('Missing inbox item ids')
      printBulk(
        io,
        parsed.json,
        await inboxFiling.bulkFile(
          parsed.positionals,
          requireFlag(parsed, 'folder'),
          getFlagList(parsed.flags, 'tag')
        )
      )
      return true
    case 'file-all-stale':
      if (!hasFlag(parsed.flags, 'yes')) {
        throw new Error('Pass --yes to file every stale inbox item into the Unsorted folder')
      }
      printBulk(io, parsed.json, await inboxFiling.fileAllStale())
      return true
    case 'convert-event':
      print(
        io,
        parsed.json,
        requireSuccess(
          await inboxFiling.convertToEvent(requireFirst(parsed.positionals, 'inbox item id'), {
            startAt: requireFlag(parsed, 'start'),
            endAt: getFlag(parsed.flags, 'end') ?? null,
            isAllDay: parseBooleanFlag(parsed.flags, 'all-day') ?? false,
            location: getFlag(parsed.flags, 'location') ?? null
          })
        )
      )
      return true
    case 'convert-reminder':
      print(
        io,
        parsed.json,
        requireSuccess(
          await inboxFiling.convertToReminder(requireFirst(parsed.positionals, 'inbox item id'), {
            remindAt: requireFlag(parsed, 'at')
          })
        )
      )
      return true
    case 'suggestions':
      print(
        io,
        parsed.json,
        await inboxFiling.suggestions(requireFirst(parsed.positionals, 'inbox item id'))
      )
      return true
    case 'undo': {
      const action = requireFirst(parsed.positionals, 'undo action (archive|file)')
      const id = requireFirst(parsed.positionals.slice(1), 'inbox item id')
      if (action !== 'archive' && action !== 'file') {
        throw new Error('Usage: memrynote inbox undo archive|file <inbox item id>')
      }
      print(
        io,
        parsed.json,
        requireSuccess(
          action === 'archive' ? await inboxFiling.undoArchive(id) : await inboxFiling.undoFile(id)
        )
      )
      return true
    }
    case 'capture-image':
    case 'capture-pdf':
    case 'capture-voice': {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- string value from a CLI flag; the command validates it downstream and a parser here would change error messages
      const kind = parsed.subcommand.slice('capture-'.length) as 'image' | 'pdf' | 'voice'
      print(
        io,
        parsed.json,
        await inboxFiling.captureBinary(kind, {
          filePath: requireFirst(parsed.positionals, `inbox ${kind} file path`),
          title: getFlag(parsed.flags, 'title'),
          tags: getFlagList(parsed.flags, 'tag'),
          transcribe: parseBooleanFlag(parsed.flags, 'transcribe')
        })
      )
      return true
    }
    case 'jobs':
      print(
        io,
        parsed.json,
        await inboxFiling.jobs({
          itemIds: getFlagList(parsed.flags, 'item'),
          statuses: getFlagList(parsed.flags, 'status')
        })
      )
      return true
    case 'retry':
      print(
        io,
        parsed.json,
        requireSuccess(await inboxFiling.retry(requireFirst(parsed.positionals, 'inbox item id')))
      )
      return true
    default:
      return false
  }
}
