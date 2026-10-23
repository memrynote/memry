/**
 * `projects` subcommands for linked items (link, unlink, links, for-item, pin,
 * unpin, contents, set-home-note, capture-url, import-files) and `tasks activity`.
 * `runProjects` and `runTasks` in run.ts hand every subcommand they do not own
 * to these; each returns true when it handled the subcommand.
 */
import type { MemryApp } from '../app-core/memry-app.ts'
import {
  type ProjectLinkInput,
  type ProjectLinkItemType,
  type ProjectLinkResult
} from '../app-core/project-links.ts'
import {
  getFlag,
  getFlagList,
  hasFlag,
  parseNumber,
  print,
  requireFirst,
  type CliIo,
  type ParsedCli
} from '../run.ts'

const ITEM_FLAGS: Record<string, ProjectLinkItemType> = {
  note: 'note',
  file: 'file',
  event: 'calendar_event'
}

const CONTENT_TYPES = ['note', 'file', 'event'] as const

function itemFromFlags(parsed: ParsedCli): { itemType: ProjectLinkItemType; itemId: string } {
  const given = Object.keys(ITEM_FLAGS).filter((flag) => hasFlag(parsed.flags, flag))
  if (given.length !== 1) {
    throw new Error('Pass exactly one of --note <id>, --file <id> or --event <id>')
  }
  const itemId = getFlag(parsed.flags, given[0])
  if (!itemId || itemId === 'true') throw new Error(`Missing id for --${given[0]}`)
  return { itemType: ITEM_FLAGS[given[0]], itemId }
}

function linkInput(parsed: ParsedCli): ProjectLinkInput {
  return {
    projectId: requireFirst(parsed.positionals, 'project id'),
    ...itemFromFlags(parsed)
  }
}

function succeed(result: ProjectLinkResult): void {
  if (!result.success) throw new Error(result.error ?? 'Project link operation failed')
}

function contentTypes(parsed: ParsedCli): Set<(typeof CONTENT_TYPES)[number]> | null {
  const requested = getFlagList(parsed.flags, 'type').flatMap((value) => value.split(','))
  if (requested.length === 0) return null
  const types = new Set<(typeof CONTENT_TYPES)[number]>()
  for (const raw of requested) {
    const type = raw.trim()
    if (!(CONTENT_TYPES as readonly string[]).includes(type)) {
      throw new Error(`Invalid --type: ${type}. Use ${CONTENT_TYPES.join(', ')}`)
    }
    types.add(type as (typeof CONTENT_TYPES)[number])
  }
  return types
}

export async function runProjectLinks(
  app: MemryApp,
  parsed: ParsedCli,
  io: CliIo
): Promise<boolean> {
  switch (parsed.subcommand) {
    case 'link': {
      succeed(
        await app.projectLinks.link(linkInput(parsed), { pinned: hasFlag(parsed.flags, 'pin') })
      )
      print(io, parsed.json, { success: true })
      return true
    }
    case 'unlink': {
      succeed(await app.projectLinks.unlink(linkInput(parsed)))
      print(io, parsed.json, { success: true })
      return true
    }
    case 'links':
      print(
        io,
        parsed.json,
        await app.projectLinks.list(requireFirst(parsed.positionals, 'project id'))
      )
      return true
    case 'for-item': {
      const { itemType, itemId } = itemFromFlags(parsed)
      print(io, parsed.json, await app.projectLinks.forItem(itemType, itemId))
      return true
    }
    case 'pin':
    case 'unpin': {
      succeed(
        await app.projectLinks.setPinned(
          requireFirst(parsed.positionals, 'project id'),
          requireFirst(parsed.positionals.slice(1), 'item id'),
          parsed.subcommand === 'pin'
        )
      )
      print(io, parsed.json, { success: true })
      return true
    }
    case 'contents': {
      const projectId = requireFirst(parsed.positionals, 'project id')
      if (!(await app.tasks.projects.get(projectId))) throw new Error('Project not found')
      const contents = await app.projectLinks.contents(projectId)
      const types = contentTypes(parsed)
      print(
        io,
        parsed.json,
        types
          ? {
              notes: types.has('note') ? contents.notes : [],
              files: types.has('file') ? contents.files : [],
              events: types.has('event') ? contents.events : [],
              counts: {
                notes: types.has('note') ? contents.counts.notes : 0,
                files: types.has('file') ? contents.counts.files : 0,
                events: types.has('event') ? contents.counts.events : 0
              }
            }
          : contents
      )
      return true
    }
    case 'set-home-note': {
      const noteId = requireFirst(parsed.positionals.slice(1), 'note id (or null to clear)')
      const result = await app.projectLinks.setHomeNote(
        requireFirst(parsed.positionals, 'project id'),
        noteId === 'null' ? null : noteId
      )
      succeed(result)
      print(io, parsed.json, await app.tasks.projects.get(parsed.positionals[0]))
      return true
    }
    case 'capture-url': {
      const result = await app.projectLinks.captureUrl(
        requireFirst(parsed.positionals, 'project id'),
        requireFirst(parsed.positionals.slice(1), 'url')
      )
      if (!result.success) throw new Error(result.error ?? 'Failed to capture URL')
      print(io, parsed.json, result)
      return true
    }
    case 'import-files': {
      const projectId = requireFirst(parsed.positionals, 'project id')
      const sourcePaths = parsed.positionals.slice(1)
      if (sourcePaths.length === 0) throw new Error('Missing file paths')
      const result = await app.projectLinks.importFiles(
        projectId,
        sourcePaths,
        getFlag(parsed.flags, 'folder')
      )
      print(io, parsed.json, result)
      if (!result.success) throw new Error(`Failed to link ${result.failed.length} file(s)`)
      return true
    }
    default:
      return false
  }
}

export async function runTaskActivity(
  app: MemryApp,
  parsed: ParsedCli,
  io: CliIo
): Promise<boolean> {
  if (parsed.subcommand !== 'activity') return false
  print(
    io,
    parsed.json,
    await app.taskActivity.list({
      taskId: requireFirst(parsed.positionals, 'task id'),
      limit: parsed.flags.has('limit')
        ? parseNumber(getFlag(parsed.flags, 'limit'), 50)
        : undefined,
      offset: parsed.flags.has('offset')
        ? parseNumber(getFlag(parsed.flags, 'offset'), 0)
        : undefined,
      actions: getFlagList(parsed.flags, 'action')
    })
  )
  return true
}
