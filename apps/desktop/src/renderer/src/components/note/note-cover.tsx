import { memo } from 'react'
import { useT } from '@memry/i18n/renderer'
import { Image, Trash2 } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useVault } from '@/hooks/use-vault'
import { resolveNoteRelativeUrl } from '@/lib/resolve-note-relative-url'

export interface NoteCoverProps {
  cover: string
  noteId: string
  notePath: string
  onChange: () => void
  onRemove: () => void
  disabled?: boolean
}

const ACTION_CLASS = cn(
  'flex items-center gap-1.5',
  'rounded-md px-2 py-1',
  'border border-border bg-background/85',
  'text-[12px] text-text-tertiary',
  'transition-colors duration-150 motion-reduce:transition-none',
  'hover:text-foreground',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
  'disabled:pointer-events-none disabled:opacity-50'
)

export const NoteCover = memo(function NoteCover({
  cover,
  noteId,
  notePath,
  onChange,
  onRemove,
  disabled = false
}: NoteCoverProps) {
  const { t } = useT('notes')
  const { vaultPath } = useVault()
  const src = resolveNoteRelativeUrl(cover, notePath, vaultPath, noteId)

  return (
    <div
      className="group/cover relative mb-3 h-[180px] w-full overflow-hidden rounded-lg bg-muted"
      data-testid="note-cover"
    >
      <img src={src} alt={t('cover.alt')} className="h-full w-full object-cover" />

      <div
        className={cn(
          'absolute bottom-3 end-3 flex items-center gap-2',
          'opacity-0 transition-opacity duration-150 motion-reduce:transition-none',
          'group-hover/cover:opacity-100 group-focus-within/cover:opacity-100'
        )}
      >
        <button type="button" disabled={disabled} onClick={onChange} className={ACTION_CLASS}>
          <Image className="h-3 w-3" strokeWidth={2} />
          {t('cover.change')}
        </button>
        <button type="button" disabled={disabled} onClick={onRemove} className={ACTION_CLASS}>
          <Trash2 className="h-3 w-3" strokeWidth={2} />
          {t('cover.remove')}
        </button>
      </div>
    </div>
  )
})
