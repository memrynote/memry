import { memo } from 'react'
import type { WikiLinkPreview } from '@/services/notes-service'
import { getTagColors, withAlpha } from '../note/tags-row/tag-colors'
import { format } from 'date-fns'
import { FileText } from '@/lib/icons'

const MAX_VISIBLE_TAGS = 3

interface TabPreviewCardProps {
  preview: WikiLinkPreview | null
  isLoading?: boolean
}

export const TabPreviewCard = memo(function TabPreviewCard({
  preview,
  isLoading = false
}: TabPreviewCardProps) {
  if (isLoading) {
    return (
      <div data-testid="tab-preview-skeleton" className="flex flex-col gap-2 p-3.5">
        <div className="h-4 w-3/4 rounded bg-muted animate-pulse" />
        <div className="h-3 w-full rounded bg-muted/60 animate-pulse" />
        <div className="h-3 w-2/3 rounded bg-muted/60 animate-pulse" />
        <div className="flex gap-1.5 mt-0.5">
          <div className="h-5 w-12 rounded-full bg-muted/40 animate-pulse" />
          <div className="h-5 w-10 rounded-full bg-muted/40 animate-pulse" />
        </div>
      </div>
    )
  }

  if (!preview) return null

  const visibleTags = preview.tags.slice(0, MAX_VISIBLE_TAGS)
  const overflowCount = preview.tags.length - MAX_VISIBLE_TAGS

  return (
    <div className="flex flex-col gap-1.5 py-3 px-3.5">
      <div className="flex items-center gap-1.5">
        {preview.emoji ? (
          <span className="text-sm shrink-0">{preview.emoji}</span>
        ) : (
          <FileText
            className="size-3.5 shrink-0"
            style={{ color: 'var(--text-tertiary)' }}
            aria-label="Note icon"
          />
        )}
        <span className="font-semibold text-[13px]/4 truncate text-text-bright">
          {preview.title}
        </span>
      </div>

      {preview.snippet && (
        <p
          data-testid="tab-preview-snippet"
          className="text-xs/[18px] line-clamp-3"
          style={{ color: 'var(--text-tertiary)' }}
        >
          {preview.snippet}
        </p>
      )}

      {preview.tags.length > 0 && (
        <div data-testid="tab-preview-tags" className="flex items-center gap-1.5 flex-wrap">
          {visibleTags.map((tag) => {
            const colors = getTagColors(tag.color)
            return (
              <span
                key={tag.name}
                className="inline-flex items-center rounded-[10px] py-0.5 px-2 text-[11px]/3.5 font-medium"
                style={{
                  backgroundColor: withAlpha(colors.text, 0.12),
                  color: colors.text
                }}
              >
                {tag.name}
              </span>
            )
          })}
          {overflowCount > 0 && (
            <span
              className="inline-flex items-center rounded-[10px] py-0.5 px-2 text-[11px]/3.5 font-medium"
              style={{ color: 'var(--text-tertiary)' }}
            >
              +{overflowCount}
            </span>
          )}
        </div>
      )}

      <div className="flex justify-end">
        <span className="text-[11px]/3.5" style={{ color: 'var(--text-tertiary)' }}>
          {format(new Date(preview.createdAt), 'MMM d, yyyy')}
        </span>
      </div>
    </div>
  )
})
