import type { ComponentProps, ComponentType, MouseEvent } from 'react'
import { useCallback } from 'react'

import type { AgentSourceRef } from '@memry/contracts/ipc-agent'
import type { InboxItemType } from '@memry/contracts/inbox-api'
import type { Tab } from '@/contexts/tabs/types'
import { useTabActions } from '@/contexts/tabs'
import { cn } from '@/lib/utils'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import {
  AlarmClock,
  Bell,
  Calendar2,
  CheckSquare3,
  FilePdf,
  FileText,
  Folder,
  Image,
  Link2,
  Mic,
  MessageCircle,
  NotificationSnooze,
  Quote,
  Share2,
  Video
} from '@/lib/icons'
import { SidebarCalendar, SidebarJournal, SidebarTasks } from '@/lib/icons/sidebar-nav-icons'
import { memryLinkClassName } from './memry-links-constants'

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
  source,
  onClick,
  ...props
}: ComponentProps<'a'> & { source?: AgentSourceRef | null }): React.JSX.Element {
  const navigate = useMemryLinkNavigation()
  const isMemryLink = typeof href === 'string' && href.startsWith('memry://')
  const rawLabel = isMemryLink && source?.title ? source.title : children
  const { icon: inlineIcon, label: labelChildren } = isMemryLink
    ? splitEdgeIcon(rawLabel)
    : { icon: null, label: rawLabel }

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (event.defaultPrevented || !isMemryLink || typeof href !== 'string') return

    event.preventDefault()
    navigate(href, source?.title ?? textFromLink(event.currentTarget))
  }

  return (
    <a
      className={cn(
        isMemryLink && memryLinkClassName,
        isMemryLink && 'inline-flex items-center gap-1 align-baseline leading-[inherit]',
        className
      )}
      href={href}
      onClick={handleClick}
      {...props}
    >
      {isMemryLink ? (
        <>
          <MemryLinkIcon href={href} source={source} fallbackIcon={inlineIcon} />
          <span data-agent-link-label>{labelChildren}</span>
        </>
      ) : (
        children
      )}
    </a>
  )
}

const EMOJI_SOURCE =
  '\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier}|\\u200D\\p{Extended_Pictographic}|\\uFE0F\\u200D\\p{Extended_Pictographic})*'
const LEADING_EMOJI = new RegExp(`^(${EMOJI_SOURCE})\\s+`, 'u')
const TRAILING_EMOJI = new RegExp(`\\s+(${EMOJI_SOURCE})$`, 'u')

/**
 * Backends often spell a note's own icon into the link text ("Watchlist 2026 🎬").
 * Lift that emoji out of the label so it renders as the item icon instead of
 * sitting next to the generic fallback one.
 */
export function splitEdgeIcon(label: React.ReactNode): {
  icon: string | null
  label: React.ReactNode
} {
  if (typeof label !== 'string') return { icon: null, label }

  const text = label.trim()
  const leading = LEADING_EMOJI.exec(text)
  if (leading) return { icon: leading[1], label: text.slice(leading[0].length) }

  const trailing = TRAILING_EMOJI.exec(text)
  if (trailing) return { icon: trailing[1], label: text.slice(0, trailing.index) }

  return { icon: null, label }
}

type LinkIconComponent = ComponentType<{ className?: string }>
type LinkIconDescriptor =
  | { kind: 'component'; label: string; Icon: LinkIconComponent }
  | { kind: 'note'; label: string; noteIcon: string }
  | { kind: 'glyph'; label: string; glyph: string }

const INBOX_TYPE_ICONS: Record<InboxItemType, LinkIconComponent> = {
  link: Link2,
  note: FileText,
  image: Image,
  voice: Mic,
  video: Video,
  clip: Quote,
  pdf: FilePdf,
  social: Share2,
  reminder: Bell
}

const INBOX_VISUAL_TYPE_ICONS: Record<string, LinkIconComponent> = {
  quote: Quote,
  social: MessageCircle
}

const CALENDAR_VISUAL_TYPE_ICONS: Record<string, LinkIconComponent> = {
  event: Calendar2,
  external_event: Calendar2,
  task: CheckSquare3,
  reminder: AlarmClock,
  snooze: NotificationSnooze
}

function resolveMemryLinkIcon(
  href?: string,
  source?: AgentSourceRef | null,
  fallbackIcon?: string | null
): LinkIconDescriptor | null {
  const parsed = typeof href === 'string' ? parseMemryHref(href) : null
  const kind = source?.kind ?? parsed?.kind
  if (!kind) return null

  // An item's own icon always wins over the per-type default.
  const customIcon = source?.icon ?? fallbackIcon
  if (customIcon) {
    return {
      kind: 'note',
      label: kind === 'note' ? 'note-custom' : `${kind}-custom`,
      noteIcon: customIcon
    }
  }

  if (kind === 'note') {
    return { kind: 'component', label: 'note-default', Icon: FileText }
  }

  if (kind === 'task') return { kind: 'component', label: 'task', Icon: SidebarTasks }

  if (kind === 'inbox') {
    const visualIcon = iconForCalendarVisualType(source?.visualType)
    if (visualIcon) {
      return { kind: 'component', label: `calendar-${source?.visualType}`, Icon: visualIcon }
    }

    if (source?.visualType === 'twitter') {
      return { kind: 'glyph', label: 'inbox-twitter', glyph: 'X' }
    }

    const inboxVisualIcon = iconForInboxVisualType(source?.visualType)
    if (inboxVisualIcon) {
      return {
        kind: 'component',
        label: `inbox-${source?.visualType}`,
        Icon: inboxVisualIcon
      }
    }

    const inboxIcon = iconForInboxType(source?.itemType)
    return {
      kind: 'component',
      label: `inbox-${source?.itemType ?? 'default'}`,
      Icon: inboxIcon
    }
  }

  if (kind === 'journal') return { kind: 'component', label: 'journal', Icon: SidebarJournal }

  if (kind === 'calendar_event') {
    return {
      kind: 'component',
      label: `calendar-${source?.visualType ?? 'event'}`,
      Icon: iconForCalendarVisualType(source?.visualType) ?? SidebarCalendar
    }
  }

  if (kind === 'project' || kind === 'folder') {
    return { kind: 'component', label: kind, Icon: Folder }
  }

  return null
}

function iconForInboxType(value: string | undefined): LinkIconComponent {
  return isInboxItemType(value) ? INBOX_TYPE_ICONS[value] : FileText
}

function iconForInboxVisualType(value: string | undefined): LinkIconComponent | null {
  return value ? (INBOX_VISUAL_TYPE_ICONS[value] ?? null) : null
}

function isInboxItemType(value: string | undefined): value is InboxItemType {
  return Boolean(value && value in INBOX_TYPE_ICONS)
}

function iconForCalendarVisualType(value: string | undefined): LinkIconComponent | null {
  return value ? (CALENDAR_VISUAL_TYPE_ICONS[value] ?? null) : null
}

export function MemryLinkIcon({
  href,
  source,
  fallbackIcon,
  className
}: {
  href?: string
  source?: AgentSourceRef | null
  fallbackIcon?: string | null
  className?: string
}): React.JSX.Element | null {
  const resolved = resolveMemryLinkIcon(href, source, fallbackIcon)
  if (!resolved) return null
  const iconClassName = cn('size-3.5 shrink-0', className)

  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center self-center align-middle"
      data-agent-link-icon={resolved.label}
    >
      {resolved.kind === 'note' ? (
        <NoteIconDisplay
          value={resolved.noteIcon}
          className={cn(iconClassName, 'text-[0.8125rem]')}
        />
      ) : resolved.kind === 'glyph' ? (
        <span className={cn(iconClassName, 'font-heading text-[0.75rem] font-bold leading-none')}>
          {resolved.glyph}
        </span>
      ) : (
        <resolved.Icon className={iconClassName} />
      )}
    </span>
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

function textFromLink(link: HTMLAnchorElement): string | undefined {
  const text = link.querySelector('[data-agent-link-label]')?.textContent?.trim()
  return text || undefined
}
