import { useState } from 'react'
import { cn } from '@/lib/utils'
import { ChevronDown } from '@/lib/icons'
import { BacklinkSnippet } from './BacklinkSnippet'
import type { Backlink, Mention } from './types'

interface BacklinkCardProps {
  backlink: Backlink
  defaultExpanded?: boolean
  onClick: (noteId: string, mention?: Mention) => void
}

export function BacklinkCard({ backlink, defaultExpanded = false, onClick }: BacklinkCardProps) {
  const { noteId, noteTitle, mentions } = backlink
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)

  return (
    <div role="group" aria-label={`Backlinks from ${noteTitle}`}>
      <div
        className={cn(
          'flex items-center gap-1.5 px-1.5 py-1',
          'rounded cursor-pointer select-none',
          'hover:bg-surface-active/40',
          'transition-colors duration-150'
        )}
      >
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-1.5 flex-1 min-w-0 focus:outline-none focus-visible:ring-1 focus-visible:ring-border rounded"
          aria-expanded={isExpanded}
          aria-label={isExpanded ? `Collapse ${noteTitle}` : `Expand ${noteTitle}`}
        >
          <ChevronDown
            className={cn(
              'h-3 w-3 text-text-tertiary flex-shrink-0 transition-transform duration-150',
              !isExpanded && '-rotate-90'
            )}
            aria-hidden="true"
          />
          <span
            role="link"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation()
              onClick(noteId)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                onClick(noteId)
              }
            }}
            className="text-[13px]/4 font-medium text-text-bright truncate hover:underline"
          >
            {noteTitle}
          </span>
        </button>

        {mentions.length > 1 && (
          <span className="flex-shrink-0 text-[11px] tabular-nums text-text-tertiary">
            {mentions.length}
          </span>
        )}
      </div>

      {isExpanded && mentions.length > 0 && (
        <div className="ml-5 flex flex-col gap-px" role="list">
          {mentions.map((mention) => (
            <div
              key={mention.id}
              role="button"
              tabIndex={0}
              onClick={() => onClick(noteId, mention)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onClick(noteId, mention)
                }
              }}
              className={cn(
                'rounded px-1.5 py-1',
                'hover:bg-surface-active/30',
                'transition-colors duration-150',
                'cursor-pointer',
                'focus:outline-none focus-visible:ring-1 focus-visible:ring-border'
              )}
            >
              <BacklinkSnippet mention={mention} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
