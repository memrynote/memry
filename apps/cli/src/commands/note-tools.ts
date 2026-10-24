/**
 * `notes`, `folders` and `properties` subcommands that bring the CLI level with
 * desktop's note tools: aliases, multi-title resolve, apply-template, unlinked
 * mentions, carried tasks, sidebar order, folder templates, large-file reads,
 * attachment rename / vault-wide listing / `--existing` / `--url`, property
 * options, property merge and ref resolution, and calendar property flags.
 *
 * Each `run*Tools` returns `true` when it handled the command, so the matching
 * `run*` in run.ts only keeps the commands that predate it.
 */
import type { MemryApp } from '../app-core/memry-app.ts'
import {
  getFlag,
  getFlagList,
  hasFlag,
  parseNumber,
  print,
  requireFirst,
  type CliIo,
  type ParsedCli
} from '../cli-support.ts'

const NEEDS_EMBEDDINGS =
  ' It reads the on-device embeddings index, which only the Memry desktop app builds and queries.'

function parseBoolean(value: string | undefined, label: string): boolean {
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${label} must be true or false`)
}

function parseJsonObject(value: string | undefined, label: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value ?? '')
  } catch {
    throw new Error(`${label} must be a JSON object`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`)
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- boundary value (JSON, SQL row or test double) whose shape the producer fixes
  return parsed as Record<string, unknown>
}

export async function runNoteTools(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<boolean> {
  const { positionals, flags, json } = parsed
  const tools = app.noteTools

  switch (parsed.subcommand) {
    case 'aliases': {
      const idOrPath = requireFirst(positionals, 'note id or path')
      const set = getFlagList(flags, 'set')
      print(
        io,
        json,
        await tools.aliases(idOrPath, {
          add: getFlagList(flags, 'add'),
          remove: getFlagList(flags, 'remove'),
          set: hasFlag(flags, 'clear') ? [] : set.length > 0 ? set : undefined
        })
      )
      return true
    }
    case 'resolve':
      // One title keeps its original, heading-aware shape; several answer like
      // desktop's resolve-titles: an object keyed by title.
      if (positionals.length < 2) return false
      print(io, json, await tools.resolveTitles(positionals))
      return true
    case 'apply-template':
      print(
        io,
        json,
        await tools.applyTemplate(
          requireFirst(positionals, 'note id or path'),
          positionals[1] ?? '',
          hasFlag(flags, 'body-only') ? 'body' : 'full'
        )
      )
      return true
    case 'unlinked-mentions':
      print(io, json, await tools.unlinkedMentions(requireFirst(positionals, 'note id or path')))
      return true
    case 'link-mention':
      print(
        io,
        json,
        await tools.linkMention({
          sourceId: requireFirst(positionals, 'source note id'),
          targetId: positionals[1] ?? '',
          ordinal: parseNumber(getFlag(flags, 'ordinal'), 0)
        })
      )
      return true
    case 'carried-tasks':
      print(
        io,
        json,
        await tools.carriedTasks({
          noteIds: positionals,
          folderPaths: getFlagList(flags, 'folder')
        })
      )
      return true
    case 'similar':
      throw new Error(`Similar notes are not available from the CLI.${NEEDS_EMBEDDINGS}`)
    case 'suggest-tags':
      throw new Error(`Tag suggestions are not available from the CLI.${NEEDS_EMBEDDINGS}`)
    case 'positions':
      print(io, json, await tools.positions(getFlag(flags, 'folder')))
      return true
    case 'reorder':
      print(io, json, await tools.reorder(getFlag(flags, 'folder') ?? '', positionals))
      return true
    case 'read-lines':
      print(
        io,
        json,
        await tools.readLines(
          requireFirst(positionals, 'note id or path'),
          parseNumber(getFlag(flags, 'from'), 0),
          parseNumber(getFlag(flags, 'count'), 200)
        )
      )
      return true
    case 'grep':
      print(
        io,
        json,
        await tools.grep(requireFirst(positionals, 'note id or path'), positionals[1] ?? '')
      )
      return true
    case 'attachment-rename':
      print(
        io,
        json,
        await app.attachmentTools.rename(
          requireFirst(positionals, 'note id'),
          positionals[1] ?? '',
          positionals.slice(2).join(' ')
        )
      )
      return true
    case 'attachments':
      if (!hasFlag(flags, 'all')) return false
      print(io, json, await app.attachmentTools.listVault())
      return true
    case 'attach': {
      const existing = getFlag(flags, 'existing')
      const url = getFlag(flags, 'url')
      if (existing === undefined && url === undefined) return false
      if (existing !== undefined && url !== undefined) {
        throw new Error('Use --existing or --url, not both')
      }
      const noteId = requireFirst(positionals, 'note id')
      if (url !== undefined) {
        print(io, json, await app.attachmentTools.attachUrl(noteId, url))
        return true
      }
      const slash = (existing ?? '').indexOf('/')
      if (slash <= 0 || slash === (existing ?? '').length - 1) {
        throw new Error('--existing takes <owner-note-id>/<stored-filename>')
      }
      print(
        io,
        json,
        await app.attachmentTools.attachExisting(
          noteId,
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- boundary value (JSON, SQL row or test double) whose shape the producer fixes
          (existing as string).slice(0, slash),
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- boundary value (JSON, SQL row or test double) whose shape the producer fixes
          (existing as string).slice(slash + 1)
        )
      )
      return true
    }
    default:
      return false
  }
}

export async function runFolderTools(
  app: MemryApp,
  parsed: ParsedCli,
  io: CliIo
): Promise<boolean> {
  if (parsed.subcommand !== 'template') return false
  const { positionals, flags, json } = parsed
  const folder = requireFirst(positionals, 'folder path (use . for the vault root)')
  const templateId = positionals[1]
  if (hasFlag(flags, 'clear')) {
    print(io, json, await app.noteTools.setFolderTemplate(folder, null))
  } else if (templateId) {
    print(io, json, await app.noteTools.setFolderTemplate(folder, templateId))
  } else {
    print(io, json, await app.noteTools.getFolderTemplate(folder))
  }
  return true
}

export async function runPropertyTools(
  app: MemryApp,
  parsed: ParsedCli,
  io: CliIo
): Promise<boolean> {
  const { positionals, flags, json } = parsed
  const tools = app.propertyTools

  switch (parsed.subcommand) {
    case 'ensure':
      print(
        io,
        json,
        await tools.ensureDefinition(
          requireFirst(positionals, 'property name'),
          positionals[1] ?? ''
        )
      )
      return true
    case 'option-add':
      print(
        io,
        json,
        await tools.addOption(
          requireFirst(positionals, 'property name'),
          { value: positionals[1] ?? '', color: getFlag(flags, 'color') },
          getFlag(flags, 'category')
        )
      )
      return true
    case 'option-remove':
      if (!hasFlag(flags, 'yes')) throw new Error('Pass --yes to remove a property option')
      print(
        io,
        json,
        await tools.removeOption(requireFirst(positionals, 'property name'), positionals[1] ?? '')
      )
      return true
    case 'option-rename':
      print(
        io,
        json,
        await tools.renameOption(
          requireFirst(positionals, 'property name'),
          positionals[1] ?? '',
          positionals[2] ?? ''
        )
      )
      return true
    case 'option-color':
      print(
        io,
        json,
        await tools.setOptionColor(
          requireFirst(positionals, 'property name'),
          positionals[1] ?? '',
          positionals[2] ?? ''
        )
      )
      return true
    case 'merge':
      print(
        io,
        json,
        await tools.merge(
          requireFirst(positionals, 'entity id'),
          parseJsonObject(positionals[1], 'values')
        )
      )
      return true
    case 'resolve-refs':
      if (positionals.length === 0) throw new Error('Missing relation URIs (memry://<kind>/<id>)')
      print(io, json, await tools.resolveRefs(positionals))
      return true
    case 'calendar-names':
      print(io, json, await tools.calendarNames())
      return true
    case 'calendar-visibility':
      print(
        io,
        json,
        await tools.setCalendarVisibility(
          requireFirst(positionals, 'property name'),
          parseBoolean(positionals[1], 'visibility')
        )
      )
      return true
    default:
      return false
  }
}
