import { isRelationValue } from '@memry/contracts/relation-uri'
import { getPropertyDefinition as getCanonicalPropertyDefinition } from '@memry/storage-data'
import { saveCanonicalPropertyDefinition } from '@memry/domain-notes'
import { inferPropertyType } from '../../vault/frontmatter'

type CanonicalDefinitionDb = Parameters<typeof getCanonicalPropertyDefinition>[0]
type PropertyType = ReturnType<typeof inferPropertyType>

/**
 * Decides the stored type for a property arriving on a sync update.
 *
 * This is the `getType` callback for the second of `setNoteProperties`' two
 * production callers. The first is the note projector, which resolves types
 * through `getPropertyType` against the index DB. This one resolves against the
 * canonical (data DB) definition store instead, and is the only path that types
 * properties written by `noteHandler.applyUpsert` — a path the projector never
 * revisits, because the file that handler writes is passed to
 * `markWritebackIgnored` and the watcher honours that.
 *
 * Extracted from an inline closure so a test can exercise the exact function
 * production uses, against real databases, rather than a re-implementation.
 */
export function resolveSyncPropertyType(
  dataDb: CanonicalDefinitionDb,
  name: string,
  value: unknown
): PropertyType {
  // Structural override, mirroring `getPropertyType`: an array of memry:// URIs
  // IS a relation, whatever the canonical definition claims. Neither this
  // resolver nor `vault/note-sync.ts` ever corrects an existing definition row,
  // so once a relation's first (empty `[]`) write pins the definition to `text`
  // on some device, every later sync update would type the populated value as
  // `text` there. `deserializeValue(value, 'text')` then hands back the raw JSON
  // string — and both push builders serialize properties from the index DB, not
  // from the file, so that device would ship the flattened string to every other
  // device on its next push of the note. A body edit, tag change or rename is
  // enough to trigger it; no property edit required.
  //
  // No `saveCanonicalPropertyDefinition` on this branch, deliberately.
  // `PropertyDefinitionSchema` has no `relation` member, so nothing may write
  // that type into a definition store. The relation is typed from its value
  // every time instead, which is idempotent and needs no stored state.
  if (isRelationValue(value)) {
    return 'relation'
  }

  const type =
    (getCanonicalPropertyDefinition(dataDb, name)?.type as PropertyType | null | undefined) ??
    inferPropertyType(name, value)
  saveCanonicalPropertyDefinition(dataDb, { name, type })
  return type
}
