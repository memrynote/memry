import { getI18n } from 'react-i18next'
/**
 * Tag hub data hook.
 *
 * Fetches tag categories (`tagsService.listCategories`) and per-tag counts
 * (`useNoteTagsQuery`), groups tags under their category, and exposes the
 * category/tag mutations the hub page needs.
 *
 * A tag's `categoryId` has no foreign key to `tag_categories` (a cascade FK
 * broke production sync). A tag pointing at a category that no longer
 * exists — deleted on another device, not yet reconciled — must group under
 * "Uncategorized", never crash, never vanish. See the second test case.
 */
import { useState, useEffect, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import { tagsService, onTagCategoriesChanged, type TagAssignment } from '@/services/tags-service'
import { useNoteTagsQuery } from '@/hooks/use-notes-query'

const log = createLogger('Hook:TagCategories')

const errorsT = () => getI18n().getFixedT(null, 'notes')

export interface HubTag {
  tag: string
  color: string
  icon: string | null
  count: number
  sortOrder: number
}

export interface HubCategory {
  id: string
  name: string
  sortOrder: number
  tags: HubTag[]
}

export interface UseTagCategoriesResult {
  categories: HubCategory[]
  uncategorized: HubTag[]
  isLoading: boolean
  error: string | null
  createCategory: (name: string) => Promise<void>
  renameCategory: (id: string, name: string) => Promise<void>
  deleteCategory: (id: string) => Promise<void>
  createTag: (name: string, color: string, categoryId: string | null) => Promise<void>
  reorder: (payload: {
    tags?: TagAssignment[]
    categories?: { id: string; sortOrder: number }[]
  }) => Promise<void>
}

interface CategoryRow {
  id: string
  name: string
  sortOrder: number
}

const EMPTY_CATEGORY_ROWS: CategoryRow[] = []

function sortTags(tags: HubTag[]): HubTag[] {
  return [...tags].sort((a, b) => a.sortOrder - b.sortOrder || a.tag.localeCompare(b.tag))
}

export function useTagCategories(): UseTagCategoriesResult {
  const [categoryRows, setCategoryRows] = useState<CategoryRow[]>(EMPTY_CATEGORY_ROWS)
  const [isLoadingCategories, setIsLoadingCategories] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const { tags: noteTags, isLoading: isLoadingTags, refetch: refetchNoteTags } = useNoteTagsQuery()

  const fetchCategories = useCallback(async () => {
    setIsLoadingCategories(true)
    try {
      const response = await tagsService.listCategories()
      if (!response.success) {
        setError(extractErrorMessage(response.error, errorsT()('tagsHub.errors.loadFailed')))
        setCategoryRows(EMPTY_CATEGORY_ROWS)
        return
      }
      setError(null)
      setCategoryRows(response.categories ?? EMPTY_CATEGORY_ROWS)
    } catch (err) {
      log.error('Failed to load tag categories', err)
      setError(extractErrorMessage(err, errorsT()('tagsHub.errors.loadFailed')))
      setCategoryRows(EMPTY_CATEGORY_ROWS)
    } finally {
      setIsLoadingCategories(false)
    }
  }, [])

  // Initial load.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      await fetchCategories()
      if (cancelled) return
    })()
    return () => {
      cancelled = true
    }
  }, [fetchCategories])

  // A category created/renamed/deleted, or a reorder that reassigns a tag's
  // categoryId, all land on this event. Refetch both the category rows and
  // the note-tags rows (which carry each tag's categoryId) so a drag that
  // moves a tag between categories shows up immediately rather than waiting
  // for an unrelated tag event to invalidate useNoteTagsQuery's cache.
  useEffect(() => {
    const unsubscribe = onTagCategoriesChanged(() => {
      void fetchCategories()
      void refetchNoteTags?.()
    })
    return unsubscribe
  }, [fetchCategories, refetchNoteTags])

  const { categories, uncategorized } = useMemo(() => {
    const categoryById = new Map(categoryRows.map((c) => [c.id, c]))
    const buckets = new Map<string, HubTag[]>()
    const uncategorizedTags: HubTag[] = []

    for (const t of noteTags) {
      const hubTag: HubTag = {
        tag: t.tag,
        color: t.color,
        icon: t.icon,
        count: t.count,
        sortOrder: t.sortOrder
      }

      // A tag's categoryId may point at a category deleted on another
      // device and not yet reconciled here (no FK enforces this). Treat any
      // categoryId that doesn't resolve to a known category as uncategorized.
      if (t.categoryId && categoryById.has(t.categoryId)) {
        const bucket = buckets.get(t.categoryId)
        if (bucket) {
          bucket.push(hubTag)
        } else {
          buckets.set(t.categoryId, [hubTag])
        }
      } else {
        uncategorizedTags.push(hubTag)
      }
    }

    const builtCategories: HubCategory[] = categoryRows
      .map((row) => ({
        id: row.id,
        name: row.name,
        sortOrder: row.sortOrder,
        tags: sortTags(buckets.get(row.id) ?? [])
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))

    return {
      categories: builtCategories,
      uncategorized: sortTags(uncategorizedTags)
    }
  }, [categoryRows, noteTags])

  const createCategory = useCallback(
    async (name: string) => {
      try {
        const result = await tagsService.createCategory(name)
        if (!result.success) {
          const message = extractErrorMessage(
            result.error,
            errorsT()('tagsHub.errors.createCategoryFailed')
          )
          setError(message)
          toast.error(message)
          return
        }
        await fetchCategories()
      } catch (err) {
        log.error('Failed to create tag category', err)
        const message = extractErrorMessage(err, errorsT()('tagsHub.errors.createCategoryFailed'))
        setError(message)
        toast.error(message)
      }
    },
    [fetchCategories]
  )

  const renameCategory = useCallback(
    async (id: string, name: string) => {
      try {
        const result = await tagsService.renameCategory(id, name)
        if (!result.success) {
          const message = extractErrorMessage(
            result.error,
            errorsT()('tagsHub.errors.renameCategoryFailed')
          )
          setError(message)
          toast.error(message)
          return
        }
        await fetchCategories()
      } catch (err) {
        log.error('Failed to rename tag category', err)
        const message = extractErrorMessage(err, errorsT()('tagsHub.errors.renameCategoryFailed'))
        setError(message)
        toast.error(message)
      }
    },
    [fetchCategories]
  )

  const deleteCategory = useCallback(
    async (id: string) => {
      try {
        const result = await tagsService.deleteCategory(id)
        if (!result.success) {
          const message = extractErrorMessage(
            result.error,
            errorsT()('tagsHub.errors.deleteCategoryFailed')
          )
          setError(message)
          toast.error(message)
          return
        }
        await fetchCategories()
      } catch (err) {
        log.error('Failed to delete tag category', err)
        const message = extractErrorMessage(err, errorsT()('tagsHub.errors.deleteCategoryFailed'))
        setError(message)
        toast.error(message)
      }
    },
    [fetchCategories]
  )

  // No dedicated "create tag" IPC exists: updateTagColor get-or-creates the
  // tag definition and sets its color, then reorder assigns it to a
  // category (reorder alone would no-op on a tag that doesn't exist yet).
  const createTag = useCallback(
    async (name: string, color: string, categoryId: string | null) => {
      try {
        const colorResult = await tagsService.updateTagColor({ tag: name, color })
        if (!colorResult.success) {
          const message = extractErrorMessage(
            colorResult.error,
            errorsT()('tagsHub.errors.createTagFailed')
          )
          setError(message)
          toast.error(message)
          return
        }

        const reorderResult = await tagsService.reorder({
          tags: [{ tag: name, categoryId, sortOrder: 0 }]
        })
        if (!reorderResult.success) {
          // The tag was already created (and colored) by updateTagColor above;
          // only its category assignment failed. Refetch so the uncategorized
          // tag shows up, and say so rather than claiming creation failed.
          const message = extractErrorMessage(
            reorderResult.error,
            errorsT()('tagsHub.errors.createTagFiledFailed')
          )
          setError(message)
          toast.error(message)
          await fetchCategories()
          void refetchNoteTags?.()
          return
        }

        await fetchCategories()
        void refetchNoteTags?.()
      } catch (err) {
        log.error('Failed to create tag', err)
        const message = extractErrorMessage(err, errorsT()('tagsHub.errors.createTagFailed'))
        setError(message)
        toast.error(message)
      }
    },
    [fetchCategories, refetchNoteTags]
  )

  const reorder = useCallback(
    async (payload: {
      tags?: TagAssignment[]
      categories?: { id: string; sortOrder: number }[]
    }) => {
      try {
        const result = await tagsService.reorder(payload)
        if (!result.success) {
          const message = extractErrorMessage(
            result.error,
            errorsT()('tagsHub.errors.reorderFailed')
          )
          setError(message)
          toast.error(message)
          return
        }
        await fetchCategories()
        void refetchNoteTags?.()
      } catch (err) {
        log.error('Failed to reorder tags', err)
        const message = extractErrorMessage(err, errorsT()('tagsHub.errors.reorderFailed'))
        setError(message)
        toast.error(message)
      }
    },
    [fetchCategories, refetchNoteTags]
  )

  return {
    categories,
    uncategorized,
    isLoading: isLoadingCategories || isLoadingTags,
    error,
    createCategory,
    renameCategory,
    deleteCategory,
    createTag,
    reorder
  }
}

export default useTagCategories
