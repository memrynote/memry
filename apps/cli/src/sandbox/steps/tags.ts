import { tagSpecs } from '../content/tag-schemas.ts'
import type { SandboxStep } from '../context.ts'

/**
 * Everything about tags with fields that the CLI can create: each non-relation
 * field's vault-wide property definition (what `ensureFieldDefinition` in
 * apps/desktop/src/main/tags/schema/edit.ts writes), the tag's template, and
 * the tag row with its color. The schema column itself is post/tags.ts.
 */
export const defineTags: SandboxStep = async ({ app, templates }) => {
  const defined = new Set((await app.properties.definitions()).map((d) => d.name.toLowerCase()))

  for (const spec of tagSpecs) {
    for (const field of spec.fields) {
      // A relation never gets a definition; a field named like an existing property reuses it.
      if (field.type === 'relation' || defined.has(field.name.toLowerCase())) continue
      defined.add(field.name.toLowerCase())
      await app.properties.createDefinition({
        name: field.name,
        type: field.type,
        options: field.options
          ? JSON.stringify(field.options.map(([value, color]) => ({ value, color })))
          : field.showOnCalendar
            ? JSON.stringify({ showOnCalendar: true })
            : null
      })
    }

    if (spec.template) {
      // templateBody() in apps/desktop/src/main/tags/presets.ts: `## Heading` plus an optional hint.
      const content = spec.template.sections
        .map((s) => [`## ${s.heading}`, ...(s.hint ? [s.hint] : [])].join('\n'))
        .join('\n\n')
        .concat('\n')
      const template = await app.templates.create({
        name: spec.template.name,
        content,
        tags: [],
        properties: []
      })
      templates.set(`tag:${spec.key}`, template.id)
    }

    await app.tags.setColor(spec.key, spec.color)
  }
}
