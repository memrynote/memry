import type { NoteFrontmatter } from '../vault/frontmatter'
import type * as Y from 'yjs'

const SYNCABLE_META_KEYS = ['title', 'tags', 'aliases', 'emoji', 'properties'] as const

export function mergeFrontmatterFromCrdt(
  metaMap: Y.Map<unknown>,
  fileFrontmatter: NoteFrontmatter
): NoteFrontmatter {
  const result: NoteFrontmatter = { ...fileFrontmatter }

  for (const key of SYNCABLE_META_KEYS) {
    const value = metaMap.get(key)
    if (value === null) {
      delete result[key]
    } else if (value !== undefined) {
      ;(result as Record<string, unknown>)[key] = value
    }
  }

  result.id = fileFrontmatter.id
  result.created = fileFrontmatter.created
  result.modified = new Date().toISOString()

  return result
}
