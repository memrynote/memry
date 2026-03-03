import { cn } from '@/lib/utils'
import type { Mention } from './types'

interface BacklinkSnippetProps {
  mention: Mention
  className?: string
}

export function BacklinkSnippet({ mention, className }: BacklinkSnippetProps) {
  const { snippet, linkStart, linkEnd } = mention

  // Extract parts: before link, the link itself, after link
  const beforeLink = snippet.slice(0, linkStart)
  const linkText = snippet.slice(linkStart, linkEnd)
  const afterLink = snippet.slice(linkEnd)

  return (
    <p className={cn('text-[13px] text-stone-500 leading-relaxed', 'line-clamp-3', className)}>
      <span className="italic">"</span>
      {beforeLink}
      <span className={cn('bg-yellow-200 px-0.5 rounded-sm', 'font-medium text-stone-700')}>
        {linkText}
      </span>
      {afterLink}
      <span className="italic">"</span>
    </p>
  )
}
