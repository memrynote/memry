import type { MemryApp } from './app-core/memry-app.ts'
import {
  type CliIo,
  type ParsedCli,
  getFlag,
  getFlagList,
  hasFlag,
  parseCliValue,
  parseJsonFlag,
  parseNullableFlag,
  parseNumber,
  parseObjectValue,
  parsePositionFlags,
  parseReminderStatus,
  parseReminderTargetType,
  print,
  requireFirst
} from './cli-support.ts'

export async function runSettings(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'list':
      print(io, parsed.json, await app.settings.list())
      return
    case 'groups':
      print(io, parsed.json, await app.settings.groups())
      return
    case 'group':
      print(
        io,
        parsed.json,
        await app.settings.getGroup(requireFirst(parsed.positionals, 'group name'))
      )
      return
    case 'set-group':
      print(
        io,
        parsed.json,
        await app.settings.setGroup(
          requireFirst(parsed.positionals, 'group name'),
          parseObjectValue(parsed.positionals[1], 'settings group update')
        )
      )
      return
    case 'ai':
      print(io, parsed.json, await app.settings.ai())
      return
    case 'set-ai': {
      const enabled = parseCliValue(requireFirst(parsed.positionals, 'AI enabled value'))
      if (typeof enabled !== 'boolean') throw new Error('AI enabled value must be true or false')
      print(io, parsed.json, await app.settings.setAi({ enabled }))
      return
    }
    case 'get':
      print(
        io,
        parsed.json,
        await app.settings.get(requireFirst(parsed.positionals, 'setting key'))
      )
      return
    case 'set':
      print(
        io,
        parsed.json,
        await app.settings.set(
          requireFirst(parsed.positionals, 'setting key'),
          parseCliValue(parsed.positionals[1] ?? '')
        )
      )
      return
    case 'delete':
      if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to delete a setting')
      print(io, parsed.json, {
        success: await app.settings.delete(requireFirst(parsed.positionals, 'setting key'))
      })
      return
    default:
      throw new Error(
        'Usage: memrynote [--vault <path>] settings list|groups|group|set-group|ai|set-ai|get|set|delete'
      )
  }
}

export async function runLocale(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'get':
      print(io, parsed.json, await app.locale.get())
      return
    case 'set':
      print(io, parsed.json, await app.locale.set(requireFirst(parsed.positionals, 'locale code')))
      return
    case 'list':
      print(io, parsed.json, await app.locale.list())
      return
    default:
      throw new Error('Usage: memrynote [--vault <path>] locale get|set|list')
  }
}

export async function runReminders(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'create':
      print(
        io,
        parsed.json,
        await app.reminders.create({
          targetType: parseReminderTargetType(parsed.positionals[0]),
          targetId: parsed.positionals[1] ?? '',
          remindAt: getFlag(parsed.flags, 'at') ?? '',
          title: getFlag(parsed.flags, 'title') ?? null,
          note: getFlag(parsed.flags, 'note') ?? null,
          highlightText: getFlag(parsed.flags, 'highlight-text') ?? null,
          highlightStart: parsed.flags.has('highlight-start')
            ? parseNumber(getFlag(parsed.flags, 'highlight-start'), 0)
            : null,
          highlightEnd: parsed.flags.has('highlight-end')
            ? parseNumber(getFlag(parsed.flags, 'highlight-end'), 0)
            : null
        })
      )
      return
    case 'get':
      print(
        io,
        parsed.json,
        await app.reminders.get(requireFirst(parsed.positionals, 'reminder id'))
      )
      return
    case 'update':
      print(
        io,
        parsed.json,
        await app.reminders.update({
          id: requireFirst(parsed.positionals, 'reminder id'),
          remindAt: getFlag(parsed.flags, 'at'),
          title: parseNullableFlag(parsed.flags, 'title'),
          note: parseNullableFlag(parsed.flags, 'note')
        })
      )
      return
    case 'list':
      print(
        io,
        parsed.json,
        await app.reminders.list({
          targetType: parsed.flags.has('target-type')
            ? parseReminderTargetType(getFlag(parsed.flags, 'target-type'))
            : undefined,
          targetId: getFlag(parsed.flags, 'target-id'),
          status: parseReminderStatus(getFlag(parsed.flags, 'status')),
          fromDate: getFlag(parsed.flags, 'from'),
          toDate: getFlag(parsed.flags, 'to'),
          limit: parseNumber(getFlag(parsed.flags, 'limit'), 50),
          offset: parseNumber(getFlag(parsed.flags, 'offset'), 0)
        })
      )
      return
    case 'for-target':
      print(
        io,
        parsed.json,
        await app.reminders.forTarget(
          parseReminderTargetType(parsed.positionals[0]),
          parsed.positionals[1] ?? ''
        )
      )
      return
    case 'due':
      print(io, parsed.json, await app.reminders.due())
      return
    case 'upcoming':
      print(
        io,
        parsed.json,
        await app.reminders.upcoming(parseNumber(getFlag(parsed.flags, 'days'), 7))
      )
      return
    case 'dismiss':
      print(
        io,
        parsed.json,
        await app.reminders.dismiss(requireFirst(parsed.positionals, 'reminder id'))
      )
      return
    case 'snooze':
      print(
        io,
        parsed.json,
        await app.reminders.snooze(
          requireFirst(parsed.positionals, 'reminder id'),
          getFlag(parsed.flags, 'until') ?? parsed.positionals[1] ?? ''
        )
      )
      return
    case 'count-pending':
      print(io, parsed.json, await app.reminders.countPending())
      return
    case 'bulk-dismiss':
      print(io, parsed.json, await app.reminders.bulkDismiss(parsed.positionals))
      return
    case 'delete':
      if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to delete a reminder')
      print(io, parsed.json, {
        success: await app.reminders.delete(requireFirst(parsed.positionals, 'reminder id'))
      })
      return
    default:
      throw new Error(
        'Usage: memrynote [--vault <path>] reminders create|get|update|list|for-target|due|upcoming|dismiss|snooze|count-pending|bulk-dismiss|delete'
      )
  }
}

export async function runTemplates(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'list':
      print(io, parsed.json, await app.templates.list())
      return
    case 'get':
      print(
        io,
        parsed.json,
        await app.templates.get(requireFirst(parsed.positionals, 'template id'))
      )
      return
    case 'create':
      print(
        io,
        parsed.json,
        await app.templates.create({
          name: requireFirst(parsed.positionals, 'template name'),
          description: getFlag(parsed.flags, 'description'),
          icon: getFlag(parsed.flags, 'icon') ?? null,
          content: getFlag(parsed.flags, 'content') ?? '',
          tags: getFlagList(parsed.flags, 'tag')
        })
      )
      return
    case 'update':
      print(
        io,
        parsed.json,
        await app.templates.update(requireFirst(parsed.positionals, 'template id'), {
          name: getFlag(parsed.flags, 'name'),
          description: getFlag(parsed.flags, 'description'),
          icon: parsed.flags.has('icon') ? (getFlag(parsed.flags, 'icon') ?? null) : undefined,
          content: getFlag(parsed.flags, 'content'),
          tags: parsed.flags.has('tag') ? getFlagList(parsed.flags, 'tag') : undefined
        })
      )
      return
    case 'duplicate':
      print(
        io,
        parsed.json,
        await app.templates.duplicate(
          requireFirst(parsed.positionals, 'template id'),
          parsed.positionals[1] ?? ''
        )
      )
      return
    case 'delete':
      if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to delete a template')
      print(io, parsed.json, {
        success: await app.templates.delete(requireFirst(parsed.positionals, 'template id'))
      })
      return
    default:
      throw new Error(
        'Usage: memrynote [--vault <path>] templates list|get|create|update|duplicate|delete'
      )
  }
}

export async function runBookmarks(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'list':
      print(io, parsed.json, await app.bookmarks.list({ itemType: getFlag(parsed.flags, 'type') }))
      return
    case 'get':
      print(
        io,
        parsed.json,
        await app.bookmarks.get(requireFirst(parsed.positionals, 'bookmark id'))
      )
      return
    case 'get-by-item':
      print(
        io,
        parsed.json,
        await app.bookmarks.getByItem(
          requireFirst(parsed.positionals, 'bookmark item type'),
          parsed.positionals[1] ?? ''
        )
      )
      return
    case 'list-by-type':
      print(
        io,
        parsed.json,
        await app.bookmarks.list({
          itemType: requireFirst(parsed.positionals, 'bookmark item type')
        })
      )
      return
    case 'add':
      print(
        io,
        parsed.json,
        await app.bookmarks.add({
          itemType: requireFirst(parsed.positionals, 'bookmark item type'),
          itemId: parsed.positionals[1] ?? ''
        })
      )
      return
    case 'toggle':
      print(
        io,
        parsed.json,
        await app.bookmarks.toggle({
          itemType: requireFirst(parsed.positionals, 'bookmark item type'),
          itemId: parsed.positionals[1] ?? ''
        })
      )
      return
    case 'remove':
      print(io, parsed.json, {
        success: await app.bookmarks.remove(
          requireFirst(parsed.positionals, 'bookmark item type'),
          parsed.positionals[1] ?? ''
        )
      })
      return
    case 'delete':
      if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to delete a bookmark')
      print(io, parsed.json, {
        success: await app.bookmarks.delete(requireFirst(parsed.positionals, 'bookmark id'))
      })
      return
    case 'has':
      print(io, parsed.json, {
        bookmarked: await app.bookmarks.has(
          requireFirst(parsed.positionals, 'bookmark item type'),
          parsed.positionals[1] ?? ''
        )
      })
      return
    case 'reorder':
      print(io, parsed.json, await app.bookmarks.reorder(parsed.positionals))
      return
    case 'bulk-create': {
      const parsedItems = parseCliValue(requireFirst(parsed.positionals, 'bookmark items'))
      if (!Array.isArray(parsedItems)) throw new Error('Bookmark items must be a JSON array')
      print(
        io,
        parsed.json,
        await app.bookmarks.bulkCreate(
          parsedItems.map((item) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
              throw new Error('Bookmark bulk item must be a JSON object')
            }
            const input = item as Record<string, unknown>
            if (typeof input.itemType !== 'string' || typeof input.itemId !== 'string') {
              throw new Error('Bookmark bulk item requires itemType and itemId')
            }
            return { itemType: input.itemType, itemId: input.itemId }
          })
        )
      )
      return
    }
    case 'bulk-delete':
      print(io, parsed.json, {
        success: await app.bookmarks.bulkDelete(parsed.positionals)
      })
      return
    default:
      throw new Error(
        'Usage: memrynote [--vault <path>] bookmarks list|get|get-by-item|list-by-type|add|toggle|remove|delete|has|reorder|bulk-create|bulk-delete'
      )
  }
}

export async function runSavedFilters(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'list':
      print(io, parsed.json, await app.savedFilters.list())
      return
    case 'get':
      print(
        io,
        parsed.json,
        await app.savedFilters.get(requireFirst(parsed.positionals, 'saved filter id'))
      )
      return
    case 'create':
      print(
        io,
        parsed.json,
        await app.savedFilters.create({
          name: requireFirst(parsed.positionals, 'saved filter name'),
          config: parseJsonFlag(parsed.flags, 'config') ?? {}
        })
      )
      return
    case 'update':
      print(
        io,
        parsed.json,
        await app.savedFilters.update(requireFirst(parsed.positionals, 'saved filter id'), {
          name: getFlag(parsed.flags, 'name'),
          config: parseJsonFlag(parsed.flags, 'config')
        })
      )
      return
    case 'reorder':
      print(
        io,
        parsed.json,
        await app.savedFilters.reorder(parsed.positionals, parsePositionFlags(parsed.flags))
      )
      return
    case 'delete':
      if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to delete a saved filter')
      print(io, parsed.json, {
        success: await app.savedFilters.delete(requireFirst(parsed.positionals, 'saved filter id'))
      })
      return
    default:
      throw new Error(
        'Usage: memrynote [--vault <path>] saved-filters list|get|create|update|reorder|delete'
      )
  }
}
