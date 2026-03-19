import { FileText, StickyNote, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { Attachment } from './types'

interface AttachmentChipProps {
  attachment: Attachment
  onRemove: (id: string) => void
}

export function AttachmentChip({ attachment, onRemove }: AttachmentChipProps) {
  const getIcon = () => {
    switch (attachment.type) {
      case 'pdf':
        return <FileText className="h-4 w-4 text-red-500 shrink-0" />
      case 'doc':
        return <FileText className="h-4 w-4 text-blue-500 shrink-0" />
      case 'note':
        return <StickyNote className="h-4 w-4 text-amber-500 shrink-0" />
      default:
        return <FileText className="h-4 w-4 text-stone-500 shrink-0" />
    }
  }

  const displayName =
    attachment.type === 'note'
      ? `Note: ${attachment.noteTitle || attachment.name}`
      : attachment.name

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              'inline-flex items-center gap-2',
              'bg-stone-100 border border-stone-200',
              'rounded-full px-3 py-1.5',
              'animate-in fade-in slide-in-from-left-2 duration-150'
            )}
          >
            {getIcon()}
            <span className="text-sm text-stone-700 truncate max-w-[120px]">{displayName}</span>
            <button
              type="button"
              onClick={() => onRemove(attachment.id)}
              className={cn(
                'text-stone-400 hover:text-stone-600',
                'transition-colors duration-150',
                'focus:outline-none focus:ring-1 focus:ring-stone-400 focus:ring-offset-1 rounded-full'
              )}
              aria-label={`Remove ${displayName}`}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {displayName}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
