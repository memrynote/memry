import { useCallback, useEffect } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { ResolvedTag } from '@memry/contracts/tag-schema'
import type {
  TagSchemaCommand,
  TagSchemaCommandResult,
  TagSchemaSnapshot
} from '@memry/contracts/tag-schema-api'
import { tagsService } from '@/services/tags-service'
import { onTagsChanged } from '@/services/notes-service'

export const tagSchemaQueryKey = ['tags', 'schema-snapshot'] as const

const INVALIDATE_DEBOUNCE_MS = 250

let subscribers = 0
let unsubscribe: (() => void) | null = null

function subscribeInvalidation(queryClient: QueryClient): () => void {
  subscribers += 1
  if (subscribers === 1) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const invalidate = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: tagSchemaQueryKey })
      }, INVALIDATE_DEBOUNCE_MS)
    }
    const offTags = onTagsChanged(invalidate)
    const offDefinitions = window.api.onPropertyDefinitionChanged(invalidate)
    unsubscribe = () => {
      clearTimeout(timer)
      offTags()
      offDefinitions()
    }
  }
  return () => {
    subscribers -= 1
    if (subscribers === 0) {
      unsubscribe?.()
      unsubscribe = null
    }
  }
}

export function useTagSchemas(): { data: TagSchemaSnapshot | undefined; isLoading: boolean } {
  const queryClient = useQueryClient()
  useEffect(() => subscribeInvalidation(queryClient), [queryClient])
  const query = useQuery({
    queryKey: tagSchemaQueryKey,
    queryFn: () => tagsService.getSchemaSnapshot(),
    staleTime: Infinity
  })
  return { data: query.data, isLoading: query.isLoading }
}

export function resolveTag(
  snapshot: TagSchemaSnapshot | undefined,
  tag: string | null | undefined
): ResolvedTag | null {
  if (!snapshot || !tag) return null
  return snapshot.tags[tag.trim().toLowerCase()] ?? null
}

export function useResolvedTag(tag: string | null | undefined): ResolvedTag | null {
  return resolveTag(useTagSchemas().data, tag)
}

export function tagHasFields(snapshot: TagSchemaSnapshot | undefined, tag: string): boolean {
  return resolveTag(snapshot, tag)?.hasFields ?? false
}

export interface ObjectIdentity {
  tag: string
  name: string
  color: string
  icon: string | null
  avatar: boolean
}

export function objectIdentityOf(
  snapshot: TagSchemaSnapshot | undefined,
  noteId: string | null | undefined
): ObjectIdentity | null {
  if (!snapshot || !noteId) return null
  const key = snapshot.objects[noteId]
  if (!key) return null
  const tag = snapshot.tags[key]
  if (!tag) return null
  return {
    tag: tag.key,
    name: tag.name,
    color: tag.color,
    icon: tag.icon,
    avatar: tag.preset === 'person'
  }
}

export function useObjectIdentity(noteId: string | null | undefined): ObjectIdentity | null {
  return objectIdentityOf(useTagSchemas().data, noteId)
}

export function useObjectIdentityLookup(): (noteId: string) => ObjectIdentity | null {
  const snapshot = useTagSchemas().data
  return useCallback((noteId: string) => objectIdentityOf(snapshot, noteId), [snapshot])
}

export function useEditTagSchema(): (command: TagSchemaCommand) => Promise<TagSchemaCommandResult> {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (command: TagSchemaCommand) => tagsService.editSchema(command),
    onSuccess: (result) => {
      queryClient.setQueryData(tagSchemaQueryKey, result.snapshot)
    }
  })
  return mutation.mutateAsync
}
