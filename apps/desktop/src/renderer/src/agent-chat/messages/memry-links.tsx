import type { ComponentProps, MouseEvent, ReactNode } from 'react'
import { useCallback } from 'react'

import type { Tab } from '@/contexts/tabs/types'
import { useTabActions } from '@/contexts/tabs'
import { cn } from '@/lib/utils'

const memryLinkClassName =
  'text-[#81B4E5] hover:underline hover:decoration-dotted underline-offset-2'

type OpenableTab = Omit<Tab, 'id' | 'openedAt' | 'lastAccessedAt'>

export function useMemryLinkNavigation(): (href: string, title?: string) => boolean {
  const { openTab } = useTabActions()

  return useCallback(
    (href: string, title?: string) => {
      const tab = tabFromMemryHref(href, title)
      if (!tab) return false
      openTab(tab)
      return true
    },
    [openTab]
  )
}

export function MemryLink({
  className,
  href,
  children,
  onClick,
  ...props
}: ComponentProps<'a'>): React.JSX.Element {
  const navigate = useMemryLinkNavigation()
  const isMemryLink = typeof href === 'string' && href.startsWith('memry://')

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (event.defaultPrevented || !isMemryLink || typeof href !== 'string') return

    event.preventDefault()
    navigate(href, textFromChildren(children))
  }

  return (
    <a
      className={cn(isMemryLink && memryLinkClassName, className)}
      href={href}
      onClick={handleClick}
      {...props}
    >
      {children}
    </a>
  )
}

function tabFromMemryHref(href: string, title?: string): OpenableTab | null {
  const parsed = parseMemryHref(href)
  if (!parsed) return null

  const base = {
    isPinned: false,
    isModified: false,
    isPreview: false,
    isDeleted: false
  }

  if (parsed.kind === 'note') {
    return {
      ...base,
      type: 'note',
      title: title ?? 'Note',
      icon: 'file-text',
      path: `/note/${parsed.id}`,
      entityId: parsed.id
    }
  }

  if (parsed.kind === 'task') {
    return {
      ...base,
      type: 'tasks',
      title: 'Tasks',
      icon: 'check-square',
      path: '/tasks',
      viewState: { openTaskId: parsed.id }
    }
  }

  if (parsed.kind === 'inbox') {
    return {
      ...base,
      type: 'inbox',
      title: 'Inbox',
      icon: 'inbox',
      path: '/inbox',
      viewState: { focusInboxItemId: parsed.id, focusedAt: Date.now() }
    }
  }

  if (parsed.kind === 'journal') {
    return {
      ...base,
      type: 'journal',
      title: `Journal - ${parsed.id}`,
      icon: 'book-open',
      path: `/journal/${parsed.id}`,
      entityId: parsed.id,
      viewState: { date: parsed.id }
    }
  }

  if (parsed.kind === 'calendar_event') {
    return {
      ...base,
      type: 'calendar',
      title: 'Calendar',
      icon: 'calendar',
      path: '/calendar',
      viewState: {
        focusCalendarEventId: parsed.id,
        focusDate: parsed.date,
        focusedAt: Date.now()
      }
    }
  }

  if (parsed.kind === 'project') {
    return {
      ...base,
      type: 'project',
      title: title ?? 'Project',
      icon: 'folder',
      path: `/project/${parsed.id}`,
      entityId: parsed.id
    }
  }

  if (parsed.kind === 'folder') {
    return {
      ...base,
      type: 'folder',
      title: title ?? parsed.id,
      icon: 'folder',
      path: `/folder/${encodeURIComponent(parsed.id)}`,
      entityId: parsed.id
    }
  }

  return null
}

type ParsedMemryHref =
  | { kind: 'note' | 'task' | 'inbox' | 'journal' | 'project' | 'folder'; id: string }
  | { kind: 'calendar_event'; id: string; date: string | null }

function parseMemryHref(href: string): ParsedMemryHref | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }

  if (url.protocol !== 'memry:') return null

  const id = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  if (!id) return null

  if (
    url.hostname === 'note' ||
    url.hostname === 'task' ||
    url.hostname === 'inbox' ||
    url.hostname === 'journal' ||
    url.hostname === 'project' ||
    url.hostname === 'folder'
  ) {
    return { kind: url.hostname, id }
  }

  if (url.hostname === 'calendar') {
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0] !== 'event' || !parts[1]) return null
    return {
      kind: 'calendar_event',
      id: decodeURIComponent(parts[1]),
      date: url.searchParams.get('date')
    }
  }

  return null
}

function textFromChildren(children: ReactNode): string | undefined {
  if (typeof children === 'string') return children
  if (typeof children === 'number') return String(children)
  if (!Array.isArray(children)) return undefined

  const text = children
    .map((child) => textFromChildren(child))
    .filter((value): value is string => Boolean(value))
    .join('')
    .trim()

  return text || undefined
}

export { memryLinkClassName }
