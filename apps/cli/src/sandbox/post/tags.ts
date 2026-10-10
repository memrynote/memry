import { ViewConfigSchema } from '@memry/contracts/folder-view-api'
import { TagSchemaWire } from '@memry/contracts/tag-schema'

import { tagSpecs, type TagSpec } from '../content/tag-schemas.ts'
import { taskSpecs } from '../content/tasks.ts'
import { need } from '../context.ts'
import type { PostContext } from './index.ts'

/**
 * What `serializeSchema` stores for a tag (apps/desktop/src/main/tags/tag-schema.ts).
 * Key order is the app's: the edit spreads `{ t: 0, fields, template, extends,
 * preset }` and `stampVersionedValue` puts `t` last. A user's edits each add 1
 * to `t` (one per field, one for the template, one for `extends`); a ready-made
 * tag is a single merge, so its `t` is 1.
 */
function storedSchema(spec: TagSpec, templateId: string | undefined): Record<string, unknown> {
  const edits = spec.preset ? 1 : spec.fields.length + (templateId ? 1 : 0) + (spec.extends ? 1 : 0)
  return {
    fields: spec.fields.map((field) =>
      field.relation ? { name: field.name, relation: { ...field.relation } } : { name: field.name }
    ),
    template: templateId ? { id: templateId, autofill: true } : null,
    extends: spec.extends ?? null,
    preset: spec.preset ?? null,
    t: edits
  }
}

/**
 * Writes the tag schemas, icons and saved views (`tag_definitions.schema`,
 * `.icon`, `.views`). The CLI has no operation for them; desktop's owner is
 * tags/schema/edit.ts saveSchemaEdit and tags/schema/views.ts saveTagViews.
 * Rows keep clock NULL, which tag-definition-handler's seedUnclocked stamps on
 * the first sync. Each value is checked against the wire schemas the app
 * itself parses with, so an unreadable schema fails generation, not the app.
 */
export function tagSchemas({ ctx, data }: PostContext): void {
  const update = data.prepare(
    'UPDATE tag_definitions SET icon = ?, schema = ?, views = ?, color_authored = 1 WHERE name = ?'
  )
  for (const spec of tagSpecs) {
    const schema = TagSchemaWire.parse(storedSchema(spec, ctx.templates.get(`tag:${spec.key}`)))
    const views = spec.views.map((view) => ViewConfigSchema.parse(view))
    const result = update.run(
      spec.icon,
      JSON.stringify(schema),
      spec.views.length > 0 ? JSON.stringify(views) : null,
      spec.key
    )
    if (result.changes !== 1) throw new Error(`Tag ${spec.key} has no definition row`)
  }
}

/**
 * A task's field map: `{ "<field>": { "v": value, "t": 1 } }`, the shape
 * storage-data's tasks-repository stamps on create (docs/protocol 13.7.3.1).
 * The CLI's tasks.create has no `fields` input. A relation value is a list of
 * `memry://note/<id>` even for "one".
 */
export function taskFields({ ctx, data }: PostContext): void {
  const update = data.prepare('UPDATE tasks SET fields = ? WHERE id = ?')
  for (const spec of taskSpecs(ctx.clock)) {
    if (!spec.waitingOn) continue
    const person = need(ctx.notes, spec.waitingOn, 'note')
    const fields = { 'Waiting on': { v: [`memry://note/${person.id}`], t: 1 } }
    update.run(JSON.stringify(fields), need(ctx.tasks, spec.key, 'task').id)
  }
}
