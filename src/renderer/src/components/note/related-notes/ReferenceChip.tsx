import { cn } from '@/lib/utils'
import { X } from 'lucide-react'
import type { ReferencedNote } from './types'

interface ReferenceChipProps {
  note: ReferencedNote
  onRemove: (noteId: string) => void
  onClick?: (noteId: string) => void
}

export function ReferenceChip({ note, onRemove, onClick }: ReferenceChipProps) {
  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5',
        'px-2.5 py-1.5',
        'bg-stone-100 border border-stone-200 rounded-2xl',
        'text-[13px] text-stone-600',
        'max-w-[140px]',
        onClick && 'cursor-pointer hover:bg-stone-200 transition-colors duration-150'
      )}
      onClick={() => onClick?.(note.noteId)}
      role="listitem"
    >
      <span className="text-sm flex-shrink-0">{note.icon || '📄'}</span>
      <span className="truncate">{note.title}</span>
      <button
        onClick={(e) => {
          e.stopPropagation()
          onRemove(note.noteId)
        }}
        className={cn(
          'flex-shrink-0 p-0.5 rounded-full ml-0.5',
          'text-stone-400 hover:text-stone-600 hover:bg-stone-300',
          'transition-colors duration-150'
        )}
        aria-label={`Remove reference: ${note.title}`}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}

interface OverflowChipProps {
  count: number
  onClick: () => void
}

export function OverflowChip({ count, onClick }: OverflowChipProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center justify-center',
        'px-2.5 py-1.5',
        'bg-stone-200 border border-stone-300 rounded-2xl',
        'text-[13px] font-medium text-stone-600',
        'cursor-pointer hover:bg-stone-300 transition-colors duration-150'
      )}
    >
      +{count}
    </button>
  )
}
