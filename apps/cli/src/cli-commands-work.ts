import type { MemryApp } from './app-core/memry-app.ts'
import { runInboxExtras } from './commands/inbox.ts'
import { runProjectLinks, runTaskActivity } from './commands/project-links.ts'
import { runTagFields } from './commands/tag-fields.ts'
import { parseDurationFlag, parseFieldFlags } from './commands/task-fields.ts'
import {
  type CliIo,
  type ParsedCli,
  type TaskListOptions,
  getFlag,
  getFlagList,
  hasFlag,
  parseBooleanFlag,
  parseCliValue,
  parseNullableFlag,
  parseNumber,
  parsePositionFlags,
  print,
  requireFirst
} from './cli-support.ts'

export async function runTasks(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  if (await runTaskActivity(app, parsed, io)) return
  switch (parsed.subcommand) {
    case 'create':
      print(
        io,
        parsed.json,
        await app.tasks.create({
          title: requireFirst(parsed.positionals, 'task title'),
          description: getFlag(parsed.flags, 'description'),
          projectId: getFlag(parsed.flags, 'project') ?? undefined,
          statusId: parseNullableFlag(parsed.flags, 'status'),
          parentId: parseNullableFlag(parsed.flags, 'parent'),
          dueDate: getFlag(parsed.flags, 'due') ?? null,
          dueTime: getFlag(parsed.flags, 'due-time') ?? null,
          startDate: getFlag(parsed.flags, 'start') ?? null,
          repeatConfig: parsed.flags.has('repeat')
            ? parseCliValue(getFlag(parsed.flags, 'repeat') ?? 'null')
            : undefined,
          repeatFrom: parseNullableFlag(parsed.flags, 'repeat-from'),
          sourceNoteId: parseNullableFlag(parsed.flags, 'source-note'),
          priority: parseNumber(getFlag(parsed.flags, 'priority'), 0),
          tags: getFlagList(parsed.flags, 'tag'),
          linkedNoteIds: getFlagList(parsed.flags, 'link-note'),
          linkedCanvasIds: getFlagList(parsed.flags, 'link-canvas'),
          durationMinutes: parseDurationFlag(parsed.flags),
          fields: parseFieldFlags(parsed.flags)
        })
      )
      return
    case 'list':
      print(
        io,
        parsed.json,
        await app.tasks.list({
          includeCompleted: hasFlag(parsed.flags, 'completed'),
          includeArchived: hasFlag(parsed.flags, 'archived'),
          projectId: getFlag(parsed.flags, 'project'),
          statusId: parseNullableFlag(parsed.flags, 'status'),
          parentId: parseNullableFlag(parsed.flags, 'parent'),
          dueBefore: getFlag(parsed.flags, 'due-before'),
          dueAfter: getFlag(parsed.flags, 'due-after'),
          tags: getFlagList(parsed.flags, 'tag'),
          search: getFlag(parsed.flags, 'search'),
          sortBy: getFlag(parsed.flags, 'sort-by') as TaskListOptions['sortBy'],
          sortOrder: getFlag(parsed.flags, 'sort-order') as TaskListOptions['sortOrder'],
          limit: parsed.flags.has('limit')
            ? parseNumber(getFlag(parsed.flags, 'limit'), 100)
            : undefined,
          offset: parsed.flags.has('offset')
            ? parseNumber(getFlag(parsed.flags, 'offset'), 0)
            : undefined
        })
      )
      return
    case 'get':
      print(io, parsed.json, await app.tasks.get(requireFirst(parsed.positionals, 'task id')))
      return
    case 'update':
      print(
        io,
        parsed.json,
        await app.tasks.update(requireFirst(parsed.positionals, 'task id'), {
          title: getFlag(parsed.flags, 'title'),
          description: getFlag(parsed.flags, 'description'),
          projectId: getFlag(parsed.flags, 'project') ?? undefined,
          statusId: parseNullableFlag(parsed.flags, 'status'),
          parentId: parseNullableFlag(parsed.flags, 'parent'),
          dueDate: getFlag(parsed.flags, 'due') ?? undefined,
          dueTime: getFlag(parsed.flags, 'due-time') ?? undefined,
          startDate: getFlag(parsed.flags, 'start') ?? undefined,
          repeatConfig: parsed.flags.has('repeat')
            ? parseCliValue(getFlag(parsed.flags, 'repeat') ?? 'null')
            : undefined,
          repeatFrom: parseNullableFlag(parsed.flags, 'repeat-from'),
          sourceNoteId: parseNullableFlag(parsed.flags, 'source-note'),
          priority: parsed.flags.has('priority')
            ? parseNumber(getFlag(parsed.flags, 'priority'), 0)
            : undefined,
          tags: parsed.flags.has('tag') ? getFlagList(parsed.flags, 'tag') : undefined,
          linkedNoteIds: parsed.flags.has('link-note')
            ? getFlagList(parsed.flags, 'link-note')
            : undefined,
          linkedCanvasIds: parsed.flags.has('link-canvas')
            ? getFlagList(parsed.flags, 'link-canvas')
            : undefined,
          durationMinutes: parseDurationFlag(parsed.flags),
          fields: parseFieldFlags(parsed.flags)
        })
      )
      return
    case 'done':
    case 'complete':
      print(io, parsed.json, await app.tasks.complete(requireFirst(parsed.positionals, 'task id')))
      return
    case 'reopen':
      print(io, parsed.json, await app.tasks.reopen(requireFirst(parsed.positionals, 'task id')))
      return
    case 'archive':
      print(io, parsed.json, await app.tasks.archive(requireFirst(parsed.positionals, 'task id')))
      return
    case 'unarchive':
      print(io, parsed.json, await app.tasks.unarchive(requireFirst(parsed.positionals, 'task id')))
      return
    case 'move':
      print(
        io,
        parsed.json,
        await app.tasks.move(requireFirst(parsed.positionals, 'task id'), {
          projectId: getFlag(parsed.flags, 'project'),
          statusId: parseNullableFlag(parsed.flags, 'status'),
          parentId: parseNullableFlag(parsed.flags, 'parent'),
          position: parsed.flags.has('position')
            ? parseNumber(getFlag(parsed.flags, 'position'), 0)
            : undefined
        })
      )
      return
    case 'get-subtasks':
      print(
        io,
        parsed.json,
        await app.tasks.getSubtasks(requireFirst(parsed.positionals, 'task id'))
      )
      return
    case 'get-linked-tasks':
      print(
        io,
        parsed.json,
        await app.tasks.getLinkedTasks(requireFirst(parsed.positionals, 'note id'))
      )
      return
    case 'today':
      print(io, parsed.json, await app.tasks.today(getFlag(parsed.flags, 'date')))
      return
    case 'upcoming':
      print(
        io,
        parsed.json,
        await app.tasks.upcoming({
          days: parsed.flags.has('days')
            ? parseNumber(getFlag(parsed.flags, 'days'), 7)
            : undefined,
          fromDate: getFlag(parsed.flags, 'from')
        })
      )
      return
    case 'overdue':
      print(io, parsed.json, await app.tasks.overdue(getFlag(parsed.flags, 'date')))
      return
    case 'stats':
      print(io, parsed.json, await app.tasks.stats(getFlag(parsed.flags, 'date')))
      return
    case 'tags':
      print(io, parsed.json, await app.tasks.getTags())
      return
    case 'convert-to-subtask':
      print(
        io,
        parsed.json,
        await app.tasks.convertToSubtask(
          requireFirst(parsed.positionals, 'task id'),
          parsed.positionals[1] ?? ''
        )
      )
      return
    case 'convert-to-task':
      print(
        io,
        parsed.json,
        await app.tasks.convertToTask(requireFirst(parsed.positionals, 'task id'))
      )
      return
    case 'duplicate':
      print(io, parsed.json, await app.tasks.duplicate(requireFirst(parsed.positionals, 'task id')))
      return
    case 'bulk-done':
    case 'bulk-complete':
      print(io, parsed.json, { count: await app.tasks.bulkComplete(parsed.positionals) })
      return
    case 'bulk-archive':
      print(io, parsed.json, { count: await app.tasks.bulkArchive(parsed.positionals) })
      return
    case 'bulk-move': {
      const projectId = getFlag(parsed.flags, 'project')
      if (!projectId) throw new Error('Pass --project to bulk-move tasks')
      print(io, parsed.json, { count: await app.tasks.bulkMove(parsed.positionals, projectId) })
      return
    }
    case 'bulk-delete':
      if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to delete tasks')
      print(io, parsed.json, {
        count: await app.tasks.bulkDelete(parsed.positionals, {
          keepSubtasks: hasFlag(parsed.flags, 'keep-subtasks')
        })
      })
      return
    case 'reorder':
      print(io, parsed.json, {
        success: await app.tasks.reorder(parsed.positionals, parsePositionFlags(parsed.flags))
      })
      return
    case 'delete':
      if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to delete a task')
      print(io, parsed.json, {
        success: await app.tasks.delete(requireFirst(parsed.positionals, 'task id'), {
          keepSubtasks: hasFlag(parsed.flags, 'keep-subtasks')
        })
      })
      return
    default:
      throw new Error(
        'Usage: memrynote [--vault <path>] tasks create|list|get|update|done|reopen|archive|unarchive|move|get-subtasks|get-linked-tasks|today|upcoming|overdue|stats|tags|convert-to-subtask|convert-to-task|duplicate|bulk-done|bulk-archive|bulk-move|bulk-delete|reorder|delete|activity'
      )
  }
}

export async function runProjects(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  if (await runProjectLinks(app, parsed, io)) return
  switch (parsed.subcommand) {
    case 'list':
      print(io, parsed.json, await app.tasks.projects.list())
      return
    case 'get':
      print(
        io,
        parsed.json,
        await app.tasks.projects.get(requireFirst(parsed.positionals, 'project id'))
      )
      return
    case 'create':
      print(
        io,
        parsed.json,
        await app.tasks.projects.create({
          name: requireFirst(parsed.positionals, 'project name'),
          description: getFlag(parsed.flags, 'description'),
          color: getFlag(parsed.flags, 'color'),
          icon: getFlag(parsed.flags, 'icon') ?? null
        })
      )
      return
    case 'update':
      print(
        io,
        parsed.json,
        await app.tasks.projects.update(requireFirst(parsed.positionals, 'project id'), {
          name: getFlag(parsed.flags, 'name'),
          description: getFlag(parsed.flags, 'description'),
          color: getFlag(parsed.flags, 'color'),
          icon: getFlag(parsed.flags, 'icon') ?? undefined
        })
      )
      return
    case 'archive':
      print(
        io,
        parsed.json,
        await app.tasks.projects.archive(requireFirst(parsed.positionals, 'project id'))
      )
      return
    case 'unarchive':
      print(
        io,
        parsed.json,
        await app.tasks.projects.unarchive(requireFirst(parsed.positionals, 'project id'))
      )
      return
    case 'delete':
      if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to delete a project')
      print(io, parsed.json, {
        success: await app.tasks.projects.delete(requireFirst(parsed.positionals, 'project id'))
      })
      return
    case 'reorder':
      print(io, parsed.json, {
        success: await app.tasks.projects.reorder(
          parsed.positionals,
          parsePositionFlags(parsed.flags)
        )
      })
      return
    case 'statuses':
      print(
        io,
        parsed.json,
        await app.tasks.projects.statuses(requireFirst(parsed.positionals, 'project id'))
      )
      return
    case 'status-create':
      print(
        io,
        parsed.json,
        await app.tasks.projects.createStatus(requireFirst(parsed.positionals, 'project id'), {
          name: parsed.positionals[1] ?? '',
          color: getFlag(parsed.flags, 'color'),
          isDone: parseBooleanFlag(parsed.flags, 'done')
        })
      )
      return
    case 'status-update':
      print(
        io,
        parsed.json,
        await app.tasks.projects.updateStatus(requireFirst(parsed.positionals, 'status id'), {
          name: getFlag(parsed.flags, 'name'),
          color: getFlag(parsed.flags, 'color'),
          position: parsed.flags.has('position')
            ? parseNumber(getFlag(parsed.flags, 'position'), 0)
            : undefined,
          isDefault: parseBooleanFlag(parsed.flags, 'default'),
          isDone: parseBooleanFlag(parsed.flags, 'done')
        })
      )
      return
    case 'status-delete':
      if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to delete a status')
      print(io, parsed.json, {
        success: await app.tasks.projects.deleteStatus(
          requireFirst(parsed.positionals, 'status id')
        )
      })
      return
    case 'status-reorder':
      print(io, parsed.json, {
        success: await app.tasks.projects.reorderStatuses(
          parsed.positionals,
          parsePositionFlags(parsed.flags)
        )
      })
      return
    default:
      throw new Error(
        'Usage: memrynote [--vault <path>] projects list|get|create|update|archive|unarchive|delete|reorder|statuses|status-create|status-update|status-delete|status-reorder|link|unlink|links|for-item|pin|unpin|contents|set-home-note|capture-url|import-files'
      )
  }
}

export async function runInbox(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'capture':
      print(
        io,
        parsed.json,
        await app.inbox.captureText({
          title: getFlag(parsed.flags, 'title'),
          content: requireFirst(parsed.positionals, 'inbox content'),
          tags: getFlagList(parsed.flags, 'tag')
        })
      )
      return
    case 'capture-link':
      print(
        io,
        parsed.json,
        await app.inbox.captureLink({
          url: requireFirst(parsed.positionals, 'inbox URL'),
          tags: getFlagList(parsed.flags, 'tag')
        })
      )
      return
    case 'capture-file':
      print(
        io,
        parsed.json,
        await app.inbox.captureFile({
          filePath: requireFirst(parsed.positionals, 'inbox file path'),
          mimeType: getFlag(parsed.flags, 'mime'),
          title: getFlag(parsed.flags, 'title'),
          tags: getFlagList(parsed.flags, 'tag')
        })
      )
      return
    case 'get':
      print(io, parsed.json, await app.inbox.get(requireFirst(parsed.positionals, 'inbox item id')))
      return
    case 'list':
      print(
        io,
        parsed.json,
        await app.inbox.list({
          includeArchived: hasFlag(parsed.flags, 'archived'),
          includeSnoozed: hasFlag(parsed.flags, 'include-snoozed')
        })
      )
      return
    case 'tags':
      print(io, parsed.json, await app.inbox.tags())
      return
    case 'stats':
      print(io, parsed.json, await app.inbox.stats())
      return
    case 'patterns':
      print(io, parsed.json, await app.inbox.patterns())
      return
    case 'archived':
      print(
        io,
        parsed.json,
        await app.inbox.archived({
          search: getFlag(parsed.flags, 'search'),
          limit: parseNumber(getFlag(parsed.flags, 'limit'), 50),
          offset: parseNumber(getFlag(parsed.flags, 'offset'), 0)
        })
      )
      return
    case 'filing-history':
      print(
        io,
        parsed.json,
        await app.inbox.filingHistory({
          limit: parseNumber(getFlag(parsed.flags, 'limit'), 20)
        })
      )
      return
    case 'stale-threshold':
      print(io, parsed.json, await app.inbox.getStaleThreshold())
      return
    case 'set-stale-threshold':
      print(
        io,
        parsed.json,
        await app.inbox.setStaleThreshold(
          parseNumber(requireFirst(parsed.positionals, 'stale threshold days'), 7)
        )
      )
      return
    case 'update':
      print(
        io,
        parsed.json,
        await app.inbox.update(requireFirst(parsed.positionals, 'inbox item id'), {
          title: getFlag(parsed.flags, 'title'),
          content: getFlag(parsed.flags, 'content')
        })
      )
      return
    case 'add-tag':
      print(
        io,
        parsed.json,
        await app.inbox.addTag(
          requireFirst(parsed.positionals, 'inbox item id'),
          parsed.positionals[1] ?? ''
        )
      )
      return
    case 'remove-tag':
      print(
        io,
        parsed.json,
        await app.inbox.removeTag(
          requireFirst(parsed.positionals, 'inbox item id'),
          parsed.positionals[1] ?? ''
        )
      )
      return
    case 'mark-viewed':
      print(
        io,
        parsed.json,
        await app.inbox.markViewed(requireFirst(parsed.positionals, 'inbox item id'))
      )
      return
    case 'convert-note':
      print(
        io,
        parsed.json,
        await app.inbox.convertToNote(requireFirst(parsed.positionals, 'inbox item id'))
      )
      return
    case 'convert-task':
      print(
        io,
        parsed.json,
        await app.inbox.convertToTask(requireFirst(parsed.positionals, 'inbox item id'))
      )
      return
    case 'link-note':
      print(
        io,
        parsed.json,
        await app.inbox.linkToNote(
          requireFirst(parsed.positionals, 'inbox item id'),
          parsed.positionals[1] ?? '',
          getFlagList(parsed.flags, 'tag')
        )
      )
      return
    case 'snooze':
      print(
        io,
        parsed.json,
        await app.inbox.snooze(
          requireFirst(parsed.positionals, 'inbox item id'),
          getFlag(parsed.flags, 'until') ?? '',
          getFlag(parsed.flags, 'reason')
        )
      )
      return
    case 'unsnooze':
      print(
        io,
        parsed.json,
        await app.inbox.unsnooze(requireFirst(parsed.positionals, 'inbox item id'))
      )
      return
    case 'snoozed':
      print(io, parsed.json, await app.inbox.snoozed())
      return
    case 'bulk-tag':
      print(
        io,
        parsed.json,
        await app.inbox.bulkTag(parsed.positionals, getFlagList(parsed.flags, 'tag'))
      )
      return
    case 'bulk-snooze':
      print(
        io,
        parsed.json,
        await app.inbox.bulkSnooze(
          parsed.positionals,
          getFlag(parsed.flags, 'until') ?? '',
          getFlag(parsed.flags, 'reason')
        )
      )
      return
    case 'bulk-archive':
      print(io, parsed.json, await app.inbox.bulkArchive(parsed.positionals))
      return
    case 'archive':
      print(
        io,
        parsed.json,
        await app.inbox.archive(requireFirst(parsed.positionals, 'inbox item id'))
      )
      return
    case 'unarchive':
      print(
        io,
        parsed.json,
        await app.inbox.unarchive(requireFirst(parsed.positionals, 'inbox item id'))
      )
      return
    case 'delete':
      if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to delete an inbox item')
      print(io, parsed.json, {
        success: await app.inbox.deletePermanent(requireFirst(parsed.positionals, 'inbox item id'))
      })
      return
    default:
      if (await runInboxExtras(app, parsed, io)) return
      throw new Error(
        'Usage: memrynote [--vault <path>] inbox capture|capture-link|capture-file|get|list|tags|stats|patterns|archived|filing-history|stale-threshold|set-stale-threshold|update|add-tag|remove-tag|mark-viewed|convert-note|convert-task|link-note|snooze|unsnooze|snoozed|bulk-tag|bulk-snooze|bulk-archive|archive|unarchive|delete|file|bulk-file|file-all-stale|convert-event|convert-reminder|suggestions|undo|capture-image|capture-pdf|capture-voice|jobs|retry'
      )
  }
}

export async function runJournal(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'get':
      print(
        io,
        parsed.json,
        await app.journal.get(requireFirst(parsed.positionals, 'journal date'))
      )
      return
    case 'write':
      print(
        io,
        parsed.json,
        await app.journal.write(
          requireFirst(parsed.positionals, 'journal date'),
          parsed.positionals[1] ?? ''
        )
      )
      return
    case 'append':
      print(
        io,
        parsed.json,
        await app.journal.append(
          requireFirst(parsed.positionals, 'journal date'),
          parsed.positionals[1] ?? ''
        )
      )
      return
    case 'delete':
      if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to delete a journal entry')
      print(io, parsed.json, {
        success: await app.journal.delete(requireFirst(parsed.positionals, 'journal date'))
      })
      return
    case 'month':
      print(
        io,
        parsed.json,
        await app.journal.month(
          parseNumber(requireFirst(parsed.positionals, 'journal year'), 0),
          parseNumber(parsed.positionals[1], 0)
        )
      )
      return
    case 'heatmap':
      print(
        io,
        parsed.json,
        await app.journal.heatmap(parseNumber(requireFirst(parsed.positionals, 'journal year'), 0))
      )
      return
    case 'stats':
      print(
        io,
        parsed.json,
        await app.journal.yearStats(
          parseNumber(requireFirst(parsed.positionals, 'journal year'), 0)
        )
      )
      return
    case 'context':
      print(
        io,
        parsed.json,
        await app.journal.dayContext(requireFirst(parsed.positionals, 'journal date'))
      )
      return
    case 'tags':
      print(io, parsed.json, await app.journal.allTags())
      return
    case 'streak':
      print(io, parsed.json, await app.journal.streak())
      return
    case 'properties': {
      const from = requireFirst(parsed.positionals, 'from date (YYYY-MM-DD)')
      print(io, parsed.json, await app.journal.properties(from, parsed.positionals[1] ?? from))
      return
    }
    default:
      throw new Error(
        'Usage: memrynote [--vault <path>] journal get|write|append|delete|month|heatmap|stats|context|tags|streak|properties'
      )
  }
}

export async function runTags(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  switch (parsed.subcommand) {
    case 'list':
      print(io, parsed.json, await app.tags.list())
      return
    case 'notes':
      print(io, parsed.json, await app.tags.notes(requireFirst(parsed.positionals, 'tag name')))
      return
    case 'color':
    case 'set-color':
      print(
        io,
        parsed.json,
        await app.tags.setColor(
          requireFirst(parsed.positionals, 'tag name'),
          getFlag(parsed.flags, 'color') ?? parsed.positionals[1] ?? ''
        )
      )
      return
    case 'rename':
      print(
        io,
        parsed.json,
        await app.tags.rename(
          requireFirst(parsed.positionals, 'old tag name'),
          parsed.positionals[1] ?? ''
        )
      )
      return
    case 'remove-from-note':
      print(
        io,
        parsed.json,
        await app.tags.removeFromNote(
          requireFirst(parsed.positionals, 'note id'),
          parsed.positionals[1] ?? ''
        )
      )
      return
    case 'merge':
      print(
        io,
        parsed.json,
        await app.tags.merge(
          requireFirst(parsed.positionals, 'source tag'),
          parsed.positionals[1] ?? ''
        )
      )
      return
    case 'delete':
      if (!hasFlag(parsed.flags, 'yes')) throw new Error('Pass --yes to delete a tag')
      print(io, parsed.json, {
        success: await app.tags.delete(requireFirst(parsed.positionals, 'tag name'))
      })
      return
    default:
      if (await runTagFields(app, parsed, io)) return
      throw new Error(
        'Usage: memrynote [--vault <path>] tags list|notes|color|rename|remove-from-note|merge|delete|schema|impact|objects|linked-here|categories|set-icon|pin|unpin|reorder|fill-status|fill-fields'
      )
  }
}
