import { lazy, Suspense, useCallback, useState } from 'react'
import { Folder } from '@/lib/icons'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { useT } from '@memry/i18n/renderer'

const LazyEmojiPicker = lazy(async () => ({
  default: (await import('@/components/note/note-title/EmojiPicker')).EmojiPicker
}))

interface FolderEmojiChipProps {
  /** Current folder icon (raw emoji "📚" or "icon:StarIcon"), or null for default */
  icon: string | null
  /** Persist a new icon, or null to clear back to the default folder glyph */
  onIconChange: (icon: string | null) => void
}

/**
 * Folder-view header chip showing the folder's custom emoji (or a default folder
 * glyph). Clicking opens the shared emoji picker to set/change/remove the icon.
 */
export function FolderEmojiChip({ icon, onIconChange }: FolderEmojiChipProps): React.JSX.Element {
  const { t } = useT('common')
  const [open, setOpen] = useState(false)

  const handleSelect = useCallback(
    (value: string) => {
      onIconChange(value)
      setOpen(false)
    },
    [onIconChange]
  )

  const handleRemove = useCallback(() => {
    onIconChange(null)
    setOpen(false)
  }, [onIconChange])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          aria-label={t('phaseF.componentsFolderIconButton.setFolderIcon')}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] border bg-muted transition-colors hover:bg-accent"
        >
          {icon ? (
            <NoteIconDisplay value={icon} className="text-[17px] leading-none" />
          ) : (
            <Folder className="h-4 w-4 text-muted-foreground" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-auto border-0 bg-transparent p-0 shadow-none"
        onClick={(e) => e.stopPropagation()}
      >
        <Suspense fallback={null}>
          <LazyEmojiPicker
            isOpen
            embedded
            onClose={() => setOpen(false)}
            onSelect={handleSelect}
            onRemove={handleRemove}
            hasEmoji={!!icon}
          />
        </Suspense>
      </PopoverContent>
    </Popover>
  )
}
