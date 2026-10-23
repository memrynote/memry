/**
 * `tags` subcommands for tags with fields: schema, impact, objects,
 * linked-here, categories, icon, pin and reorder. `runTags` in run.ts hands
 * every subcommand it does not own to `runTagFields`.
 */
import type { MemryApp } from '../app-core/memry-app.ts'
import type { ImpactQuery } from '@memry/contracts/tag-schema-api'
import { NEW_FIELD_TYPES, type TagFieldInput, type TagSchemaEdit } from '../app-core/tag-schema.ts'
import {
  getFlag,
  hasFlag,
  parseNumber,
  print,
  requireFirst,
  type CliIo,
  type ParsedCli
} from '../run.ts'

const NEEDS_DESKTOP = ' It needs the Memry desktop app.'

const SCHEMA_VERBS = [
  'show',
  'add-field',
  'remove-field',
  'rename-field',
  'move-field',
  'set-relation',
  'set-template',
  'set-extends',
  'add-preset'
] as const

function requireArg(values: string[], index: number, label: string): string {
  const value = values[index]
  if (!value) throw new Error(`Missing ${label}`)
  return value
}

function parseIndex(value: string, label: string): number {
  const index = Number(value)
  if (!Number.isInteger(index) || index < 0) throw new Error(`${label} must be a whole number`)
  return index
}

function relationFlags(flags: ParsedCli['flags']) {
  const target = getFlag(flags, 'target')
  if (!target || target === 'true') throw new Error('Pass --target <tag> for a relation field')
  const inverse = getFlag(flags, 'inverse')
  return {
    target,
    many: hasFlag(flags, 'many'),
    inverse: inverse && inverse !== 'true' ? inverse : null
  }
}

function buildFieldInput(parsed: ParsedCli, name: string): TagFieldInput {
  const type = getFlag(parsed.flags, 'type')
  if (!type || type === 'true') {
    throw new Error(`Pass --type <${NEW_FIELD_TYPES.join('|')}>`)
  }
  if (!(NEW_FIELD_TYPES as readonly string[]).includes(type)) {
    throw new Error(`Unknown field type: ${type}. Allowed: ${NEW_FIELD_TYPES.join(', ')}`)
  }
  const options = getFlag(parsed.flags, 'options')
  return {
    name,
    type: type as TagFieldInput['type'],
    ...(options && options !== 'true'
      ? {
          options: options
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean)
        }
      : {}),
    ...(type === 'relation' ? { relation: relationFlags(parsed.flags) } : {})
  }
}

async function runSchema(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  const [verb, ...args] = parsed.positionals
  const service = app.tagSchema
  const isVerb = (SCHEMA_VERBS as readonly string[]).includes(verb ?? '')

  if (!isVerb) {
    if (verb) {
      print(io, parsed.json, await service.schemaOf(verb))
      return
    }
    print(io, parsed.json, await service.snapshot())
    return
  }

  const edit = async (command: TagSchemaEdit) => print(io, parsed.json, await service.edit(command))

  switch (verb) {
    case 'show':
      print(io, parsed.json, await service.schemaOf(requireArg(args, 0, 'tag name')))
      return
    case 'add-field': {
      const index = getFlag(parsed.flags, 'index')
      await edit({
        kind: 'add-field',
        tag: requireArg(args, 0, 'tag name'),
        field: buildFieldInput(parsed, requireArg(args, 1, 'field name')),
        ...(index ? { index: parseIndex(index, '--index') } : {})
      })
      return
    }
    case 'remove-field': {
      const tag = requireArg(args, 0, 'tag name')
      const name = requireArg(args, 1, 'field name')
      if (!hasFlag(parsed.flags, 'yes')) {
        const impact = await service.impact({ kind: 'remove-field', tag, name })
        throw new Error(
          `Removing "${name}" from #${tag} leaves ${impact.kind === 'remove-field' ? impact.filled : 0} filled value(s) in place but hides them. Pass --yes to remove the field`
        )
      }
      await edit({ kind: 'remove-field', tag, name })
      return
    }
    case 'rename-field':
      throw new Error(
        `Renaming a field rewrites the property in every note and task, with progress and resume.${NEEDS_DESKTOP}`
      )
    case 'add-preset':
      throw new Error(`Presets create a localized tag and template.${NEEDS_DESKTOP}`)
    case 'move-field':
      await edit({
        kind: 'move-field',
        tag: requireArg(args, 0, 'tag name'),
        name: requireArg(args, 1, 'field name'),
        toIndex: parseIndex(requireArg(args, 2, 'index'), 'index')
      })
      return
    case 'set-relation':
      await edit({
        kind: 'set-relation',
        tag: requireArg(args, 0, 'tag name'),
        name: requireArg(args, 1, 'field name'),
        relation: relationFlags(parsed.flags)
      })
      return
    case 'set-template': {
      const template = requireArg(args, 1, 'template id (or "none")')
      await edit({
        kind: 'set-template',
        tag: requireArg(args, 0, 'tag name'),
        template:
          template === 'none' ? null : { id: template, autofill: hasFlag(parsed.flags, 'autofill') }
      })
      return
    }
    case 'set-extends': {
      const tag = requireArg(args, 0, 'tag name')
      const parentArg = requireArg(args, 1, 'parent tag (or "none")')
      const parent = parentArg === 'none' ? null : parentArg
      if (!hasFlag(parsed.flags, 'yes')) {
        const impact = await service.impact({ kind: 'set-extends', tag, parent })
        if (impact.kind === 'set-extends' && impact.lost.length > 0) {
          throw new Error(
            `This stops #${tag} inheriting: ${impact.lost.join(', ')}. Pass --yes to continue`
          )
        }
      }
      await edit({ kind: 'set-extends', tag, parent })
      return
    }
  }
}

async function runImpact(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  const [kind, ...args] = parsed.positionals
  let query: ImpactQuery
  switch (kind) {
    case 'remove-field':
      query = {
        kind,
        tag: requireArg(args, 0, 'tag name'),
        name: requireArg(args, 1, 'field name')
      }
      break
    case 'rename-field':
      query = { kind, name: requireArg(args, 0, 'field name') }
      break
    case 'delete-tag':
    case 'become-objects':
      query = { kind, tag: requireArg(args, 0, 'tag name') }
      break
    case 'set-extends': {
      const parent = requireArg(args, 1, 'parent tag (or "none")')
      query = {
        kind,
        tag: requireArg(args, 0, 'tag name'),
        parent: parent === 'none' ? null : parent
      }
      break
    }
    default:
      throw new Error(
        'Usage: memrynote tags impact remove-field|rename-field|delete-tag|set-extends|become-objects ...'
      )
  }
  print(io, parsed.json, await app.tagSchema.impact(query))
}

async function runCategories(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<void> {
  const [action = 'list', ...args] = parsed.positionals
  const categories = app.tagSchema.categories
  switch (action) {
    case 'list':
      print(io, parsed.json, await categories.list())
      return
    case 'create':
      print(io, parsed.json, await categories.create(requireArg(args, 0, 'category name')))
      return
    case 'rename':
      print(
        io,
        parsed.json,
        await categories.rename(requireArg(args, 0, 'category id'), requireArg(args, 1, 'new name'))
      )
      return
    case 'delete':
      if (!hasFlag(parsed.flags, 'yes')) {
        throw new Error('Pass --yes to delete a category (its tags become uncategorized)')
      }
      print(io, parsed.json, await categories.delete(requireArg(args, 0, 'category id')))
      return
    case 'reorder':
      print(io, parsed.json, await categories.reorder(args))
      return
    default:
      throw new Error('Usage: memrynote tags categories list|create|rename|delete|reorder')
  }
}

/** Returns false when `parsed.subcommand` is not a tag-fields subcommand. */
export async function runTagFields(app: MemryApp, parsed: ParsedCli, io: CliIo): Promise<boolean> {
  switch (parsed.subcommand) {
    case 'schema':
      await runSchema(app, parsed, io)
      return true
    case 'impact':
      await runImpact(app, parsed, io)
      return true
    case 'fill-status':
    case 'fill-fields':
      throw new Error(
        `Filling fields asks an AI model and needs the AI settings and disclosure from the desktop app.${NEEDS_DESKTOP}`
      )
    case 'objects': {
      const query = getFlag(parsed.flags, 'query')
      print(
        io,
        parsed.json,
        await app.tagSchema.objects({
          query: query && query !== 'true' ? query : '',
          ...(parsed.positionals[0] ? { tag: parsed.positionals[0] } : {}),
          limit: Math.min(Math.max(parseNumber(getFlag(parsed.flags, 'limit'), 12), 1), 50)
        })
      )
      return true
    }
    case 'linked-here':
      print(
        io,
        parsed.json,
        await app.tagSchema.linkedHere({
          noteId: requireFirst(parsed.positionals, 'note id'),
          limitPerGroup: Math.min(Math.max(parseNumber(getFlag(parsed.flags, 'limit'), 2), 1), 500)
        })
      )
      return true
    case 'categories':
      await runCategories(app, parsed, io)
      return true
    case 'set-icon': {
      const tag = requireFirst(parsed.positionals, 'tag name')
      const icon = parsed.positionals[1]
      if (!icon && !hasFlag(parsed.flags, 'clear')) {
        throw new Error('Pass an icon (an emoji or "icon:Name") or --clear')
      }
      print(io, parsed.json, await app.tagSchema.setIcon(tag, icon ?? null))
      return true
    }
    case 'pin':
    case 'unpin': {
      const tag = requireFirst(parsed.positionals, 'tag name')
      const noteId = requireArg(parsed.positionals, 1, 'note id')
      print(
        io,
        parsed.json,
        parsed.subcommand === 'pin'
          ? await app.tagSchema.pin(tag, noteId)
          : await app.tagSchema.unpin(tag, noteId)
      )
      return true
    }
    case 'reorder': {
      const category = getFlag(parsed.flags, 'category')
      print(
        io,
        parsed.json,
        await app.tagSchema.reorder({
          tags: parsed.positionals,
          ...(category ? { category: category === 'none' ? null : category } : {})
        })
      )
      return true
    }
    default:
      return false
  }
}
