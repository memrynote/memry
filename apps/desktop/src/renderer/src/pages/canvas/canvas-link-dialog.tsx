/**
 * The canvas "Link to item" picker: search every linkable vault item and hand
 * the chosen one's `memry://` href back to the caller, which writes it onto the
 * selected shape.
 *
 * Filtering is ours (`shouldFilter={false}`) because rows arrive pre-filtered
 * from four different sources — the same arrangement the add-card picker uses.
 */

import React, { useEffect, useMemo, useState } from 'react'
import { Command } from 'cmdk'
import { useT } from '@memry/i18n/renderer'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import {
  Bell,
  FilePdf,
  FileText,
  Folder,
  Image,
  Link2,
  Mic,
  Quote,
  Share2,
  Video
} from '@/lib/icons'
import { SidebarCalendar, SidebarJournal, SidebarTasks } from '@/lib/icons/sidebar-nav-icons'
import { candidateKey, LINK_GROUP_ORDER, type LinkCandidate } from './canvas-link-candidates'
import { useCanvasLinkSearch } from './use-canvas-link-search'

type IconComponent = React.ComponentType<{ className?: string }>

const INBOX_ICONS: Record<string, IconComponent> = {
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

const KIND_ICONS: Record<string, IconComponent> = {
  note: FileText,
  file: FilePdf,
  task: SidebarTasks,
  calendar_event: SidebarCalendar,
  inbox: Link2,
  journal: SidebarJournal,
  project: Folder,
  folder: Folder
}

function RowIcon({ candidate }: { candidate: LinkCandidate }): React.JSX.Element {
  // An item's own icon always wins over the per-kind default — the same rule
  // agent-chat's links follow, so the two surfaces look alike.
  if (candidate.emoji) {
    return (
      <NoteIconDisplay
        value={candidate.emoji}
        className="flex size-4 shrink-0 items-center justify-center text-sm"
      />
    )
  }
  const Icon =
    (candidate.kind === 'inbox' && candidate.itemType
      ? INBOX_ICONS[candidate.itemType]
      : undefined) ??
    KIND_ICONS[candidate.kind] ??
    FileText
  return <Icon className="size-4 shrink-0 text-text-tertiary" aria-hidden="true" />
}

export interface CanvasLinkDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Receives the chosen item's `memry://` href. */
  onPick: (href: string, candidate: LinkCandidate) => void
}

export function CanvasLinkDialog({
  open,
  onOpenChange,
  onPick
}: CanvasLinkDialogProps): React.JSX.Element {
  const { t } = useT('common')
  const [query, setQuery] = useState('')
  const [value, setValue] = useState('')
  const { groups, hasResults, loading } = useCanvasLinkSearch(open, query)

  // Reset between openings so a stale query never greets the next one. The
  // query is genuinely owned state (the user types it), not something derived
  // from `open` — closing just discards it.
  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-you-might-not-need-an-effect/no-adjust-state-on-prop-change -- see above
      setQuery('')
    }
  }, [open])

  const first = useMemo(() => {
    for (const kind of LINK_GROUP_ORDER) {
      const candidate = groups[kind][0]
      if (candidate) return candidate
    }
    return null
  }, [groups])

  // cmdk resets its highlight to the first mounted row whenever the search
  // value changes; re-point it at the first real match so Enter links that.
  // Not derived state: arrow keys move the highlight from here on, so it has
  // to be storage cmdk can write back into, seeded on each new result set.
  useEffect(() => {
    // eslint-disable-next-line react-you-might-not-need-an-effect/no-derived-state -- see above
    setValue(first ? candidateKey(first) : '')
  }, [first])

  const groupLabels: Record<(typeof LINK_GROUP_ORDER)[number], string> = {
    note: t('canvas.link.groupNotes'),
    file: t('canvas.link.groupFiles'),
    task: t('canvas.link.groupTasks'),
    calendar_event: t('canvas.link.groupEvents'),
    inbox: t('canvas.link.groupInbox'),
    journal: t('canvas.link.groupJournals'),
    project: t('canvas.link.groupProjects'),
    folder: t('canvas.link.groupFolders')
  }

  const select = (candidate: LinkCandidate): void => {
    onPick(candidate.href, candidate)
    onOpenChange(false)
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      shouldFilter={false}
      value={value}
      onValueChange={setValue}
      label={t('canvas.link.title')}
      overlayClassName="fixed inset-0 z-50 bg-black/50"
      className="fixed start-1/2 top-24 z-50 w-[32rem] max-w-[90vw] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-card shadow-lg rtl:translate-x-1/2"
    >
      <Command.Input
        value={query}
        onValueChange={setQuery}
        data-testid="canvas-link-input"
        placeholder={t('canvas.link.placeholder')}
        className="w-full border-b border-border bg-transparent px-3 py-3 text-sm outline-none"
      />
      <Command.List className="max-h-80 overflow-y-auto p-2">
        {query.trim() === '' ? (
          <div
            data-testid="canvas-link-hint"
            className="px-2 py-6 text-center text-sm text-text-tertiary"
          >
            {t('canvas.link.hint')}
          </div>
        ) : null}
        {query.trim() !== '' && !hasResults && !loading ? (
          <div
            data-testid="canvas-link-empty"
            className="px-2 py-6 text-center text-sm text-text-tertiary"
          >
            {t('canvas.link.empty')}
          </div>
        ) : null}
        {LINK_GROUP_ORDER.map((kind) => {
          const items = groups[kind]
          if (items.length === 0) return null
          return (
            <Command.Group key={kind} heading={groupLabels[kind]}>
              {items.map((candidate) => {
                const key = candidateKey(candidate)
                return (
                  <Command.Item
                    key={key}
                    value={key}
                    data-testid={`canvas-link-item-${key}`}
                    onSelect={() => select(candidate)}
                    className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-2 text-sm data-[selected=true]:bg-muted"
                  >
                    <span className="mt-0.5 flex shrink-0 items-start">
                      <RowIcon candidate={candidate} />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-sm font-medium text-foreground">
                        {candidate.title}
                      </span>
                      {candidate.subtitle ? (
                        <span className="truncate text-xs text-text-tertiary">
                          {candidate.subtitle}
                        </span>
                      ) : null}
                    </span>
                  </Command.Item>
                )
              })}
            </Command.Group>
          )
        })}
      </Command.List>
    </Command.Dialog>
  )
}
