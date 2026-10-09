/** The schema snapshot and the `tags:edit-schema` command dispatcher. */
import type {
  TagSchemaCommand,
  TagSchemaCommandResult,
  TagSchemaSnapshot,
  TagsProgressEvent
} from '@memry/contracts/tag-schema-api'
import type { DataDb, IndexDb } from '../../database/types'
import { buildObjectIndex } from '../objects'
import { addPreset, dismissPresetOffer, presetOffers, presetStripDismissed } from '../presets'
import { addField, emitTagSchemasChanged, saveSchemaEdit } from './edit'
import { renameField } from './field-rename'
import { loadResolvedTags } from './read'

/** The one read model of tag schemas, object identities and ready-made tag offers. */
export function getTagSchemaSnapshot(db: DataDb, indexDb: IndexDb): TagSchemaSnapshot {
  const resolved = loadResolvedTags(db)
  return {
    tags: Object.fromEntries(resolved),
    objects: buildObjectIndex(indexDb, resolved).objects,
    presets: presetOffers(db, indexDb, resolved),
    presetStripDismissed: presetStripDismissed(db)
  }
}

export async function runTagSchemaCommand(
  db: DataDb,
  indexDb: IndexDb,
  command: TagSchemaCommand,
  onProgress: (event: TagsProgressEvent) => void
): Promise<TagSchemaCommandResult> {
  const extra: Omit<TagSchemaCommandResult, 'snapshot'> = {}
  let changed = true
  switch (command.kind) {
    case 'add-field':
      changed = await addField(db, command.tag, command.field, command.index)
      break
    case 'set-relation':
    case 'remove-field':
    case 'move-field':
    case 'set-template':
    case 'set-extends':
      changed = saveSchemaEdit(db, command.tag, command)
      break
    case 'add-preset':
      extra.tag = await addPreset(db, command.preset, command.tag)
      break
    case 'rename-field':
      extra.rename = await renameField(db, command, onProgress)
      break
    case 'dismiss-preset-offer':
      dismissPresetOffer(db)
      break
  }
  if (changed) emitTagSchemasChanged()
  return { snapshot: getTagSchemaSnapshot(db, indexDb), ...extra }
}
