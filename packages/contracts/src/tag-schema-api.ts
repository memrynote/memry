/**
 * IPC surface of tag schemas: one snapshot, one command union, impact counts
 * and a progress event. Channels live in `TagsChannels` (ipc-channels.ts).
 */
import { z } from 'zod'
import { PRESET_KEYS, type FieldType, type PresetKey, type ResolvedTag } from './tag-schema'

export interface PresetOffer {
  key: PresetKey
  /** Localized, lowercase: the tag `add-preset` creates now. */
  name: string
  /** The catalogue's icon and colour, for the offer card and the @ create menu. */
  icon: string | null
  color: string
  fields: Array<{ name: string; type: FieldType; relationTarget: string | null }>
  templateSections: string[]
  /** `added`: a tag carries this preset; `add-fields`: a tag named `name` exists without it. */
  state: 'add' | 'add-fields' | 'added'
  existingTag: { key: string; usage: number } | null
  /** Relation-target tags the same step creates ("Also adds #company"). */
  alsoAdds: string[]
}

export interface TagSchemaSnapshot {
  /** Lowercase tag key to its resolved schema; only tags with a schema. */
  tags: Record<string, ResolvedTag>
  /** Note id to its primary object tag key. */
  objects: Record<string, string>
  presets: PresetOffer[]
  /** Local data.db setting `tagFields.presetOfferDismissed`. */
  presetStripDismissed: boolean
}

const TagName = z.string().trim().min(1).max(50)
const FieldName = z.string().trim().min(1).max(200)

export const RelationConfigSchema = z.object({
  target: TagName.nullable(),
  many: z.boolean(),
  inverse: z.string().trim().max(100).nullable()
})

/** Field types a new field may get. `project` never; a new property type value never. */
export const NEW_FIELD_TYPES = [
  'text',
  'number',
  'checkbox',
  'date',
  'url',
  'status',
  'select',
  'multiselect',
  'relation'
] as const

export const NewFieldSpecSchema = z.object({
  name: FieldName,
  /** Ignored when a property definition of this name exists: the vault-wide type wins. */
  type: z.enum(NEW_FIELD_TYPES),
  options: z.array(z.object({ value: z.string(), color: z.string() })).optional(),
  /** Required when `type` is `relation`. */
  relation: RelationConfigSchema.optional()
})
export type NewFieldSpec = z.infer<typeof NewFieldSpecSchema>

export const TagSchemaCommandSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('add-field'),
    tag: TagName,
    field: NewFieldSpecSchema,
    index: z.number().int().min(0).optional()
  }),
  z.object({
    kind: z.literal('set-relation'),
    tag: TagName,
    name: FieldName,
    relation: RelationConfigSchema
  }),
  z.object({ kind: z.literal('remove-field'), tag: TagName, name: FieldName }),
  z.object({
    kind: z.literal('move-field'),
    tag: TagName,
    name: FieldName,
    toIndex: z.number().int().min(0)
  }),
  z.object({
    kind: z.literal('set-template'),
    tag: TagName,
    template: z.object({ id: z.string().min(1), autofill: z.boolean() }).nullable()
  }),
  z.object({ kind: z.literal('set-extends'), tag: TagName, parent: TagName.nullable() }),
  /** Without `tag`: the localized default name, merged into an existing tag of that name. */
  z.object({ kind: z.literal('add-preset'), preset: z.enum(PRESET_KEYS), tag: TagName.optional() }),
  /** Vault-wide: a field name is a property key. Emits `tags:progress`; re-running resumes. */
  z.object({
    kind: z.literal('rename-field'),
    from: FieldName,
    to: FieldName,
    runId: z.string().min(1).max(100)
  }),
  z.object({ kind: z.literal('dismiss-preset-offer') })
])
export type TagSchemaCommand = z.infer<typeof TagSchemaCommandSchema>

export interface FieldRenameResult {
  notes: number
  tasks: number
  skippedLocked: number
  /** Notes that already had a value under the new name, left as they were. */
  skippedExisting: number
}

export interface TagSchemaCommandResult {
  snapshot: TagSchemaSnapshot
  /** The tag `add-preset` wrote. */
  tag?: string
  rename?: FieldRenameResult
}

export interface TagsProgressEvent {
  runId: string
  done: number
  total: number
}

export const ImpactQuerySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('remove-field'), tag: TagName, name: FieldName }),
  z.object({ kind: z.literal('rename-field'), name: FieldName }),
  z.object({ kind: z.literal('delete-tag'), tag: TagName }),
  z.object({ kind: z.literal('set-extends'), tag: TagName, parent: TagName.nullable() }),
  /** A2: header carriers of a tag that become objects once it has fields. */
  z.object({ kind: z.literal('become-objects'), tag: TagName })
])
export type ImpactQuery = z.infer<typeof ImpactQuerySchema>

export type ImpactResult =
  | { kind: 'remove-field'; filled: number; empty: number }
  | { kind: 'rename-field'; notes: number; tasks: number; tags: string[] }
  | {
      kind: 'delete-tag'
      notes: number
      tasks: number
      values: number
      fields: number
      templateName: string | null
    }
  | { kind: 'set-extends'; notes: number; gained: string[]; lost: string[] }
  | { kind: 'become-objects'; notes: number }
