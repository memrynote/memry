import type { PresetKey } from '@memry/contracts/tag-schema'
import type { TagSchemaCommand, TagSchemaCommandResult } from '@memry/contracts/tag-schema-api'
import { notesService } from '@/services/notes-service'

export interface CreatedObject {
  id: string
  title: string
}

export async function createObject(args: {
  title: string
  tag: string
  properties?: Record<string, unknown>
}): Promise<CreatedObject> {
  const result = await notesService.create({
    title: args.title,
    content: '',
    tags: [args.tag],
    ...(args.properties && { properties: args.properties })
  })
  if (!result.success || !result.note) throw new Error(result.error ?? 'create failed')
  return { id: result.note.id, title: result.note.title }
}

export async function addPresetTag(
  edit: (command: TagSchemaCommand) => Promise<TagSchemaCommandResult>,
  preset: PresetKey
): Promise<string> {
  const result = await edit({ kind: 'add-preset', preset })
  const tag = result.tag ?? result.snapshot.presets.find((offer) => offer.key === preset)?.name
  if (!tag) throw new Error('preset not added')
  return tag.toLowerCase()
}

const LAST_TAG_KEY = 'memry:mention-create-last-tag'

export const lastCreateTag = {
  get(): string | null {
    try {
      return localStorage.getItem(LAST_TAG_KEY)
    } catch {
      return null
    }
  },
  set(tag: string): void {
    try {
      localStorage.setItem(LAST_TAG_KEY, tag)
    } catch {
      // Storage full or blocked: the order just falls back to the default.
    }
  }
}
