import { memo } from 'react'
import { createPortal } from 'react-dom'
import type { WikiLinkPreview } from '@/services/notes-service'
import { getTagColors, withAlpha } from '../tags-row/tag-colors'
import { format } from 'date-fns'
import { FileText } from 'lucide-react'

interface WikiLinkPreviewCardProps {
  preview: WikiLinkPreview
  position: { top: number; left: number; placement: 'above' | 'below' }
  onMouseEnter: () => void
  onMouseLeave: () => void
  onTagClick?: (name: string, color: string) => void
  onNoteClick?: (title: string) => void
}

export const WikiLinkPreviewCard = memo(function WikiLinkPreviewCard({
  preview,
  position,
  onMouseEnter,
  onMouseLeave,
  onTagClick,
  onNoteClick
}: WikiLinkPreviewCardProps) {
  return createPortal(
    <div
      data-wiki-link-preview=""
      className="fixed z-50 w-[280px] rounded-[10px] border border-border/40 bg-popover shadow-[var(--shadow-dropdown)] animate-in fade-in-0 zoom-in-95 duration-150"
      style={{
        top: position.top,
        left: position.left,
        transformOrigin: position.placement === 'below' ? 'top left' : 'bottom left',
        color: 'var(--text-primary)'
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="flex flex-col gap-1.5 py-3 px-3.5">
        {/* Title + Snippet — clickable to open note */}
        <button
          type="button"
          onClick={() => onNoteClick?.(preview.title)}
          className="flex flex-col gap-1.5 text-left cursor-pointer rounded-md -mx-1 px-1 -my-0.5 py-0.5 transition-colors duration-150 hover:bg-[var(--surface-active)]"
        >
          <div className="flex items-center gap-1.5">
            {preview.emoji ? (
              <span className="text-sm shrink-0">{preview.emoji}</span>
            ) : (
              <FileText className="size-3.5 shrink-0" style={{ color: 'var(--text-tertiary)' }} />
            )}
            <span className="font-semibold text-[13px]/4 truncate text-text-bright">
              {preview.title}
            </span>
          </div>

          {preview.snippet && (
            <p className="text-xs/[18px] line-clamp-3" style={{ color: 'var(--text-tertiary)' }}>
              {preview.snippet}
            </p>
          )}
        </button>

        {/* Tags */}
        {preview.tags.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            {preview.tags.map((tag) => {
              const colors = getTagColors(tag.color)
              return (
                <button
                  key={tag.name}
                  type="button"
                  onClick={() => onTagClick?.(tag.name, tag.color)}
                  className="inline-flex items-center rounded-[10px] py-0.5 px-2 text-[11px]/3.5 font-medium cursor-pointer transition-opacity duration-150 hover:opacity-80"
                  style={{
                    backgroundColor: withAlpha(colors.text, 0.12),
                    color: colors.text
                  }}
                >
                  {tag.name}
                </button>
              )
            })}
          </div>
        )}

        {/* Date — always bottom-right */}
        <div className="flex justify-end">
          <span className="text-[11px]/3.5" style={{ color: 'var(--text-tertiary)' }}>
            {format(new Date(preview.createdAt), 'MMM d, yyyy')}
          </span>
        </div>
      </div>
    </div>,
    document.body
  )
})
