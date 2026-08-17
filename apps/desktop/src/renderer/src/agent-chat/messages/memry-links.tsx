import type { ComponentProps, ComponentType, MouseEvent } from 'react'
import { useCallback } from 'react'

import type { AgentSourceRef } from '@memry/contracts/ipc-agent'
import type { InboxItemType } from '@memry/contracts/inbox-api'
import { useTabActions } from '@/contexts/tabs'
import { parseMemryHref, tabFromMemryHref } from '@/lib/memry-links'
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
import { useVaultItemIcon } from './use-vault-item-icon'

export function useMemryLinkNavigation(): (href: string, title?: string) => boolean {
  const { openTab } = useTabActions()

  return useCallback(
    (href: string, title?: string) => {
      // `now` stamps the focus token: clicking the same link twice must re-fire
      // the destination page's focus effect rather than look like a no-op.
      const tab = tabFromMemryHref(href, { title, now: Date.now() })
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
  customIcon?: string | null
): LinkIconDescriptor | null {
  const parsed = typeof href === 'string' ? parseMemryHref(href) : null
  const kind = source?.kind ?? parsed?.kind
  if (!kind) return null

  // An item's own icon always wins over the per-type default.
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
  const parsed = typeof href === 'string' ? parseMemryHref(href) : null
  // The vault is the source of truth for an item's icon; anything the backend
  // or model relayed (source refs, emoji spelled into the label) is a hint
  // that renders instantly and gets replaced when the lookup lands.
  const vaultIcon = useVaultItemIcon(parsed?.kind, parsed?.id)
  const resolved = resolveMemryLinkIcon(href, source, vaultIcon ?? source?.icon ?? fallbackIcon)
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

function textFromLink(link: HTMLAnchorElement): string | undefined {
  const text = link.querySelector('[data-agent-link-label]')?.textContent?.trim()
  return text || undefined
}
