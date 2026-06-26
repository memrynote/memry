/**
 * Bulk Action Bar
 *
 * Floating toolbar shown when one or more notes are selected in the folder
 * table view. Mirrors the Paper "Folder View — Linear" bulk-action design:
 * count pill, Move / Copy links / Add tag / Export, then Delete and a clear (X).
 */

import { useMemo, useState } from 'react'
import { Download, FolderInput, Link, Tag, Trash2, X } from '@/lib/icons'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import type { TagMetaMap } from '@/components/folder-view/note-card-pieces'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

interface BulkActionBarProps {
  /** Number of selected notes */
  count: number
  /** Existing tag names for add-tag suggestions */
  availableTags?: string[]
  /** Per-tag icon + color (keyed by lowercased name) for suggestion glyphs */
  tagMeta?: TagMetaMap
  onMove: () => void
  onCopyLinks: () => void
  onAddTag: (tag: string) => void
  onExport: () => void
  onDelete: () => void
  onClear: () => void
  className?: string
}

interface BarButtonProps {
  icon: typeof FolderInput
  label: string
  onClick?: () => void
  destructive?: boolean
}

function BarButton({ icon: Icon, label, onClick, destructive }: BarButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium transition-colors',
        destructive ? 'text-destructive hover:bg-destructive/10' : 'text-foreground hover:bg-muted'
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      {label}
    </button>
  )
}

function Divider(): React.JSX.Element {
  return <div className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden="true" />
}

export function BulkActionBar({
  count,
  availableTags = [],
  tagMeta,
  onMove,
  onCopyLinks,
  onAddTag,
  onExport,
  onDelete,
  onClear,
  className
}: BulkActionBarProps): React.JSX.Element {
  const { t } = useT('notes')

  return (
    <div
      role="toolbar"
      aria-label={t('bulkActions.toolbarAria')}
      className={cn(
        'flex h-11 shrink-0 items-center gap-0.5 rounded-xl border border-border bg-popover ps-1.5 pe-2 text-xs shadow-lg',
        'animate-in fade-in slide-in-from-bottom-2 duration-150',
        className
      )}
    >
      <div className="flex h-8 items-center gap-1.5 rounded-lg bg-[var(--tint)]/10 px-2.5">
        <span className="font-bold tabular-nums text-[var(--tint)]">{count}</span>
        <span className="font-medium text-[var(--tint)]">{t('bulkActions.selected')}</span>
      </div>

      <Divider />

      <BarButton icon={FolderInput} label={t('bulkActions.move')} onClick={onMove} />
      <BarButton icon={Link} label={t('bulkActions.copyLinks')} onClick={onCopyLinks} />
      <AddTagButton
        label={t('bulkActions.addTag')}
        placeholder={t('bulkActions.tagNamePlaceholder')}
        availableTags={availableTags}
        tagMeta={tagMeta}
        onAddTag={onAddTag}
      />
      <BarButton icon={Download} label={t('bulkActions.export')} onClick={onExport} />

      <Divider />

      <BarButton icon={Trash2} label={t('bulkActions.delete')} onClick={onDelete} destructive />

      <button
        type="button"
        onClick={onClear}
        aria-label={t('bulkActions.clearAria')}
        className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <X className="size-4" strokeWidth={2} />
      </button>
    </div>
  )
}

interface AddTagButtonProps {
  label: string
  placeholder: string
  availableTags: string[]
  tagMeta?: TagMetaMap
  onAddTag: (tag: string) => void
}

function AddTagButton({
  label,
  placeholder,
  availableTags,
  tagMeta,
  onAddTag
}: AddTagButtonProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')

  const suggestions = useMemo(() => {
    const query = value.trim().toLowerCase().replace(/^#/, '')
    if (!query) return availableTags.slice(0, 6)
    return availableTags.filter((tag) => tag.toLowerCase().includes(query)).slice(0, 6)
  }, [value, availableTags])

  const apply = (tag: string): void => {
    const clean = tag.trim().replace(/^#/, '')
    if (!clean) return
    onAddTag(clean)
    setValue('')
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted"
        >
          <Tag className="size-3.5 shrink-0" />
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" className="w-56 p-1.5">
        <Input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              apply(value)
            }
          }}
          placeholder={placeholder}
          className="h-8 text-xs"
        />
        {suggestions.length > 0 && (
          <div className="mt-1 max-h-40 overflow-y-auto">
            {suggestions.map((tag) => {
              const icon = tagMeta?.get(tag.toLowerCase())?.icon
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => apply(tag)}
                  className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-start text-xs text-foreground transition-colors hover:bg-muted"
                >
                  {icon ? (
                    <NoteIconDisplay
                      value={icon}
                      className="size-3.5 shrink-0 text-center text-[13px] leading-none"
                    />
                  ) : (
                    <Tag className="size-3 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{tag}</span>
                </button>
              )
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

export default BulkActionBar
