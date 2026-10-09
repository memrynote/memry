import { describe, expect, it } from 'vitest'
import matter from 'gray-matter'
import { PropertyDefinitionsFileSchema } from '@memry/contracts/property-types'
import { parseRelationValue } from '@memry/contracts/relation-uri'
import { plainVersionedMap } from '@memry/shared/versioned'

import { parseSchemaColumn, resolveTagSchemas } from '../../src/main/tags/tag-schema'
import { JOURNAL_NOTES } from './journal'
import {
  OBJECT_NOTE_FILES,
  OBJECT_NOTE_METADATA,
  OBJECT_TAG_DEFINITIONS,
  OBJECT_TASKS,
  OBJECT_TASK_TAGS,
  OBJECT_TEMPLATES
} from './objects'
import { buildPropertiesFileData } from './properties'

const parsedFile = PropertyDefinitionsFileSchema.parse(
  matter(matter.stringify('', { properties: buildPropertiesFileData() })).data
).properties

const resolved = resolveTagSchemas(
  new Map(
    OBJECT_TAG_DEFINITIONS.map((def) => [
      def.name,
      {
        name: def.name,
        color: def.color,
        icon: def.icon ?? null,
        schema: parseSchemaColumn(def.schema ?? null)
      }
    ])
  ),
  { get: (name) => parsedFile[name] }
)

const idByPath = new Map(OBJECT_NOTE_METADATA.map((m) => [m.path, m.id]))
const tagsOfNote = new Map(
  OBJECT_NOTE_FILES.map((file) => [
    idByPath.get(file.relativePath)!,
    (file.frontmatter.tags as string[] | undefined) ?? []
  ])
)

describe('seeded tags with fields', () => {
  it('stores every schema in a shape the app resolves and can edit', () => {
    expect([...resolved.keys()].sort()).toEqual(
      ['book', 'company', 'delegated', 'employee', 'meeting', 'person'].sort()
    )
    for (const tag of resolved.values()) expect(tag.editable, tag.key).toBe(true)
    expect(resolved.get('person')?.ownPreset).toBe('person')
    expect(resolved.get('employee')?.ancestors).toEqual(['person'])
    expect(resolved.get('employee')?.effectiveFields.map((f) => f.name)).toEqual([
      'Company',
      'Role',
      'Email',
      'Phone',
      'Team',
      'Start date',
      'Manager'
    ])
  })

  it('types every non-relation field through a declared property definition', () => {
    for (const tag of resolved.values()) {
      for (const field of tag.ownFields.filter((f) => !f.relation)) {
        expect(parsedFile[field.name], `${tag.key}.${field.name}`).toBeDefined()
      }
    }
    expect(resolved.get('meeting')?.ownFields.find((f) => f.name === 'Date')?.type).toBe('date')
  })

  it('references only seeded templates', () => {
    const ids = new Set(OBJECT_TEMPLATES.map((t) => t.id))
    for (const key of ['person', 'company', 'meeting', 'book']) {
      expect(ids).toContain(resolved.get(key)?.template?.id)
    }
  })

  it('points every relation value at a note carrying the target tag or a child of it', () => {
    let checked = 0
    for (const file of OBJECT_NOTE_FILES) {
      const tags = (file.frontmatter.tags as string[] | undefined) ?? []
      for (const tag of tags) {
        for (const field of resolved.get(tag)?.effectiveFields ?? []) {
          const value = file.frontmatter[field.name]
          if (!field.relation || value === undefined) continue
          const refs = parseRelationValue(value)
          expect(refs.length, `${file.relativePath} ${field.name}`).toBeGreaterThan(0)
          for (const ref of refs) {
            const targetTags = tagsOfNote.get(ref.kind === 'note' ? ref.id : '') ?? []
            const ok = targetTags.some(
              (t) =>
                t === field.relation!.target ||
                resolved.get(t)?.ancestors.includes(field.relation!.target!)
            )
            expect(ok, `${file.relativePath} ${field.name}`).toBe(true)
            checked++
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(20)
  })

  it('gives delegated tasks readable versioned fields pointing at people', () => {
    expect(OBJECT_TASK_TAGS.every((row) => row.tag === 'delegated')).toBe(true)
    expect(OBJECT_TASKS).toHaveLength(4)
    for (const task of OBJECT_TASKS) {
      const fields = plainVersionedMap(task.fields)
      const [ref] = parseRelationValue(fields['Waiting on'])
      expect(tagsOfNote.get(ref?.kind === 'note' ? ref.id : '')).toContain('person')
      expect(fields['Follow up']).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('mentions objects inline in notes and journal entries without making them objects', () => {
    const bodies = [...OBJECT_NOTE_FILES, ...JOURNAL_NOTES]
    const mentions = bodies.filter((f) => /#person\b/.test(f.body))
    expect(mentions.length).toBeGreaterThanOrEqual(3)
    for (const file of mentions) expect(file.frontmatter.tags ?? []).not.toContain('person')
    expect(JOURNAL_NOTES.filter((f) => f.body.includes('[[Ahmet Yılmaz]]'))).toHaveLength(2)
  })
})
