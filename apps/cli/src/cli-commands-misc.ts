import type { MemryApp } from './app-core/memry-app.ts'
import { runAgentExtras } from './commands/agent.ts'
import { runCalendarExtras } from './commands/calendar.ts'
import { parseSearchOptions } from './commands/search.ts'
import { runSyncExtras } from './commands/sync.ts'
import {
  type AgentBackend,
  type AgentLocalProviderSettingsInput,
  type CalendarBindingListOptions,
  type CalendarSourceListOptions,
  type CliIo,
  type ParsedCli,
  getFlag,
  hasFlag,
  parseBooleanFlag,
  parseCliValue,
  parseNullableFlag,
  parseNumber,
  parseSearchItemType,
  print,
  requireFirst
} from './cli-support.ts'

export async function runCalendar(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  if (await runCalendarExtras(app, parsed, io)) return

  if (parsed.subcommand === 'sources') {
    print(
      io,
      parsed.json,
      await app.calendar.sources.list({
        provider: getFlag(parsed.flags, 'provider'),
        kind: getFlag(parsed.flags, 'kind') as CalendarSourceListOptions['kind'],
        selectedOnly: hasFlag(parsed.flags, 'selected')
      })
    )
    return
  }

  if (parsed.subcommand === 'select-source') {
    print(
      io,
      parsed.json,
      await app.calendar.sources.updateSelection(
        requireFirst(parsed.positionals, 'calendar source id'),
        parseBooleanFlag(parsed.flags, 'selected') ?? true
      )
    )
    return
  }

  if (parsed.subcommand === 'provider-status') {
    const provider = getFlag(parsed.flags, 'provider') ?? parsed.positionals[0]
    if (!provider) throw new Error('Pass --provider to provider-status')
    print(
      io,
      parsed.json,
      await app.calendar.providerStatus({
        provider,
        accountId: getFlag(parsed.flags, 'account')
      })
    )
    return
  }

  if (parsed.subcommand === 'google-settings') {
    print(io, parsed.json, await app.calendar.googleSettings())
    return
  }

  if (parsed.subcommand === 'set-default-google-calendar') {
    print(
      io,
      parsed.json,
      await app.calendar.setDefaultGoogleCalendar(
        parseNullableFlag(parsed.flags, 'calendar') ??
          (parsed.positionals[0] === 'null'
            ? null
            : requireFirst(parsed.positionals, 'calendar id')),
        parseBooleanFlag(parsed.flags, 'mark-onboarding') ?? true
      )
    )
    return
  }

  if (parsed.subcommand === 'range') {
    print(
      io,
      parsed.json,
      await app.calendar.range({
        startAt: getFlag(parsed.flags, 'start') ?? '',
        endAt: getFlag(parsed.flags, 'end') ?? '',
        includeUnselectedSources: hasFlag(parsed.flags, 'include-unselected')
      })
    )
    return
  }

  if (parsed.subcommand === 'external') {
    const action = requireFirst(parsed.positionals, 'calendar external action')
    const args = parsed.positionals.slice(1)

    switch (action) {
      case 'list':
        print(
          io,
          parsed.json,
          await app.calendar.external.list({
            sourceId: getFlag(parsed.flags, 'source'),
            includeArchived: hasFlag(parsed.flags, 'archived'),
            start: getFlag(parsed.flags, 'start'),
            end: getFlag(parsed.flags, 'end')
          })
        )
        return
      case 'get':
        print(
          io,
          parsed.json,
          await app.calendar.external.get(requireFirst(args, 'external calendar event id'))
        )
        return
      case 'promote':
        print(
          io,
          parsed.json,
          await app.calendar.external.promote(requireFirst(args, 'external calendar event id'))
        )
        return
      default:
        throw new Error('Usage: memrynote [--vault <path>] calendar external list|get|promote')
    }
  }

  if (parsed.subcommand === 'bindings') {
    const action = requireFirst(parsed.positionals, 'calendar bindings action')
    const args = parsed.positionals.slice(1)

    switch (action) {
      case 'list':
        print(
          io,
          parsed.json,
          await app.calendar.bindings.list({
            sourceType: getFlag(parsed.flags, 'source-type') as
              | CalendarBindingListOptions['sourceType']
              | undefined,
            sourceId: getFlag(parsed.flags, 'source'),
            provider: getFlag(parsed.flags, 'provider'),
            includeArchived: hasFlag(parsed.flags, 'archived')
          })
        )
        return
      case 'get':
        print(io, parsed.json, await app.calendar.bindings.get(requireFirst(args, 'binding id')))
        return
      default:
        throw new Error('Usage: memrynote [--vault <path>] calendar bindings list|get')
    }
  }

  if (parsed.subcommand !== 'events') {
    throw new Error(
      'Usage: memrynote [--vault <path>] calendar events create|get|list|update|delete OR calendar sources|select-source|provider-status|google-settings|set-default-google-calendar|range|external|bindings|linked-notes|providers|provider-calendars|refresh|set-default-calendar|ics|retry-sync|writer-compat (events also: search)'
    )
  }

  const action = requireFirst(parsed.positionals, 'calendar events action')
  const args = parsed.positionals.slice(1)

  switch (action) {
    case 'create':
      print(
        io,
        parsed.json,
        await app.calendar.events.create({
          title: requireFirst(args, 'calendar event title'),
          startAt: getFlag(parsed.flags, 'start') ?? '',
          endAt: getFlag(parsed.flags, 'end') ?? null,
          timezone: getFlag(parsed.flags, 'timezone') ?? 'UTC',
          description: getFlag(parsed.flags, 'description') ?? null,
          location: getFlag(parsed.flags, 'location') ?? null,
          isAllDay: parseBooleanFlag(parsed.flags, 'all-day') ?? false
        })
      )
      return
    case 'get':
      print(io, parsed.json, await app.calendar.events.get(requireFirst(args, 'calendar event id')))
      return
    case 'list':
      print(
        io,
        parsed.json,
        await app.calendar.events.list({
          start: getFlag(parsed.flags, 'start'),
          end: getFlag(parsed.flags, 'end'),
          includeArchived: hasFlag(parsed.flags, 'archived')
        })
      )
      return
    case 'update':
      print(
        io,
        parsed.json,
        await app.calendar.events.update(requireFirst(args, 'calendar event id'), {
          title: getFlag(parsed.flags, 'title'),
          startAt: getFlag(parsed.flags, 'start'),
          endAt: parsed.flags.has('end') ? (getFlag(parsed.flags, 'end') ?? null) : undefined,
          timezone: getFlag(parsed.flags, 'timezone'),
          description: parsed.flags.has('description')
            ? (getFlag(parsed.flags, 'description') ?? null)
            : undefined,
          location: parsed.flags.has('location')
            ? (getFlag(parsed.flags, 'location') ?? null)
            : undefined,
          isAllDay: parseBooleanFlag(parsed.flags, 'all-day')
        })
      )
      return
    case 'delete':
      if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to delete a calendar event')
      print(io, parsed.json, {
        success: await app.calendar.events.delete(requireFirst(args, 'calendar event id'))
      })
      return
    default:
      throw new Error(
        'Usage: memrynote [--vault <path>] calendar events create|get|list|update|delete'
      )
  }
}

export async function runSync(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'status':
      print(io, parsed.json, await app.sync.status())
      return
    case 'queue-size':
      print(io, parsed.json, await app.sync.queueSize())
      return
    case 'history':
      print(
        io,
        parsed.json,
        await app.sync.history({
          limit: parseNumber(getFlag(parsed.flags, 'limit'), 50),
          offset: parseNumber(getFlag(parsed.flags, 'offset'), 0)
        })
      )
      return
    case 'devices':
      print(io, parsed.json, await app.sync.devices())
      return
    case 'storage':
      print(io, parsed.json, await app.sync.storageBreakdown())
      return
    case 'quarantine':
      print(io, parsed.json, await app.sync.quarantinedItems())
      return
    case 'check-device':
      print(io, parsed.json, await app.sync.checkDeviceStatus())
      return
    case 'pause':
      print(io, parsed.json, await app.sync.pause())
      return
    case 'resume':
      print(io, parsed.json, await app.sync.resume())
      return
    case 'settings':
      print(io, parsed.json, await app.sync.getSyncedSettings())
      return
    case 'update-setting':
      print(
        io,
        parsed.json,
        await app.sync.updateSyncedSetting(
          requireFirst(parsed.positionals, 'synced setting path'),
          parseCliValue(parsed.positionals[1] ?? 'null')
        )
      )
      return
    default:
      if (await runSyncExtras(app, parsed, io)) return
      throw new Error(
        'Usage: memrynote [--vault <path>] sync status|queue-size|history|devices|storage|quarantine|check-device|pause|resume|settings|update-setting|trigger|note-state|large-notes|unsent-notes|binding|progress|rename-device|remove-device'
      )
  }
}

function parseAgentBackend(value: string | undefined): AgentBackend {
  if (value === 'claude_cli' || value === 'codex_cli' || value === 'antigravity_cli') return value
  throw new Error('Agent backend must be claude_cli, codex_cli or antigravity_cli')
}

export async function runAgent(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'backends':
      print(io, parsed.json, await app.agent.backendStatuses())
      return
    case 'models':
      print(
        io,
        parsed.json,
        await app.agent.backendModels(
          parseAgentBackend(getFlag(parsed.flags, 'backend') ?? parsed.positionals[0])
        )
      )
      return
    case 'local-settings':
      print(io, parsed.json, await app.agent.getLocalProviderSettings())
      return
    case 'set-local-settings': {
      const input: AgentLocalProviderSettingsInput = {}
      const preset = getFlag(parsed.flags, 'preset')
      if (preset) {
        if (
          preset !== 'ollama' &&
          preset !== 'lm_studio' &&
          preset !== 'llama_cpp' &&
          preset !== 'custom'
        ) {
          throw new Error('Local provider preset must be ollama, lm_studio, llama_cpp, or custom')
        }
        input.preset = preset
      }
      if (parsed.flags.has('base-url')) input.baseUrl = getFlag(parsed.flags, 'base-url') ?? ''
      if (parsed.flags.has('model')) input.model = getFlag(parsed.flags, 'model') ?? ''
      if (parsed.flags.has('allow-non-loopback')) {
        input.allowNonLoopback = parseBooleanFlag(parsed.flags, 'allow-non-loopback') ?? false
      }
      print(io, parsed.json, await app.agent.setLocalProviderSettings(input))
      return
    }
    default:
      if (await runAgentExtras(app, parsed, io)) return
      throw new Error(
        'Usage: memrynote [--vault <path>] agent backends|models|local-settings|set-local-settings|conversations|conversation|preferences|set-preferences|local-models|test-local|mcp-status|mcp'
      )
  }
}

export async function runGraph(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'data':
      print(io, parsed.json, await app.graph.data())
      return
    case 'local':
      print(
        io,
        parsed.json,
        await app.graph.local(
          requireFirst(parsed.positionals, 'note id'),
          parseNumber(getFlag(parsed.flags, 'depth'), 2)
        )
      )
      return
    default:
      throw new Error('Usage: memrynote [--vault <path>] graph data|local')
  }
}

export async function runSearch(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'stats':
      print(io, parsed.json, await app.searchStats())
      return
    case 'reasons':
      print(io, parsed.json, await app.searchReasons.list())
      return
    case 'add-reason':
      print(
        io,
        parsed.json,
        await app.searchReasons.add({
          itemId: requireFirst(parsed.positionals, 'item id'),
          itemType: parseSearchItemType(parsed.positionals[1]),
          itemTitle: parsed.positionals[2] ?? '',
          searchQuery: parsed.positionals[3] ?? ''
        })
      )
      return
    case 'clear-reasons':
      print(io, parsed.json, await app.searchReasons.clear())
      return
    case 'tags':
      print(io, parsed.json, await app.searchTags())
      return
    case 'rebuild-index': {
      const stats = await app.searchStats()
      print(io, parsed.json, { started: true, indexed: stats.totalIndexed })
      return
    }
    default:
      print(
        io,
        parsed.json,
        await app.search(
          [parsed.subcommand, ...parsed.positionals]
            .filter((part): part is string => !!part)
            .join(' '),
          parseSearchOptions(parsed)
        )
      )
  }
}
