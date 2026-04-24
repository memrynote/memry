import { cn } from '@/lib/utils'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { TitleInput } from './TitleInput'

export interface NoteTitleProps {
  emoji: string | null
  title: string
  placeholder?: string
  onTitleChange: (title: string) => void
  autoFocus?: boolean
  disabled?: boolean
}

export function NoteTitle({
  emoji,
  title,
  placeholder = 'Untitled',
  onTitleChange,
  autoFocus = false,
  disabled = false
}: NoteTitleProps) {
  return (
    <div className={cn('relative flex items-center gap-3')}>
      {emoji && (
        <div className="flex items-center justify-center shrink-0 size-14 rounded-xl bg-sidebar-terracotta/8">
          <NoteIconDisplay value={emoji} className="text-[28px] leading-8" />
        </div>
      )}

      <div className="min-w-0 flex-1">
        <TitleInput
          value={title}
          placeholder={placeholder}
          onChange={onTitleChange}
          autoFocus={autoFocus}
          disabled={disabled}
        />
      </div>
    </div>
  )
}
