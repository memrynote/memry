import { tagKey } from '@memry/shared/tag-fold'
import { useCallback } from 'react'
import type { ResolvedTag } from '@memry/contracts/tag-schema'
import type { TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'
import { useTagSchemas } from './use-tag-schemas'
import type { ObjectLook } from './object-avatar'

export function lookOfTag(tag: ResolvedTag): ObjectLook {
  return { tag: tag.key, color: tag.color, icon: tag.icon, avatar: tag.preset === 'person' }
}

export function lookOfTagKey(
  snapshot: TagSchemaSnapshot | undefined,
  tag: string | null | undefined
): ObjectLook | null {
  const resolved = tag ? snapshot?.tags[tagKey(tag)] : undefined
  return resolved ? lookOfTag(resolved) : null
}

export function useTagLookLookup(): (tag: string | null | undefined) => ObjectLook | null {
  const { data } = useTagSchemas()
  return useCallback((tag) => lookOfTagKey(data, tag), [data])
}
