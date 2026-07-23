import * as React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { getI18n } from 'react-i18next'
import { toast } from 'sonner'
import { getTagColors, withAlpha } from '@/components/note/tags-row/tag-colors'
import { useTagItems } from '@/hooks/use-tag-items'
import { useNoteTagsQuery } from '@/hooks/use-notes-query'
import { useTabs, useActiveTab } from '@/contexts/tabs'
import { tagsService, onTagRenamed, onTagDeleted } from '@/services/tags-service'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import { TagIconChip } from '@/components/settings/tag-icon-chip'
import { TagRenameDialog } from '@/components/sidebar/tag-rename-dialog'
import { TagDeleteDialog } from '@/components/sidebar/tag-delete-dialog'
import { TagOverflowMenu } from './tag-view/tag-overflow-menu'

const log = createLogger('Page:TagView')

export interface TagViewPageProps {
  tag: string
  color?: string
}

/**
 * Single tag page: a table of every item carrying `tag`, opened from a tag
 * chip in the hub (`tags-hub.tsx`) or, after Task 20, the sidebar.
 *
 * Header (chip, name, count, tag actions menu) — Task 18 adds the items
 * table below the header. The overflow menu (rename / change color / change
 * icon / delete) is `TagOverflowMenu`, moved here from the sidebar
 * drill-down (`tag-detail-view.tsx`, removed in Task 20).
 */
export function TagViewPage({ tag, color }: TagViewPageProps): React.JSX.Element {
  const { total } = useTagItems(tag)
  const { tags } = useNoteTagsQuery()
  const tagRow = tags.find((row) => row.tag.toLowerCase() === tag.toLowerCase())
  const resolvedColor = tagRow?.color ?? color ?? ''
  const colors = getTagColors(resolvedColor, tag)
  const tagIcon = tagRow?.icon ?? null

  const { closeTab } = useTabs()
  const activeTab = useActiveTab()

  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  // This page is only ever mounted as the active tab of some group (`TabPane`
  // renders one `TabContent` for the active tab only), so the currently
  // active tab is this page's own tab.
  const closeThisTab = useCallback(() => {
    if (activeTab) {
      closeTab(activeTab.id)
    }
  }, [activeTab, closeTab])

  const handleIconChange = useCallback(
    async (icon: string | null) => {
      const tSettings = getI18n().getFixedT(null, 'settings')
      try {
        const result = await tagsService.updateTagIcon({ tag, icon })
        if (!result.success) {
          throw new Error(result.error ?? tSettings('tags.toasts.iconFailed'))
        }
      } catch (err) {
        log.error('Failed to update tag icon', err)
        toast.error(extractErrorMessage(err, tSettings('tags.toasts.iconFailed')))
      }
    },
    [tag]
  )

  const handleRenameSubmit = useCallback(
    async (newName: string) => {
      const tSettings = getI18n().getFixedT(null, 'settings')
      try {
        const result = await tagsService.renameTag({ oldName: tag, newName })
        if (!result.success) {
          throw new Error(result.error ?? tSettings('tags.toasts.renameFailed'))
        }
        toast.success(tSettings('tags.toasts.renamed', { oldName: tag, newName }))
        // This tab's identity is `tag` (the OLD name), and there's no
        // tabs-context action to repoint an existing tab's `entityId`. Close
        // it rather than relabel in place, so it doesn't keep resolving
        // color/items against a name that no longer exists. The
        // `onTagRenamed` subscription below closes it too for a rename
        // triggered from another window/tab.
        closeThisTab()
      } catch (err) {
        log.error('Failed to rename tag', err)
        const message = extractErrorMessage(err, tSettings('tags.toasts.renameFailed'))
        toast.error(message)
        throw err instanceof Error ? err : new Error(message)
      }
    },
    [tag, closeThisTab]
  )

  const handleDeleteConfirm = useCallback(async () => {
    const tSettings = getI18n().getFixedT(null, 'settings')
    try {
      const result = await tagsService.deleteTag(tag)
      if (!result.success) {
        throw new Error(result.error ?? tSettings('tags.toasts.deleteFailed'))
      }
      toast.success(tSettings('tags.toasts.deleted', { name: tag, count: total }))
      closeThisTab()
    } catch (err) {
      log.error('Failed to delete tag', err)
      toast.error(extractErrorMessage(err, tSettings('tags.toasts.deleteFailed')))
    }
  }, [tag, total, closeThisTab])

  // Keep this tab in sync with the tag's lifecycle, mirroring the
  // `goBack()` the sidebar drill-down used. This tab's identity is
  // `tab.entityId`, the tag's name at open time, and there's no
  // tabs-context action to repoint an existing tab's `entityId`. So a
  // rename (from this tab or another window) closes the tab, same as a
  // delete — otherwise it would keep resolving color/items against a name
  // that no longer exists while the tab strip shows the new one.
  useEffect(() => {
    const unsubscribeRenamed = onTagRenamed((event) => {
      if (event.oldName.toLowerCase() === tag.toLowerCase()) {
        closeThisTab()
      }
    })
    return unsubscribeRenamed
  }, [tag, closeThisTab])

  useEffect(() => {
    const unsubscribeDeleted = onTagDeleted((event) => {
      if (event.tag.toLowerCase() === tag.toLowerCase()) {
        closeThisTab()
      }
    })
    return unsubscribeDeleted
  }, [tag, closeThisTab])

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
        <TagIconChip
          icon={tagIcon}
          color={colors.text}
          onIconChange={(icon) => void handleIconChange(icon)}
        />
        <span
          className="inline-flex min-w-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
          style={{ backgroundColor: withAlpha(colors.text, 0.12), color: colors.text }}
        >
          <span
            className="size-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: colors.text }}
          />
          <span className="truncate">{tag}</span>
        </span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{total}</span>
        <div className="flex-1" />
        <TagOverflowMenu
          tag={tag}
          color={resolvedColor}
          onRequestRename={() => setRenameOpen(true)}
          onRequestDelete={() => setDeleteOpen(true)}
        />
      </div>

      <TagRenameDialog
        tag={tag}
        open={renameOpen}
        onOpenChange={setRenameOpen}
        onSubmit={handleRenameSubmit}
      />
      <TagDeleteDialog
        tag={tag}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onConfirm={handleDeleteConfirm}
      />

      {/* Table arrives in Task 18 */}
    </div>
  )
}

export default TagViewPage
