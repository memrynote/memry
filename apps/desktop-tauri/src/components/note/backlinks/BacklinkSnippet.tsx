import { cn } from '@/lib/utils'
import type { Mention } from './types'

interface BacklinkSnippetProps {
  mention: Mention
  className?: string
}

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g

export function BacklinkSnippet({ mention, className }: BacklinkSnippetProps) {
  const { snippet } = mention

  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let key = 0

  for (const match of snippet.matchAll(WIKILINK_RE)) {
    const matchIndex = match.index!
    if (matchIndex > lastIndex) {
      parts.push(snippet.slice(lastIndex, matchIndex))
    }
    parts.push(
      <span key={key++} className="text-muted-foreground">
        {match[0]}
      </span>
    )
    lastIndex = matchIndex + match[0].length
  }

  if (lastIndex < snippet.length) {
    parts.push(snippet.slice(lastIndex))
  }

  if (parts.length === 0) {
    parts.push(snippet)
  }

  return (
    <p className={cn('text-xs/[17px] text-text-tertiary', 'line-clamp-3', className)}>{parts}</p>
  )
}
