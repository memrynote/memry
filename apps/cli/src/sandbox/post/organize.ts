import { createId } from '@memry/app-core/ids'

import { folderIcons, homeWidgets, tagCategories } from '../content/organize.ts'
import type { PostContext } from './index.ts'

// Every row below is inserted with clock NULL. Each table has a sync adapter
// whose seedUnclocked gives such rows their first clock and queues a create on
// the first sync start (apps/desktop/src/main/sync/initial-seed.ts), which is
// how a desktop-created row would reach other devices too.

/**
 * Folder icons: the CLI wrote them into each `.folder.md`; `folder_configs` is
 * the synced record of the same icon (apps/desktop/src/main/sync/item-handlers/folder-config-handler.ts).
 */
export function folderConfigs({ data }: PostContext): void {
  const insert = data.prepare('INSERT INTO folder_configs (path, icon) VALUES (?, ?)')
  for (const [folder, icon] of Object.entries(folderIcons)) insert.run(folder, icon)
}

/**
 * Tag categories have no CLI surface. `tag_definitions` rows exist from
 * tags.setColor; they get a category, an order, and color_authored = 1, which
 * desktop's color pickers set and which makes the color win on sync
 * (apps/desktop/src/main/sync/item-handlers/tag-definition-handler.ts).
 */
export function tagCategoriesAndOrder({ data }: PostContext): void {
  const category = data.prepare(
    'INSERT INTO tag_categories (id, name, sort_order) VALUES (?, ?, ?)'
  )
  const tag = data.prepare(
    'UPDATE tag_definitions SET category_id = ?, sort_order = ?, color_authored = 1 WHERE name = ?'
  )
  for (const [position, entry] of tagCategories.entries()) {
    category.run(entry.id, entry.name, position)
    for (const [order, name] of Object.keys(entry.tags).entries()) {
      const result = tag.run(entry.id, order, name)
      if (result.changes !== 1) throw new Error(`Tag ${name} has no definition row`)
    }
  }
  data.prepare('UPDATE tag_definitions SET color_authored = 1 WHERE category_id IS NULL').run()
}

/**
 * The Home board. Desktop seeds a two-widget board only when no board exists
 * (apps/desktop/src/renderer/src/pages/home.tsx), so a pre-inserted row
 * replaces that seed. Widget types and sizes follow components/home/widgets/index.ts.
 */
export function homeBoard({ ctx, data }: PostContext): void {
  const aurora = ctx.projects.get('aurora')!.id
  const widgets = homeWidgets.map((widget) =>
    widget.type === 'project' ? { ...widget, config: { projectId: aurora } } : widget
  )
  data
    .prepare('INSERT INTO home_pages (id, name, icon, position, widgets) VALUES (?, ?, ?, ?, ?)')
    .run(createId('home'), 'Home', null, 0, JSON.stringify(widgets))
}

/**
 * The signed-off spec gets a read-only lock. Desktop applies it on open
 * (vault-locks/service.ts reconcileLockedFiles captures baselines and chmods
 * the file), so this runs last: nothing may write the note afterwards.
 */
export function lockSignedOffSpec({ ctx, data }: PostContext): void {
  const noteId = ctx.notes.get('typography-spec')!.id
  // Id shape of vaultLockId (packages/contracts/src/vault-locks-api.ts), which
  // this Node entry cannot import: that module uses extensionless imports.
  data
    .prepare('INSERT INTO vault_locks (id, target_kind, target, locked) VALUES (?, ?, ?, 1)')
    .run(`note:${noteId}`, 'note', noteId)
}
