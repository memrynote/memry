import { isDeepStrictEqual } from 'util'
import type { NoteCoverSync } from '@memry/contracts/sync-payloads'
import { normalizeAliases } from '@memry/shared/note-names'
import {
  extractAliases,
  replacePropertiesOnRoot,
  type NoteFrontmatter
} from '../../vault/frontmatter'
import { applyNoteCoverToFrontmatter } from './note-cover-sync'

/**
 * A pulled `aliases` field (chapter 13 §13.7.1): absent or `null` means the
 * sender does not know, so the receiver keeps its list (`undefined`); an
 * array, `[]` included, is the list to hold.
 */
export function remoteAliases(
  remote: readonly string[] | null | undefined,
  title: string
): string[] | undefined {
  return Array.isArray(remote) ? normalizeAliases(title, remote) : undefined
}

export interface RemoteFrontmatterPatch {
  tags?: string[]
  properties?: Record<string, unknown>
  cover?: NoteCoverSync | null
  aliases?: string[]
  title: string
}

export function applyRemoteFrontmatter(
  frontmatter: NoteFrontmatter,
  patch: RemoteFrontmatterPatch
): NoteFrontmatter {
  let next = { ...frontmatter }
  if (patch.tags) {
    if (patch.tags.length > 0) next.tags = patch.tags
    else delete next.tags
  }
  if (patch.properties) next = replacePropertiesOnRoot(next, patch.properties)
  if (patch.cover !== undefined) next = applyNoteCoverToFrontmatter(next, patch.cover)
  if (patch.aliases && !isDeepStrictEqual(extractAliases(next, patch.title), patch.aliases)) {
    if (patch.aliases.length > 0) next.aliases = patch.aliases
    else delete next.aliases
  }
  return next
}
