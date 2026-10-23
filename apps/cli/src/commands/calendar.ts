import type { MemryApp } from '../app-core/memry-app.ts'
import {
  getFlag,
  hasFlag,
  parseBooleanFlag,
  parseNumber,
  print,
  requireFirst,
  type CliIo,
  type ParsedCli
} from '../cli-support.ts'

function requireProvider(parsed: ParsedCli): string {
  const provider = getFlag(parsed.flags, 'provider') ?? parsed.positionals[0]
  if (!provider || provider === 'true') throw new Error('Missing --provider')
  return provider
}

function requireMutation<T extends { success: boolean; error?: string }>(result: T): T {
  if (!result.success) throw new Error(result.error ?? 'Calendar operation failed')
  return result
}

async function runIcs(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  const action = requireFirst(parsed.positionals, 'calendar ics action')
  const args = parsed.positionals.slice(1)
  const { ics } = app.calendarExtras
  switch (action) {
    case 'subscribe':
      print(
        io,
        parsed.json,
        requireMutation(
          await ics.subscribe({
            url: requireFirst(args, 'calendar feed URL'),
            title: getFlag(parsed.flags, 'name')
          })
        )
      )
      return
    case 'unsubscribe':
      if (!hasFlag(parsed.flags, 'yes'))
        throw new Error('Pass --yes to unsubscribe from a calendar')
      print(
        io,
        parsed.json,
        requireMutation(await ics.unsubscribe(requireFirst(args, 'calendar source id')))
      )
      return
    case 'update': {
      const name = getFlag(parsed.flags, 'name')
      const color = getFlag(parsed.flags, 'color')
      if (name === undefined && color === undefined) throw new Error('Pass --name and/or --color')
      print(
        io,
        parsed.json,
        requireMutation(
          await ics.update({
            sourceId: requireFirst(args, 'calendar source id'),
            title: name,
            color
          })
        )
      )
      return
    }
    case 'refresh':
      await ics.refresh(requireFirst(args, 'calendar source id'))
      return
    default:
      throw new Error(
        'Usage: memrynote [--vault <path>] calendar ics subscribe|unsubscribe|update|refresh'
      )
  }
}

/** Calendar commands added for desktop parity. Returns false for a subcommand it does not own. */
export async function runCalendarExtras(
  app: MemryApp,
  parsed: ParsedCli,
  io: CliIo
): Promise<boolean> {
  const { calendarExtras } = app
  switch (parsed.subcommand) {
    case 'events': {
      if (parsed.positionals[0] !== 'search') return false
      print(
        io,
        parsed.json,
        await calendarExtras.searchEvents({
          query: requireFirst(parsed.positionals.slice(1), 'search text'),
          limit: parseNumber(getFlag(parsed.flags, 'limit'), 20),
          includeExternal: hasFlag(parsed.flags, 'include-external')
        })
      )
      return true
    }
    case 'linked-notes':
      print(
        io,
        parsed.json,
        await calendarExtras.linkedNotes({
          sourceType: hasFlag(parsed.flags, 'external') ? 'external_event' : 'event',
          sourceId: requireFirst(parsed.positionals, 'calendar event id')
        })
      )
      return true
    case 'providers':
      print(io, parsed.json, await calendarExtras.providers())
      return true
    case 'provider-calendars':
      print(io, parsed.json, await calendarExtras.providerCalendars(requireProvider(parsed)))
      return true
    case 'refresh':
      await calendarExtras.refreshProvider(requireProvider(parsed))
      return true
    case 'set-default-calendar': {
      const calendar = getFlag(parsed.flags, 'calendar') ?? parsed.positionals[0]
      if (!calendar || calendar === 'true')
        throw new Error('Missing --calendar (or "null" to clear)')
      print(
        io,
        parsed.json,
        await calendarExtras.setDefaultCalendar(
          getFlag(parsed.flags, 'provider') ?? 'google',
          calendar === 'null' ? null : calendar,
          parseBooleanFlag(parsed.flags, 'mark-onboarding') ?? true
        )
      )
      return true
    }
    case 'ics':
      await runIcs(app, parsed, io)
      return true
    case 'retry-sync':
      await calendarExtras.retrySync(requireFirst(parsed.positionals, 'calendar source id'))
      return true
    case 'writer-compat':
      await calendarExtras.writerCompat(requireProvider(parsed))
      return true
    default:
      return false
  }
}
