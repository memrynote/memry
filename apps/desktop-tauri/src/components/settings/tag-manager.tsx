import { useState, useCallback, useRef, useEffect } from 'react'
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
import { getTagColors, COLOR_ROWS, TAG_COLORS } from '@/components/note/tags-row/tag-colors'
import { cn } from '@/lib/utils'
import { invoke } from '@/lib/ipc/invoke'

export function TagManager() {
  const { tags, isLoading, error, renameTag, mergeTag, deleteTag } = useTags()
  const [search, setSearch] = useState('')
  const [editingTag, setEditingTag] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<{ name: string; count: number } | null>(null)
  const [mergeSource, setMergeSource] = useState<string | null>(null)
  const [mergeTarget, setMergeTarget] = useState('')
  const [colorTarget, setColorTarget] = useState<string | null>(null)
  const editInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingTag && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingTag])

  const filteredTags = search.trim()
    ? tags.filter((t) => t.name.includes(search.toLowerCase().trim()))
    : tags

  const handleStartRename = useCallback((tagName: string) => {
    setEditingTag(tagName)
    setEditValue(tagName)
  }, [])

  const handleConfirmRename = useCallback(async () => {
    if (!editingTag || !editValue.trim()) return
    const newName = editValue.trim().toLowerCase()
    if (newName === editingTag) {
      setEditingTag(null)
      return
    }
    try {
      const result = await renameTag(editingTag, newName)
      if (result.success) {
        toast.success(`Renamed "${editingTag}" to "${newName}"`)
      } else {
        toast.error(result.error ?? 'Rename failed')
      }
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Failed to rename tag'))
    }
    setEditingTag(null)
  }, [editingTag, editValue, renameTag])

  const handleCancelRename = useCallback(() => {
    setEditingTag(null)
  }, [])

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return
    try {
      const result = await deleteTag(deleteTarget.name)
      if (result.success) {
        toast.success(`Deleted "${deleteTarget.name}" from ${result.affectedNotes ?? 0} items`)
      } else {
        toast.error(result.error ?? 'Delete failed')
      }
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Failed to delete tag'))
    }
    setDeleteTarget(null)
  }, [deleteTarget, deleteTag])

  const handleConfirmMerge = useCallback(async () => {
    if (!mergeSource || !mergeTarget) return
    try {
      const result = await mergeTag(mergeSource, mergeTarget)
      if (result.success) {
        toast.success(
          `Merged "${mergeSource}" into "${mergeTarget}" (${result.affectedNotes ?? 0} items)`
        )
      } else {
        toast.error(result.error ?? 'Merge failed')
      }
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Failed to merge tags'))
    }
    setMergeSource(null)
    setMergeTarget('')
  }, [mergeSource, mergeTarget, mergeTag])

  const handleColorChange = useCallback(
    async (colorName: string) => {
      if (!colorTarget) return
      try {
        await invoke('tags_update_tag_color', { tag: colorTarget, color: colorName })
        toast.success(`Updated color for "${colorTarget}"`)
      } catch (err) {
        toast.error(extractErrorMessage(err, 'Failed to update color'))
      }
      setColorTarget(null)
    },
    [colorTarget]
  )

  if (isLoading) {
    return <p className="text-xs/4 text-muted-foreground">Loading tags...</p>
  }

  if (error) {
    return <p className="text-xs/4 text-destructive">{error}</p>
  }

  if (tags.length === 0) {
    return (
      <p className="text-xs/4 text-muted-foreground">
        No tags yet. Tags will appear here as you add them to notes and tasks.
      </p>
    )
  }

  return (
    <div className="flex flex-col">
      <div className="relative pb-6">
        <Search className="absolute left-3 top-2 w-3.5 h-3.5 text-muted-foreground" />
        <Input
          placeholder="Filter tags..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-8 h-8 text-xs/4 rounded-lg border-border bg-transparent"
        />
      </div>

      <div className="flex flex-col rounded-lg overflow-y-auto max-h-[60vh] border border-border">
        {filteredTags.length === 0 && (
          <p className="text-xs/4 text-muted-foreground py-4 text-center">
            No tags matching &ldquo;{search}&rdquo;
          </p>
        )}
        {filteredTags.map((tag, i) => {
          const colors = tag.color ? getTagColors(tag.color) : null

          return (
            <div key={tag.name}>
              {i > 0 && <div className="h-px bg-border" />}
              <div className="flex items-center justify-between h-11 py-3 px-4 shrink-0 group">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{
                      backgroundColor: colors?.background ?? '#6366f1'
                    }}
                  />
                  {editingTag === tag.name ? (
                    <Input
                      ref={editInputRef}
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
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

                <div className="flex items-center gap-1.5 shrink-0 ml-4">
                  <span className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-muted text-[10px]/3 font-medium text-muted-foreground tabular-nums">
                    {tag.count}
                  </span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button className="p-1 rounded text-muted-foreground/50 opacity-0 group-hover:opacity-100 hover:text-foreground transition-all">
                        <MoreHorizontal className="w-3.5 h-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => handleStartRename(tag.name)}>
                        <Pencil className="w-4 h-4 mr-2" />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setColorTarget(tag.name)}>
                        <Palette className="w-4 h-4 mr-2" />
                        Change color
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setMergeSource(tag.name)}>
                        <Merge className="w-4 h-4 mr-2" />
                        Merge into...
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() => setDeleteTarget({ name: tag.name, count: tag.count })}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="w-4 h-4 mr-2" />
                        Delete
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
        {tags.length} tag{tags.length !== 1 ? 's' : ''} across notes and tasks
      </p>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete tag</AlertDialogTitle>
            <AlertDialogDescription>
              Remove &ldquo;{deleteTarget?.name}&rdquo; from {deleteTarget?.count ?? 0} item
              {deleteTarget?.count !== 1 ? 's' : ''}? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleConfirmDelete()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!mergeSource} onOpenChange={(open) => !open && setMergeSource(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Merge tag</DialogTitle>
            <DialogDescription>
              All items tagged with &ldquo;{mergeSource}&rdquo; will be re-tagged with the target
              tag. The source tag will be deleted.
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
                <SelectValue placeholder="Select target tag..." />
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
              Cancel
            </Button>
            <Button onClick={() => void handleConfirmMerge()} disabled={!mergeTarget}>
              Merge
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!colorTarget} onOpenChange={(open) => !open && setColorTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Change color for &ldquo;{colorTarget}&rdquo;</DialogTitle>
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
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
