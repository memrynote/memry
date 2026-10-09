/**
 * Pure tag-schema model: parse the stored column, resolve every schema with
 * `extends`, and apply one edit. No database, no clock; the service in
 * `tags/schema/` owns reads and writes.
 */
import {
  EMPTY_TAG_SCHEMA_BODY,
  TagSchemaWire,
  isPresetKey,
  isReservedFieldName,
  rewriteSchemaReference,
  type FieldType,
  type PresetKey,
  type RelationConfig,
  type ResolvedField,
  type ResolvedTag,
  type TagFieldStored,
  type TagSchemaStored
} from '@memry/contracts/tag-schema'
import type { PropertyType, SelectOption } from '@memry/contracts/property-types'
import { canonicalJson, stampVersionedValue, type VersionedObject } from '@memry/shared/versioned'
import { tagKey } from '@memry/shared/tag-fold'

export type ParsedSchemaColumn =
  | { kind: 'none' }
  | { kind: 'ok'; schema: TagSchemaStored }
  | { kind: 'unreadable'; raw: Record<string, unknown> }

export function parseSchemaColumn(text: string | null): ParsedSchemaColumn {
  if (text === null) return { kind: 'none' }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { kind: 'unreadable', raw: {} }
  }
  const parsed = TagSchemaWire.safeParse(value)
  if (parsed.success) return { kind: 'ok', schema: parsed.data }
  const raw =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  return { kind: 'unreadable', raw }
}

export function serializeSchema(schema: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(schema)
}

export interface TagDefinitionInput {
  name: string
  color: string
  icon: string | null
  schema: ParsedSchemaColumn
}

export interface PropertyTypeLookup {
  get(
    name: string
  ): { type: PropertyType; options?: SelectOption[]; showOnCalendar?: boolean } | undefined
}

const fold = (name: string): string => name.trim().toLowerCase()

function relationOf(field: TagFieldStored): RelationConfig | null {
  const relation = field.relation
  if (!relation) return null
  return {
    target: typeof relation.target === 'string' ? tagKey(relation.target) || null : null,
    many: relation.many === true,
    inverse: relation.inverse ?? null
  }
}

function storedSchema(def: TagDefinitionInput | undefined): TagSchemaStored | null {
  return def?.schema.kind === 'ok' ? def.schema.schema : null
}

function resolveOwnFields(
  key: string,
  schema: TagSchemaStored | null,
  propertyTypes: PropertyTypeLookup
): ResolvedField[] {
  const seen = new Set<string>()
  const fields: ResolvedField[] = []
  for (const field of schema?.fields ?? []) {
    const name = field.name.trim()
    if (!name || seen.has(fold(name)) || isReservedFieldName(name)) continue
    seen.add(fold(name))
    const relation = relationOf(field)
    const definition = propertyTypes.get(name)
    const definedType = definition?.type
    const type: FieldType = relation
      ? 'relation'
      : definedType && definedType !== 'project' && definedType !== 'relation'
        ? definedType
        : 'text'
    fields.push({
      name,
      type,
      ...(definition?.options && !relation ? { options: definition.options } : {}),
      ...(definition?.showOnCalendar !== undefined && !relation
        ? { showOnCalendar: definition.showOnCalendar }
        : {}),
      relation,
      definedBy: key
    })
  }
  return fields
}

function ancestorsOf(key: string, defs: ReadonlyMap<string, TagDefinitionInput>): string[] {
  const chain: string[] = []
  const visited = new Set([key])
  let parent = storedSchema(defs.get(key))?.extends
  while (typeof parent === 'string') {
    const next = tagKey(parent)
    if (!next || visited.has(next) || !defs.has(next)) break
    visited.add(next)
    chain.push(next)
    parent = storedSchema(defs.get(next))?.extends
  }
  return chain
}

/**
 * Resolves every tag whose schema column is non-NULL. Keys of `defs` are
 * lowercase tag names. An A↔B cycle resolves to A:[B], B:[A] on every device.
 */
export function resolveTagSchemas(
  defs: ReadonlyMap<string, TagDefinitionInput>,
  propertyTypes: PropertyTypeLookup
): Map<string, ResolvedTag> {
  const ownFieldsOf = new Map<string, ResolvedField[]>()
  const ownFields = (key: string): ResolvedField[] => {
    let fields = ownFieldsOf.get(key)
    if (!fields) {
      fields = resolveOwnFields(key, storedSchema(defs.get(key)), propertyTypes)
      ownFieldsOf.set(key, fields)
    }
    return fields
  }
  const ownPresetOf = (key: string): PresetKey | null => {
    const preset = storedSchema(defs.get(key))?.preset
    return isPresetKey(preset) ? preset : null
  }

  const resolved = new Map<string, ResolvedTag>()
  for (const [key, def] of defs) {
    if (def.schema.kind === 'none') continue
    const schema = storedSchema(def)
    const ancestors = ancestorsOf(key, defs)
    const own = ownFields(key)
    const listed = new Set(own.map((field) => fold(field.name)))
    const inherited: ResolvedTag['inherited'] = []
    for (const ancestor of ancestors) {
      const fields = ownFields(ancestor).filter((field) => !listed.has(fold(field.name)))
      for (const field of fields) listed.add(fold(field.name))
      if (fields.length > 0) inherited.push({ from: ancestor, fields })
    }
    const effectiveFields = [...inherited]
      .reverse()
      .flatMap((group) => group.fields)
      .concat(own)

    let template: ResolvedTag['template'] = null
    for (const owner of [key, ...ancestors]) {
      const stored = storedSchema(defs.get(owner))?.template
      if (stored) {
        template = {
          id: stored.id,
          autofill: stored.autofill === true,
          inheritedFrom: owner === key ? null : owner
        }
        break
      }
    }
    const ownPreset = ownPresetOf(key)
    const extendsRaw = schema?.extends
    resolved.set(key, {
      name: def.name,
      key,
      color: def.color,
      icon: def.icon,
      editable: def.schema.kind === 'ok',
      ownFields: own,
      inherited,
      effectiveFields,
      hasFields: effectiveFields.length > 0,
      extends: typeof extendsRaw === 'string' ? tagKey(extendsRaw) || null : null,
      ancestors,
      template,
      preset: [key, ...ancestors].map(ownPresetOf).find((preset) => preset !== null) ?? null,
      ownPreset
    })
  }
  return resolved
}

/** Tags that extend `tag`, transitively. */
export function descendantsOf(tag: string, resolved: ReadonlyMap<string, ResolvedTag>): string[] {
  const key = tagKey(tag)
  return [...resolved.values()]
    .filter((entry) => entry.ancestors.includes(key))
    .map((entry) => entry.key)
}

/** The first header tag, in header order, whose resolved schema has fields. */
export function primaryObjectTag(
  headerTags: readonly string[],
  resolved: ReadonlyMap<string, ResolvedTag>
): string | null {
  for (const tag of headerTags) {
    const key = tagKey(tag)
    if (resolved.get(key)?.hasFields) return key
  }
  return null
}

/** The existing spelling of a name that differs only by case, so the vault keeps one property. */
export function canonicalFieldName(
  typed: string,
  existingPropertyNames: Iterable<string>
): { name: string; reused: boolean } {
  const name = typed.trim()
  for (const existing of existingPropertyNames) {
    if (fold(existing) === fold(name)) return { name: existing, reused: true }
  }
  return { name, reused: false }
}

export interface NewFieldBody {
  name: string
  relation: RelationConfig | null
}

export type SchemaBodyEdit =
  | { kind: 'add-field'; field: NewFieldBody; index?: number }
  | { kind: 'set-relation'; name: string; relation: RelationConfig | null }
  | { kind: 'remove-field'; name: string }
  | { kind: 'move-field'; name: string; toIndex: number }
  /** `resuming`: a recorded vault-wide rename, whose target a schema may already list. */
  | { kind: 'rename-field'; from: string; to: string; resuming?: boolean }
  | { kind: 'set-template'; template: { id: string; autofill: boolean } | null }
  | { kind: 'set-extends'; parent: string | null }
  | {
      kind: 'merge-preset'
      fields: NewFieldBody[]
      template: { id: string; autofill: boolean } | null
      preset: PresetKey
    }
  | { kind: 'rewrite-reference'; from: string; to: string | null }

export type SchemaEditError =
  | { code: 'reserved-name'; name: string }
  | { code: 'duplicate-field'; name: string; definedBy: string }
  | { code: 'unknown-field'; name: string }
  | { code: 'inherited-field'; name: string; definedBy: string }
  | { code: 'cycle'; parent: string }
  | { code: 'unreadable-schema' }

export type SchemaEditResult =
  { ok: true; next: TagSchemaStored; changed: boolean } | { ok: false; error: SchemaEditError }

function storedField(field: NewFieldBody): TagFieldStored {
  return field.relation
    ? { name: field.name.trim(), relation: { ...field.relation } }
    : { name: field.name.trim() }
}

/**
 * Applies one edit and stamps `t + 1` (no clock floor). An edit that changes
 * nothing returns the input with `changed: false`, so a repeated command
 * neither bumps `t` nor syncs.
 */
export function applySchemaEdit(
  current: TagSchemaStored | null,
  edit: SchemaBodyEdit,
  context: { tag: string; resolved: ReadonlyMap<string, ResolvedTag> }
): SchemaEditResult {
  const key = tagKey(context.tag)
  const self = context.resolved.get(key)
  if (self && !self.editable) return { ok: false, error: { code: 'unreadable-schema' } }
  const base: TagSchemaStored = current ?? { t: 0, ...EMPTY_TAG_SCHEMA_BODY, fields: [] }

  if (edit.kind === 'rewrite-reference') {
    const next = rewriteSchemaReference(base, edit.from, edit.to)
    return next
      ? { ok: true, next: next as TagSchemaStored, changed: true }
      : { ok: true, next: base, changed: false }
  }

  const fields = [...(base.fields ?? [])]
  const indexOf = (name: string): number => fields.findIndex((f) => fold(f.name) === fold(name))
  const inheritedOwner = (name: string): string | null =>
    self?.inherited.find((group) => group.fields.some((f) => fold(f.name) === fold(name)))?.from ??
    null
  const missing = (name: string): SchemaEditResult => {
    const owner = inheritedOwner(name)
    return {
      ok: false,
      error: owner
        ? { code: 'inherited-field', name, definedBy: owner }
        : { code: 'unknown-field', name }
    }
  }

  let body: Omit<TagSchemaStored, 't'>
  switch (edit.kind) {
    case 'add-field': {
      const name = edit.field.name.trim()
      if (isReservedFieldName(name)) return { ok: false, error: { code: 'reserved-name', name } }
      if (indexOf(name) !== -1) {
        return { ok: false, error: { code: 'duplicate-field', name, definedBy: key } }
      }
      const owner = inheritedOwner(name)
      if (owner) return { ok: false, error: { code: 'duplicate-field', name, definedBy: owner } }
      const at = Math.min(Math.max(edit.index ?? fields.length, 0), fields.length)
      fields.splice(at, 0, storedField(edit.field))
      body = { ...base, fields }
      break
    }
    case 'set-relation': {
      const at = indexOf(edit.name)
      if (at === -1) return missing(edit.name)
      const { relation: _old, ...rest } = fields[at]
      fields[at] = edit.relation ? { ...rest, relation: { ...edit.relation } } : rest
      body = { ...base, fields }
      break
    }
    case 'remove-field': {
      const at = indexOf(edit.name)
      if (at === -1) return missing(edit.name)
      fields.splice(at, 1)
      body = { ...base, fields }
      break
    }
    case 'move-field': {
      const at = indexOf(edit.name)
      if (at === -1) return missing(edit.name)
      const [moved] = fields.splice(at, 1)
      fields.splice(Math.min(Math.max(edit.toIndex, 0), fields.length), 0, moved)
      body = { ...base, fields }
      break
    }
    case 'rename-field': {
      const to = edit.to.trim()
      if (isReservedFieldName(to)) return { ok: false, error: { code: 'reserved-name', name: to } }
      const at = indexOf(edit.from)
      if (at === -1) return { ok: true, next: base, changed: false }
      const clash = fields.findIndex((f, i) => i !== at && fold(f.name) === fold(to))
      if (clash !== -1) {
        if (!edit.resuming) {
          return { ok: false, error: { code: 'duplicate-field', name: to, definedBy: key } }
        }
        // Resumed vault-wide rename: the target is already listed, so drop the old entry.
        fields.splice(at, 1)
      } else {
        fields[at] = { ...fields[at], name: to }
      }
      body = { ...base, fields }
      break
    }
    case 'set-template':
      body = { ...base, template: edit.template ? { ...edit.template } : null }
      break
    case 'set-extends': {
      const parent = edit.parent === null ? null : tagKey(edit.parent) || null
      if (parent !== null) {
        if (parent === key || context.resolved.get(parent)?.ancestors.includes(key)) {
          return { ok: false, error: { code: 'cycle', parent } }
        }
      }
      body = { ...base, extends: parent }
      break
    }
    case 'merge-preset': {
      const present = new Set([
        ...fields.map((f) => fold(f.name)),
        ...(self?.inherited.flatMap((g) => g.fields.map((f) => fold(f.name))) ?? [])
      ])
      for (const field of edit.fields) {
        if (present.has(fold(field.name)) || isReservedFieldName(field.name)) continue
        present.add(fold(field.name))
        fields.push(storedField(field))
      }
      body = {
        ...base,
        fields,
        template: base.template ?? (edit.template ? { ...edit.template } : null),
        preset: base.preset ?? edit.preset
      }
      break
    }
  }

  if (current === null && canonicalJson(body) === canonicalJson(base)) {
    return { ok: true, next: base, changed: false }
  }
  const stamped = stampVersionedValue(current, body as VersionedObject)
  return { ok: true, next: stamped as TagSchemaStored, changed: stamped !== current }
}
