import { describe, expect, it } from 'vitest'
import matter from 'gray-matter'
import { PropertyDefinitionsFileSchema } from '@memry/contracts/property-types'

import { buildPropertiesFileData, PROPERTY_DEFINITION_ROWS } from './properties'
import { NOTES } from './notes'
import { PROJECTS } from './tasks'

describe('seed property definitions', () => {
  // A single unparsable entry makes safeParse fail, and PropertyDefinitionsService
  // then discards *every* definition in the file — so the whole block has to be
  // valid, not just the parts we happen to look at.
  it('round-trips through the file schema the app reads on vault open', () => {
    const file = matter.stringify('', { properties: buildPropertiesFileData() })
    const parsed = PropertyDefinitionsFileSchema.safeParse(matter(file).data)

    expect(parsed.success).toBe(true)
    expect(Object.keys(parsed.success ? parsed.data.properties : {}).length).toBeGreaterThan(10)
  })

  it('defines status, project and the calendar date props', () => {
    const properties = buildPropertiesFileData() as Record<string, { type: string }>

    expect(properties.status.type).toBe('status')
    expect(properties.project.type).toBe('project')
    expect(properties.deadline).toEqual({ type: 'date', showOnCalendar: true })
  })

  it('serializes status categories into the DB cache row', () => {
    const row = PROPERTY_DEFINITION_ROWS.find((d) => d.name === 'status')
    expect(row?.type).toBe('status')
    expect(JSON.parse(row!.options as string)).toHaveProperty('categories.todo.options')
  })

  it('covers every status and priority value the seeded notes use', () => {
    const properties = buildPropertiesFileData() as Record<string, never>
    const status = properties.status as unknown as {
      categories: Record<string, { options: Array<{ value: string }> }>
    }
    const statusValues = new Set(
      Object.values(status.categories).flatMap((c) => c.options.map((o) => o.value))
    )
    const priorityValues = new Set(
      (properties.priority as unknown as { options: Array<{ value: string }> }).options.map(
        (o) => o.value
      )
    )

    for (const note of NOTES) {
      const noteStatus = note.frontmatter.status
      if (typeof noteStatus === 'string') expect(statusValues).toContain(noteStatus)
      const notePriority = note.frontmatter.priority
      if (typeof notePriority === 'string') expect(priorityValues).toContain(notePriority)
    }
  })

  it('only uses select and multiselect values the definitions declare', () => {
    const properties = buildPropertiesFileData() as Record<
      string,
      { type: string; options?: Array<{ value: string }> }
    >

    for (const note of NOTES) {
      for (const [name, raw] of Object.entries(note.frontmatter)) {
        const def = properties[name]
        if (!def || (def.type !== 'select' && def.type !== 'multiselect')) continue

        const allowed = new Set(def.options?.map((o) => o.value))
        for (const value of Array.isArray(raw) ? raw : [raw]) {
          expect(allowed, `${note.relativePath} → ${name}`).toContain(value)
        }
      }
    }
  })

  it('only puts real project names in the reserved project key', () => {
    const names = new Set(PROJECTS.map((p) => p.name))
    const tagged = NOTES.filter((n) => n.frontmatter.project)

    expect(tagged.length).toBeGreaterThan(10)
    for (const note of tagged) {
      for (const name of note.frontmatter.project as string[]) {
        expect(names, note.relativePath).toContain(name)
      }
    }
  })
})
