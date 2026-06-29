import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Bell,
  Calendar,
  Check,
  CheckSquare,
  FilePdf,
  FileText,
  Image,
  Link2,
  Mic,
  Scissors,
  Share2,
  Sparkles,
  Video,
  X
} from '@/lib/icons'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { cn } from '@/lib/utils'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { formatRelativeDate } from '@/lib/date-grouping'
import { useInboxList, useConvertToNote, useConvertToTask } from '@/hooks/use-inbox'
import { useConvertToEvent, useConvertToReminder } from '@/hooks/use-inbox-mutations'
import type { InboxItemListItem } from '@memry/rpc/inbox'
import type { InboxItemType } from '@memry/contracts/inbox-api'

const log = createLogger('Triage2')

type IconType = React.ComponentType<{ className?: string }>

const TYPE_ICONS: Record<InboxItemType, IconType> = {
  link: Link2,
  note: FileText,
  image: Image,
  voice: Mic,
  video: Video,
  clip: Scissors,
  pdf: FilePdf,
  social: Share2,
  reminder: Bell
}

type Destination = 'note' | 'task' | 'event' | 'reminder'
type TallyKey = Destination | 'skipped'

// Each destination owns a hue that stays hidden at rest and lights up on
// hover/keyboard-focus only — Restrained color, color-as-state not decoration.
const DESTINATIONS: {
  id: Destination
  Icon: IconType
  shortcut: string
  tileClass: string
  iconClass: string
}[] = [
  {
    id: 'note',
    Icon: FileText,
    shortcut: 'N',
    tileClass:
      'hover:border-accent-cyan/40 hover:bg-accent-cyan/[0.06] focus-visible:border-accent-cyan/40 focus-visible:bg-accent-cyan/[0.06]',
    iconClass: 'group-hover:text-accent-cyan group-focus-visible:text-accent-cyan'
  },
  {
    id: 'task',
    Icon: CheckSquare,
    shortcut: 'T',
    tileClass:
      'hover:border-accent-green/40 hover:bg-accent-green/[0.06] focus-visible:border-accent-green/40 focus-visible:bg-accent-green/[0.06]',
    iconClass: 'group-hover:text-accent-green group-focus-visible:text-accent-green'
  },
  {
    id: 'event',
    Icon: Calendar,
    shortcut: 'C',
    tileClass:
      'hover:border-accent-purple/40 hover:bg-accent-purple/[0.06] focus-visible:border-accent-purple/40 focus-visible:bg-accent-purple/[0.06]',
    iconClass: 'group-hover:text-accent-purple group-focus-visible:text-accent-purple'
  },
  {
    id: 'reminder',
    Icon: Bell,
    shortcut: 'R',
    tileClass:
      'hover:border-accent-orange/40 hover:bg-accent-orange/[0.06] focus-visible:border-accent-orange/40 focus-visible:bg-accent-orange/[0.06]',
    iconClass: 'group-hover:text-accent-orange group-focus-visible:text-accent-orange'
  }
]

const PRESETS: { id: string; get: () => Date }[] = [
  { id: 'tonight', get: presetTonight },
  { id: 'tomorrow', get: presetTomorrow },
  { id: 'nextWeek', get: presetNextWeek }
]

// ponytail: native datetime-local instead of a picker lib; presets cover the
// common cases, the input handles everything else.
function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function toLocalInputValue(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function presetTonight(): Date {
  const d = new Date()
  if (d.getHours() >= 18) d.setDate(d.getDate() + 1)
  d.setHours(18, 0, 0, 0)
  return d
}

function presetTomorrow(): Date {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(9, 0, 0, 0)
  return d
}

function presetNextWeek(): Date {
  const d = new Date()
  d.setDate(d.getDate() + 7)
  d.setHours(9, 0, 0, 0)
  return d
}

interface Triage2ViewProps {
  onExit: () => void
}

export function Triage2View({ onExit }: Triage2ViewProps): React.JSX.Element {
  const { t } = useT('inbox')
  const { items, hasMore, isLoading, loadMore } = useInboxList()

  const toNote = useConvertToNote()
  const toTask = useConvertToTask()
  const toEvent = useConvertToEvent()
  const toReminder = useConvertToReminder()

  // Freeze the queue once the whole inbox is loaded, so conversions evicting
  // items from the live cache don't shift the list out from under us.
  const [queue, setQueue] = useState<InboxItemListItem[] | null>(null)
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const [picker, setPicker] = useState<'event' | 'reminder' | null>(null)
  const [when, setWhen] = useState('')
  const [tally, setTally] = useState<Record<TallyKey, number>>({
    note: 0,
    task: 0,
    event: 0,
    reminder: 0,
    skipped: 0
  })

  useEffect(() => {
    if (queue !== null || isLoading) return
    if (hasMore) {
      loadMore()
      return
    }
    setQueue(items)
  }, [queue, isLoading, hasMore, items, loadMore])

  const total = queue?.length ?? 0
  const done = queue !== null && index >= total
  const current = queue && index < total ? queue[index] : null
  const handledCount = tally.note + tally.task + tally.event + tally.reminder

  const advance = useCallback(() => {
    setPicker(null)
    setWhen('')
    setIndex((i) => i + 1)
  }, [])

  const runAction = useCallback(
    async (dest: Destination, action: () => Promise<{ success: boolean; error?: string }>) => {
      if (busy || !current) return
      setBusy(true)
      try {
        const res = await action()
        if (!res.success) {
          toast.error(res.error || t('triage2.actionFailed'))
          return
        }
        setTally((prev) => ({ ...prev, [dest]: prev[dest] + 1 }))
        advance()
      } catch (err) {
        log.error('Triage2 action failed', err)
        toast.error(extractErrorMessage(err, t('triage2.actionFailed')))
      } finally {
        setBusy(false)
      }
    },
    [busy, current, advance, t]
  )

  const pick = useCallback(
    (dest: Destination) => {
      if (busy || !current) return
      if (dest === 'event' || dest === 'reminder') {
        setWhen(toLocalInputValue(presetTomorrow()))
        setPicker(dest)
        return
      }
      if (dest === 'note') void runAction('note', () => toNote.mutateAsync(current.id))
      else void runAction('task', () => toTask.mutateAsync({ itemId: current.id }))
    },
    [busy, current, runAction, toNote, toTask]
  )

  const skip = useCallback(() => {
    if (busy || !current) return
    setTally((prev) => ({ ...prev, skipped: prev.skipped + 1 }))
    advance()
  }, [busy, current, advance])

  const confirmWhen = useCallback(() => {
    if (!current || !picker || !when) return
    const at = new Date(when)
    if (Number.isNaN(at.getTime())) {
      toast.error(t('triage2.invalidDate'))
      return
    }
    if (at.getTime() <= Date.now()) {
      toast.error(t('triage2.pastDate'))
      return
    }
    const iso = at.toISOString()
    if (picker === 'event') {
      const endAt = new Date(at.getTime() + 60 * 60 * 1000).toISOString()
      void runAction('event', () =>
        toEvent.mutateAsync({ itemId: current.id, input: { startAt: iso, endAt, isAllDay: false } })
      )
    } else {
      void runAction('reminder', () =>
        toReminder.mutateAsync({ itemId: current.id, input: { remindAt: iso } })
      )
    }
  }, [current, picker, when, runAction, toEvent, toReminder, t])

  // Keyboard-first triage: this surface owns its keys (the inbox page bails
  // while Triage 2 is open), so plain letters are safe.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (picker) {
        if (e.key === 'Escape') {
          e.preventDefault()
          setPicker(null)
        } else if (e.key === 'Enter') {
          e.preventDefault()
          confirmWhen()
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        onExit()
        return
      }
      if (busy || !current) return
      const k = e.key.toLowerCase()
      if (k === 'n') {
        e.preventDefault()
        pick('note')
      } else if (k === 't') {
        e.preventDefault()
        pick('task')
      } else if (k === 'c') {
        e.preventDefault()
        pick('event')
      } else if (k === 'r') {
        e.preventDefault()
        pick('reminder')
      } else if (k === 's' || e.key === 'ArrowRight') {
        e.preventDefault()
        skip()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [picker, busy, current, confirmWhen, pick, skip, onExit])

  const progressPct = total === 0 ? 100 : Math.round((index / total) * 100)

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex items-center gap-3 px-4 min-h-[38px] shrink-0 border-b border-border/60">
        <span className="text-[12px] font-medium text-text-secondary tabular-nums shrink-0">
          {done || !current
            ? t('triage2.allDone')
            : t('triage2.progress', { current: index + 1, total })}
        </span>
        <div className="flex-1 h-1 rounded-full bg-surface-active overflow-hidden">
          <div
            className="h-full rounded-full bg-foreground/70 transition-[width] duration-300 ease-out motion-reduce:transition-none"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <button
          type="button"
          onClick={onExit}
          title={t('triage2.exit')}
          aria-label={t('triage2.exit')}
          className="flex items-center justify-center shrink-0 size-7 rounded-[5px] text-muted-foreground hover:bg-surface-active/60 hover:text-foreground transition-colors"
        >
          <X className="size-3.5" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto flex items-center justify-center p-6">
        {queue === null ? (
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <div className="size-5 rounded-full border-2 border-border border-t-foreground/60 animate-spin motion-reduce:animate-none" />
            <span className="text-[12px]">{t('triage2.loading')}</span>
          </div>
        ) : done || !current ? (
          <DoneScreen tally={tally} handledCount={handledCount} onExit={onExit} t={t} />
        ) : (
          <div className="w-full max-w-xl flex flex-col gap-6">
            <ItemCard item={current} />

            {picker ? (
              <WhenPanel
                mode={picker}
                value={when}
                busy={busy}
                onChange={setWhen}
                onConfirm={confirmWhen}
                onBack={() => setPicker(null)}
                t={t}
              />
            ) : (
              <div className="flex flex-col gap-3">
                <p className="text-[12px] text-muted-foreground">{t('triage2.prompt')}</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {DESTINATIONS.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => pick(d.id)}
                      disabled={busy}
                      className={cn(
                        'group relative flex flex-col items-center gap-2 rounded-lg border border-border bg-surface/40 px-3 py-4 transition-colors',
                        'focus-visible:outline-none disabled:opacity-50 disabled:pointer-events-none',
                        d.tileClass
                      )}
                    >
                      <kbd className="absolute top-1.5 end-1.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded border border-border bg-background text-[9px] font-semibold text-muted-foreground">
                        {d.shortcut}
                      </kbd>
                      <d.Icon
                        className={cn(
                          'size-5 text-muted-foreground transition-colors',
                          d.iconClass
                        )}
                      />
                      <span className="text-[13px] font-medium text-foreground">
                        {t(`triage2.dest.${d.id}`)}
                      </span>
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={skip}
                  disabled={busy}
                  className="flex items-center justify-center gap-1.5 py-2 text-[12px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                >
                  {t('triage2.skip')}
                  <kbd className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded border border-border bg-background text-[9px] font-semibold">
                    S
                  </kbd>
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function ItemCard({ item }: { item: InboxItemListItem }): React.JSX.Element {
  const TypeIcon = TYPE_ICONS[item.type]
  const body = item.excerpt || item.content || item.transcription || ''
  return (
    <article
      key={item.id}
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-6 shadow-sm animate-in fade-in-0 slide-in-from-bottom-2 duration-300 motion-reduce:animate-none"
    >
      <div className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
        <TypeIcon className="size-3.5" />
        <span>{formatRelativeDate(item.createdAt)}</span>
      </div>

      {item.thumbnailUrl && (
        <img
          src={item.thumbnailUrl}
          alt={item.title}
          loading="lazy"
          className="w-full max-h-56 rounded-lg object-cover"
        />
      )}

      {item.title && (
        <h2 className="text-xl font-semibold leading-snug text-foreground text-balance">
          {item.title}
        </h2>
      )}

      {body && (
        <p className="text-[13px] leading-relaxed text-text-secondary line-clamp-4 whitespace-pre-wrap">
          {body}
        </p>
      )}

      {item.sourceUrl && (
        <a
          href={item.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground transition-colors min-w-0"
        >
          <Link2 className="size-3.5 shrink-0" />
          <span className="truncate">{item.sourceUrl}</span>
        </a>
      )}

      {item.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {item.tags.slice(0, 5).map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-surface px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              #{tag}
            </span>
          ))}
        </div>
      )}
    </article>
  )
}

function WhenPanel({
  mode,
  value,
  busy,
  onChange,
  onConfirm,
  onBack,
  t
}: {
  mode: 'event' | 'reminder'
  value: string
  busy: boolean
  onChange: (v: string) => void
  onConfirm: () => void
  onBack: () => void
  t: (key: string, opts?: Record<string, unknown>) => string
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 animate-in fade-in-0 duration-200 motion-reduce:animate-none">
      <div className="flex items-center justify-between">
        <p className="text-[12px] text-muted-foreground">
          {mode === 'event' ? t('triage2.whenEvent') : t('triage2.whenReminder')}
        </p>
        <button
          type="button"
          onClick={onBack}
          className="text-[12px] text-muted-foreground hover:text-foreground transition-colors"
        >
          {t('triage2.back')}
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onChange(toLocalInputValue(p.get()))}
            className="rounded-full border border-border bg-surface/40 px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-active hover:text-foreground transition-colors"
          >
            {t(`triage2.preset.${p.id}`)}
          </button>
        ))}
      </div>

      <input
        type="datetime-local"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-border bg-background px-3 py-2 text-[13px] text-foreground outline-none focus-visible:border-foreground/30"
      />

      <button
        type="button"
        onClick={onConfirm}
        disabled={busy || !value}
        className="rounded-lg bg-primary px-4 py-2.5 text-[13px] font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
      >
        {mode === 'event' ? t('triage2.confirmEvent') : t('triage2.confirmReminder')}
      </button>
    </div>
  )
}

function DoneScreen({
  tally,
  handledCount,
  onExit,
  t
}: {
  tally: Record<TallyKey, number>
  handledCount: number
  onExit: () => void
  t: (key: string, opts?: Record<string, unknown>) => string
}): React.JSX.Element {
  const lines = useMemo(() => {
    const keys: TallyKey[] = ['note', 'task', 'event', 'reminder', 'skipped']
    return keys.filter((k) => tally[k] > 0).map((k) => t(`triage2.tally.${k}`, { count: tally[k] }))
  }, [tally, t])

  return (
    <div className="flex flex-col items-center gap-5 max-w-sm text-center animate-in fade-in-0 duration-300 motion-reduce:animate-none">
      <div
        className="flex items-center justify-center rounded-[28px] size-16 bg-accent-green/5 border border-accent-green/20"
        style={{
          backgroundImage:
            'radial-gradient(circle farthest-corner at 50% 50%, color-mix(in srgb, var(--accent-green) 12%, transparent) 0%, transparent 70%)'
        }}
      >
        {handledCount > 0 ? (
          <Check className="size-7 text-accent-green" />
        ) : (
          <Sparkles className="size-7 text-accent-green" />
        )}
      </div>

      <h2 className="text-lg font-medium text-foreground">{t('triage2.doneTitle')}</h2>
      <p className="text-[13px] text-muted-foreground">
        {t('triage2.doneBody', { count: handledCount })}
      </p>

      {lines.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[12px] text-text-secondary tabular-nums">
          {lines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={onExit}
        className="rounded-lg bg-primary px-5 py-2.5 text-[13px] font-medium text-primary-foreground hover:opacity-90 transition-opacity"
      >
        {t('triage2.doneButton')}
      </button>
    </div>
  )
}
