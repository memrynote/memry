import * as React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { getI18n } from 'react-i18next'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import type { ColumnConfig } from '@memry/contracts/folder-view-api'
import { getTagColors, withAlpha } from '@/components/note/tags-row/tag-colors'
import { useTagItems } from '@/hooks/use-tag-items'
import { useNoteTagsQuery } from '@/hooks/use-notes-query'
import { useTabs, useActiveTab } from '@/contexts/tabs'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import { tagsService, onTagRenamed, onTagDeleted } from '@/services/tags-service'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import { TagIconChip } from '@/components/settings/tag-icon-chip'
import { TagRenameDialog } from '@/components/sidebar/tag-rename-dialog'
import { TagDeleteDialog } from '@/components/sidebar/tag-delete-dialog'
import { Button } from '@/components/ui/button'
import { Picker } from '@/components/ui/picker'
import { FolderTableView } from '@/components/folder-view'
import { Pin } from '@/lib/icons'
import { TagOverflowMenu } from './tag-view/tag-overflow-menu'

const log = createLogger('Page:TagView')

type KindFilter = 'all' | 'note' | 'task' | 'inbox'

const KIND_FILTER_OPTIONS: KindFilter[] = ['all', 'note', 'task', 'inbox']

const KIND_FILTER_LABEL_KEYS: Record<KindFilter, string> = {
  all: 'tagView.kindFilter.all',
  note: 'tagView.kindFilter.notes',
  task: 'tagView.kindFilter.tasks',
  inbox: 'tagView.kindFilter.inbox'
}

const TABLE_COLUMNS: ColumnConfig[] = [
  { id: 'title', width: 280 },
  { id: 'kind', width: 100 },
  { id: 'tags', width: 160 },
  { id: 'folder', width: 140 },
  { id: 'modified', width: 130 }
]

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
  const { t: tNotes } = useT('notes')
  const { items, total, isLoading, error, refresh } = useTagItems({ tag })
  const { openSidebarItem } = useSidebarNavigation()
  const { tags } = useNoteTagsQuery()
  const tagRow = tags.find((row) => row.tag.toLowerCase() === tag.toLowerCase())
  const resolvedColor = tagRow?.color ?? color ?? ''
  const colors = getTagColors(resolvedColor, tag)
  const tagIcon = tagRow?.icon ?? null

  const { closeTab } = useTabs()
  const activeTab = useActiveTab()

  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set())
  const [isPinning, setIsPinning] = useState(false)

  const filteredItems = useMemo(
    () =>
      kindFilter === 'all' ? items : items.filter((item) => (item.kind ?? 'note') === kindFilter),
    [items, kindFilter]
  )

  // Only note rows can be pinned — task/inbox rows carry no tag pin concept.
  const selectedNoteIds = useMemo(
    () =>
      Array.from(selectedRowIds).filter((id) => {
        const item = items.find((row) => row.id === id)
        return item !== undefined && (item.kind ?? 'note') === 'note'
      }),
    [items, selectedRowIds]
  )

  // Selection is row-id based; a stale id from before a filter/tag change
  // could otherwise silently reference a row that's no longer shown. Reset
  // in render (not an effect) on a signature change, matching the
  // render-phase sync convention `FolderTableView` itself uses for the same
  // kind of derived-from-props reset.
  const selectionResetKey = `${tag}:${kindFilter}`
  const [lastSelectionResetKey, setLastSelectionResetKey] = useState(selectionResetKey)
  if (lastSelectionResetKey !== selectionResetKey) {
    setLastSelectionResetKey(selectionResetKey)
    setSelectedRowIds(new Set())
  }

  const handleNoteOpen = useCallback(
    (noteId: string) => {
      const item = items.find((row) => row.id === noteId)
      if (!item) return
      const kind = item.kind ?? 'note'

      if (kind === 'task') {
        openSidebarItem({
          type: 'tasks',
          title: 'Tasks',
          icon: 'CheckSquare',
          path: '/tasks',
          viewState: {
            openTaskId: item.id,
            activeInternalTab: 'all',
            activeTab: 'all'
          }
        })
        return
      }

      if (kind === 'inbox') {
        openSidebarItem({
          type: 'inbox',
          title: 'Inbox',
          icon: 'Inbox',
          path: '/inbox',
          viewState: { selectedItemId: item.id }
        })
        return
      }

      openSidebarItem({
        type: 'note',
        path: item.path,
        entityId: item.id,
        title: item.title,
        emoji: item.emoji
      })
    },
    [items, openSidebarItem]
  )

  // Minimal preservation of `useTagDetail`'s pin action, now that the items
  // table replaces the sidebar drill-down's pinned/unpinned note lists (Task
  // 20 removes that view entirely): pin every selected note row to this tag
  // from the toolbar. `TagItem` carries no pinned flag, so there's no
  // per-row pin indicator or unpin toggle here — see the task report for
  // what's deferred.
  const handlePinSelected = useCallback(async () => {
    if (selectedNoteIds.length === 0) return
    setIsPinning(true)
    try {
      const results = await Promise.all(
        selectedNoteIds.map((noteId) => tagsService.pinNoteToTag({ noteId, tag }))
      )
      const failed = results.find((result) => !result.success)
      if (failed) {
        throw new Error(failed.error ?? tNotes('tagView.pin.failed'))
      }
      toast.success(tNotes('tagView.pin.success', { count: selectedNoteIds.length }))
      setSelectedRowIds(new Set())
      await refresh()
    } catch (err) {
      log.error('Failed to pin note(s) to tag', err)
      toast.error(extractErrorMessage(err, tNotes('tagView.pin.failed')))
    } finally {
      setIsPinning(false)
    }
  }, [selectedNoteIds, tag, tNotes, refresh])

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

      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
        <Picker
          mode="single"
          value={kindFilter}
          onValueChange={(value) => setKindFilter(value as KindFilter)}
        >
          <Picker.Trigger asChild>
            <Button variant="outline" size="sm" className="gap-1.5">
              {tNotes(KIND_FILTER_LABEL_KEYS[kindFilter])}
            </Button>
          </Picker.Trigger>
          <Picker.Content align="start" width={160}>
            <Picker.List>
              {KIND_FILTER_OPTIONS.map((option) => (
                <Picker.Item
                  key={option}
                  value={option}
                  label={tNotes(KIND_FILTER_LABEL_KEYS[option])}
                  indicator="check"
                  role="menuitemradio"
                  aria-checked={kindFilter === option}
                />
              ))}
            </Picker.List>
          </Picker.Content>
        </Picker>

        {selectedNoteIds.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={isPinning}
            onClick={() => void handlePinSelected()}
          >
            <Pin className="size-3.5" />
            {tNotes('tagView.pin.action', { count: selectedNoteIds.length })}
          </Button>
        )}

        <div className="flex-1" />
      </div>

      {error && <div className="shrink-0 border-b px-4 py-2 text-sm text-destructive">{error}</div>}

      <FolderTableView
        notes={filteredItems}
        columns={TABLE_COLUMNS}
        selectedRowIds={selectedRowIds}
        onSelectionChange={setSelectedRowIds}
        onNoteOpen={handleNoteOpen}
        isLoading={isLoading}
        className="min-h-0 flex-1"
      />
    </div>
  )
}

export default TagViewPage
