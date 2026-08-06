import { useState, useCallback, useRef } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Search, MoreHorizontal, Pencil, Merge, Trash2, Palette, Tag } from '@/lib/icons'
import { toast } from 'sonner'
import { useTags } from '@/hooks/use-tags'
import { extractErrorMessage } from '@/lib/ipc-error'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import { getTagColors, COLOR_ROWS, TAG_COLORS } from '@/components/note/tags-row/tag-colors'
import { CustomColorSwatch } from '@/components/note/tags-row/CustomColorSwatch'
import { TagIconChip } from './tag-icon-chip'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

export function TagManager() {
  const { t } = useT('settings')
  const { t: tCommon } = useT('common')
  const { tags, isLoading, error, renameTag, mergeTag, deleteTag } = useTags()
  const [search, setSearch] = useState('')
  const [editingTag, setEditingTag] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<{ name: string; count: number } | null>(null)
  const [mergeSource, setMergeSource] = useState<string | null>(null)
  const [mergeTarget, setMergeTarget] = useState('')
  const [colorTarget, setColorTarget] = useState<string | null>(null)
  const editInputRef = useRef<HTMLInputElement>(null)

  const filteredTags = search.trim()
    ? tags.filter((t) => t.name.toLowerCase().includes(search.toLowerCase().trim()))
    : tags

  const handleStartRename = useCallback((tagName: string) => {
    setEditingTag(tagName)
    setEditValue(tagName)
  }, [])

  const handleConfirmRename = useCallback(async () => {
    if (!editingTag || !editValue.trim()) return
    const newName = editValue.trim()
    if (newName === editingTag) {
      setEditingTag(null)
      return
    }
    try {
      const result = await renameTag(editingTag, newName)
      if (result.success) {
        toast.success(t('tags.toasts.renamed', { oldName: editingTag, newName }))
      } else {
        trackRendererError('tag_rename', result.error ?? 'rename failed')
        toast.error(result.error ?? t('tags.toasts.renameFailed'))
      }
    } catch (err) {
      trackRendererError('tag_rename', err)
      toast.error(extractErrorMessage(err, t('tags.toasts.renameFailed')))
    }
    setEditingTag(null)
  }, [editingTag, editValue, renameTag, t])

  const handleCancelRename = useCallback(() => {
    setEditingTag(null)
  }, [])

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return
    try {
      const result = await deleteTag(deleteTarget.name)
      if (result.success) {
        toast.success(
          t('tags.toasts.deleted', {
            name: deleteTarget.name,
            count: result.affectedNotes ?? 0
          })
        )
      } else {
        trackRendererError('tag_delete', result.error ?? 'delete failed')
        toast.error(result.error ?? t('tags.toasts.deleteFailed'))
      }
    } catch (err) {
      trackRendererError('tag_delete', err)
      toast.error(extractErrorMessage(err, t('tags.toasts.deleteFailed')))
    }
    setDeleteTarget(null)
  }, [deleteTarget, deleteTag, t])

  const handleConfirmMerge = useCallback(async () => {
    if (!mergeSource || !mergeTarget) return
    try {
      const result = await mergeTag(mergeSource, mergeTarget)
      if (result.success) {
        toast.success(
          t('tags.toasts.merged', {
            source: mergeSource,
            target: mergeTarget,
            count: result.affectedItems ?? 0
          })
        )
      } else {
        trackRendererError('tag_merge', result.error ?? 'merge failed')
        toast.error(result.error ?? t('tags.toasts.mergeFailed'))
      }
    } catch (err) {
      trackRendererError('tag_merge', err)
      toast.error(extractErrorMessage(err, t('tags.toasts.mergeFailed')))
    }
    setMergeSource(null)
    setMergeTarget('')
  }, [mergeSource, mergeTarget, mergeTag, t])

  const handleColorChange = useCallback(
    async (colorName: string) => {
      if (!colorTarget) return
      try {
        await window.api.tags.updateTagColor({ tag: colorTarget, color: colorName })
        toast.success(t('tags.toasts.colorUpdated', { name: colorTarget }))
      } catch (err) {
        toast.error(extractErrorMessage(err, t('tags.toasts.colorFailed')))
      }
      setColorTarget(null)
    },
    [colorTarget, t]
  )

  const handleIconChange = useCallback(
    async (tagName: string, icon: string | null) => {
      try {
        await window.api.tags.updateTagIcon({ tag: tagName, icon })
      } catch (err) {
        toast.error(extractErrorMessage(err, t('tags.toasts.iconFailed')))
      }
    },
    [t]
  )

  if (isLoading) {
    return <p className="text-xs/4 text-muted-foreground">{t('tags.loading')}</p>
  }

  if (error) {
    return <p className="text-xs/4 text-destructive">{error}</p>
  }

  if (tags.length === 0) {
    return <p className="text-xs/4 text-muted-foreground">{t('tags.empty')}</p>
  }

  return (
    <div className="flex flex-col">
      <div className="relative pb-6">
        <Search className="absolute start-3 top-2 w-3.5 h-3.5 text-muted-foreground" />
        <Input
          placeholder={t('tags.filterPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="ps-8 h-8 text-xs/4 rounded-lg border-border bg-transparent"
        />
      </div>

      <div className="flex flex-col rounded-lg overflow-y-auto max-h-[60vh] border border-border bg-surface-active">
        {filteredTags.length === 0 && (
          <p className="text-xs/4 text-muted-foreground py-4 text-center">
            {t('tags.noMatch', { query: search })}
          </p>
        )}
        {filteredTags.map((tag, i) => {
          const colors = getTagColors(tag.color ?? '', tag.name)

          return (
            <div key={tag.name}>
              {i > 0 && <div className="h-px bg-border" />}
              <div className="flex items-center justify-between h-11 py-3 px-4 shrink-0 group">
                <div className="flex items-center gap-2.5 min-w-0">
                  <TagIconChip
                    icon={tag.icon ?? null}
                    color={colors?.background ?? '#6366f1'}
                    onIconChange={(icon) => void handleIconChange(tag.name, icon)}
                  />
                  {editingTag === tag.name ? (
                    <Input
                      ref={editInputRef}
                      autoFocus
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onFocus={(e) => e.currentTarget.select()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleConfirmRename()
                        if (e.key === 'Escape') handleCancelRename()
                      }}
                      onBlur={() => void handleConfirmRename()}
                      className="h-6 text-[13px]/4 px-1.5 w-40"
                    />
                  ) : (
                    <span className="font-medium text-[13px]/4 text-foreground truncate">
                      {tag.name}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1.5 shrink-0 ms-4">
                  <span className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-muted text-[10px]/3 font-medium text-muted-foreground tabular-nums">
                    {tag.count}
                  </span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="p-1 rounded text-muted-foreground/50 opacity-0 group-hover:opacity-100 hover:text-foreground transition-all"
                      >
                        <MoreHorizontal className="w-3.5 h-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => handleStartRename(tag.name)}>
                        <Pencil className="w-4 h-4 me-2" />
                        {t('tags.actions.rename')}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setColorTarget(tag.name)}>
                        <Palette className="w-4 h-4 me-2" />
                        {t('tags.actions.changeColor')}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setMergeSource(tag.name)}>
                        <Merge className="w-4 h-4 me-2" />
                        {t('tags.actions.mergeInto')}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() => setDeleteTarget({ name: tag.name, count: tag.count })}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="w-4 h-4 me-2" />
                        {t('tags.actions.delete')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <p className="text-xs/4 text-muted-foreground pt-3">
        {t('tags.summary', { count: tags.length })}
      </p>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('tags.dialogs.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('tags.dialogs.deleteDescription', {
                name: deleteTarget?.name ?? '',
                count: deleteTarget?.count ?? 0
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon('button.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleConfirmDelete()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('tags.actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!mergeSource} onOpenChange={(open) => !open && setMergeSource(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('tags.dialogs.mergeTitle')}</DialogTitle>
            <DialogDescription>
              {t('tags.dialogs.mergeDescription', { source: mergeSource ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <Tag className="w-4 h-4 text-muted-foreground" />
              <span className="font-medium">{mergeSource}</span>
              <span className="text-muted-foreground">→</span>
            </div>
            <Select value={mergeTarget} onValueChange={setMergeTarget}>
              <SelectTrigger>
                <SelectValue placeholder={t('tags.dialogs.targetPlaceholder')} />
              </SelectTrigger>
              <SelectContent className="max-h-60">
                {tags
                  .filter((t) => t.name !== mergeSource)
                  .map((t) => (
                    <SelectItem key={t.name} value={t.name}>
                      {t.name} ({t.count})
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMergeSource(null)}>
              {tCommon('button.cancel')}
            </Button>
            <Button onClick={() => void handleConfirmMerge()} disabled={!mergeTarget}>
              {t('tags.actions.merge')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!colorTarget} onOpenChange={(open) => !open && setColorTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('tags.dialogs.colorTitle', { name: colorTarget ?? '' })}</DialogTitle>
          </DialogHeader>
          <div className="py-4 space-y-2">
            {COLOR_ROWS.map((row, rowIndex) => (
              <div key={rowIndex} className="flex gap-2 justify-center">
                {row.map((colorName) => {
                  const clrs = TAG_COLORS[colorName]
                  const currentTag = tags.find((t) => t.name === colorTarget)
                  const isSelected = currentTag?.color === colorName

                  return (
                    <button
                      key={colorName}
                      type="button"
                      aria-label={colorName}
                      onClick={() => void handleColorChange(colorName)}
                      className={cn(
                        'w-7 h-7 rounded-full transition-all hover:scale-110',
                        'focus:outline-none',
                        isSelected &&
                          'ring-2 ring-foreground/50 ring-offset-2 ring-offset-background'
                      )}
                      style={{ backgroundColor: clrs.background }}
                      title={colorName}
                    />
                  )
                })}
                {rowIndex === COLOR_ROWS.length - 1 && (
                  <CustomColorSwatch
                    value={tags.find((t) => t.name === colorTarget)?.color ?? ''}
                    onChange={(hex) => void handleColorChange(hex)}
                  />
                )}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
