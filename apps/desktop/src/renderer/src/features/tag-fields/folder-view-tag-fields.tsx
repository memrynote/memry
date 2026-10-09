import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import type { FilterExpression, ViewScope } from '@memry/contracts/folder-view-api'
import type { ResolvedTag } from '@memry/contracts/tag-schema'
import type { TaskFieldValue } from '@memry/contracts/tasks-api'
import { Button } from '@/components/ui/button'
import { useTabs } from '@/contexts/tabs'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import { useTabViewState } from '@/hooks/use-tab-view-state'
import { extractErrorMessage } from '@/lib/ipc-error'
import { Pencil } from '@/lib/icons'
import { FOLDER_VIEW_STATE_KEYS, parseLinkedFilter } from '@/pages/folder-view-state'
import { BulkFieldFill, type BulkFillNote } from './agent-fill/BulkFieldFill'
import { TagSettingsSheet } from './settings/TagSettingsSheet'
import { LinkedFilterBar, MentionedInSection, updateTaskField, withLinkedFilter } from './tag-table'
import { useResolvedTag } from './use-tag-schemas'

export function useFolderViewTagFields(scope: ViewScope) {
  const { t } = useT('notes')
  const { openTab } = useTabs()
  const tag = useResolvedTag(scope.kind === 'tag' ? scope.tag : null)
  const fieldTag = tag?.hasFields ? tag : null
  const [linkedFilter, setLinkedFilter] = useTabViewState<string | null>({
    key: FOLDER_VIEW_STATE_KEYS.linkedFilter,
    defaultValue: null,
    parse: parseLinkedFilter
  })
  const [settingsOpen, setSettingsOpen] = useState(false)

  const onObjectCreated = useCallback(
    (id: string, title: string, open: boolean) => {
      if (!open) {
        toast.success(t('tagObjects.table.created', { title }))
        return
      }
      openTab(
        {
          type: 'note',
          title,
          icon: 'file-text',
          path: `/notes/${id}`,
          entityId: id,
          isPinned: false,
          isModified: false,
          isPreview: false,
          isDeleted: false
        },
        { forceNew: true }
      )
    },
    [openTab, t]
  )

  const editTaskRowField = useCallback(
    (row: { id: string; kind?: string }, name: string, value: unknown, refresh: () => unknown) => {
      if (row.kind !== 'task' || !fieldTag?.effectiveFields.some((f) => f.name === name)) {
        return false
      }
      updateTaskField(row.id, name, value as TaskFieldValue | undefined)
        .then(() => refresh())
        .catch((error: unknown) =>
          toast.error(extractErrorMessage(error, t('tagObjects.table.saveFailed')))
        )
      return true
    },
    [fieldTag, t]
  )

  return {
    tag,
    fieldTag,
    linkedFilter: fieldTag ? linkedFilter : null,
    setLinkedFilter,
    settingsOpen,
    setSettingsOpen,
    onObjectCreated,
    editTaskRowField
  }
}

export function TagFieldsCount({ tag }: { tag: ResolvedTag | null }): React.JSX.Element | null {
  const { t } = useT('notes')
  if (!tag) return null
  return (
    <>
      <span className="flex-shrink-0 font-medium text-muted-foreground/50">·</span>
      <span className="min-w-0 truncate whitespace-nowrap font-medium text-text-tertiary">
        {t('tagFields.settings.headerFields', { count: tag.effectiveFields.length })}
      </span>
    </>
  )
}

export function TagFieldsToolbar({
  tag,
  notes,
  onEdit
}: {
  tag: ResolvedTag | null
  notes: BulkFillNote[]
  onEdit: () => void
}): React.JSX.Element {
  const { t } = useT('notes')
  return (
    <>
      {tag && <BulkFieldFill tag={tag} notes={notes} />}
      <Button variant="outline" size="sm" className="gap-1.5" onClick={onEdit}>
        <Pencil className="size-3.5" />
        {t('tagFields.settings.editTag')}
      </Button>
    </>
  )
}

export function TagLinkedFilter({
  filter,
  shown,
  total,
  viewFilters,
  onClear,
  updateFilters
}: {
  filter: string | null
  shown: number
  total: number
  viewFilters: FilterExpression | undefined
  onClear: () => void
  updateFilters: (filters: FilterExpression) => Promise<unknown>
}): React.JSX.Element | null {
  if (!filter) return null
  return (
    <LinkedFilterBar
      filter={filter}
      shown={shown}
      total={total}
      onRemove={onClear}
      onSave={() => void updateFilters(withLinkedFilter(viewFilters, filter)).then(onClear)}
    />
  )
}

export function TagMentionedIn({ tag }: { tag: ResolvedTag | null }): React.JSX.Element | null {
  const { openSidebarItem } = useSidebarNavigation()
  if (!tag) return null
  return (
    <MentionedInSection
      tag={tag}
      onOpen={(id, title) =>
        openSidebarItem({ type: 'note', title, path: `/notes/${id}`, entityId: id })
      }
    />
  )
}

export function TagSettingsHost({
  tag,
  open,
  onClose
}: {
  tag: string
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  return open ? <TagSettingsSheet key={tag} tag={tag} onClose={onClose} /> : null
}
