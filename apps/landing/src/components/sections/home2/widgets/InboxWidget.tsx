import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Archive,
  Check,
  ChevronRight,
  Clock,
  FileText,
  Link as LinkIcon,
  Link2,
  Mic,
  Paperclip,
  Send
} from 'lucide-react'
import { cn } from '@/lib/utils'

type ItemType = 'note' | 'link' | 'voice'

interface InboxItem {
  id: number
  type: ItemType
  title: string
  time: string
  domain?: string
  duration?: string
  fresh?: boolean
}

/* Hardcoded fiction — deterministic first render, no real clock. */
const SEED_ITEMS: InboxItem[] = [
  { id: 1, type: 'note', title: 'Idea: quieter home screen', time: '2m' },
  {
    id: 2,
    type: 'link',
    title: 'field-notes.blog/slow-mornings',
    domain: 'field-notes.blog',
    time: '1h'
  },
  { id: 3, type: 'voice', title: 'Voice memo', duration: '0:42', time: '3h' }
]

const URL_PATTERN = /^(https?:\/\/)?[\w-]+(\.[a-z]{2,})+(\/\S*)?$/i

const SPRING = { type: 'spring', duration: 0.35, bounce: 0 } as const
const EXIT = {
  opacity: 0,
  height: 0,
  paddingTop: 0,
  paddingBottom: 0,
  scale: 0.98,
  transition: { duration: 0.2, ease: 'easeIn' as const }
}

function toDomain(raw: string) {
  return raw
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
}

/** Per-type glyph colors match the desktop app (bare 14px glyphs, no chip behind). */
function TypeIcon({ type }: { type: ItemType }) {
  if (type === 'link') return <Link2 aria-hidden className="h-3.5 w-3.5 shrink-0 text-[#6366f1]" />
  if (type === 'voice') return <Mic aria-hidden className="h-3.5 w-3.5 shrink-0 text-terracotta" />
  return <FileText aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted/60" />
}

/**
 * Interactive replica of the desktop app's inbox: compact dashed capture input on top,
 * grouped rows below with hover-revealed snooze/archive actions and an undo toast.
 * Local state only — sample data is fiction, nothing leaves the page.
 */
export function InboxWidget({ className }: { className?: string }) {
  const [items, setItems] = useState<InboxItem[]>(SEED_ITEMS)
  const [value, setValue] = useState('')
  const [open, setOpen] = useState(true)
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set())
  const [toast, setToast] = useState<{ message: string } | null>(null)
  const nextId = useRef(4)
  const removedRef = useRef<{ item: InboxItem; index: number } | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => clearTimeout(toastTimer.current), [])

  const trimmed = value.trim()
  const canSubmit = trimmed.length > 0
  const looksLikeUrl = URL_PATTERN.test(trimmed)
  const hasSelection = selected.size > 0

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSubmit) return
    const id = nextId.current++
    const item: InboxItem = looksLikeUrl
      ? {
          id,
          type: 'link',
          title: trimmed.replace(/^https?:\/\//i, ''),
          domain: toDomain(trimmed),
          time: 'now',
          fresh: true
        }
      : { id, type: 'note', title: trimmed, time: 'now', fresh: true }
    setItems((prev) => [item, ...prev])
    setValue('')
  }

  function removeItem(item: InboxItem, message: string) {
    const index = items.findIndex((i) => i.id === item.id)
    if (index === -1) return
    removedRef.current = { item: { ...item, fresh: false }, index }
    setItems((prev) => prev.filter((i) => i.id !== item.id))
    if (selected.has(item.id)) {
      setSelected((prev) => {
        const next = new Set(prev)
        next.delete(item.id)
        return next
      })
    }
    setToast({ message })
    clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 3500)
  }

  function undoRemove() {
    const restore = removedRef.current
    if (!restore) return
    removedRef.current = null
    clearTimeout(toastTimer.current)
    setToast(null)
    setItems((prev) => {
      const next = [...prev]
      next.splice(Math.min(restore.index, next.length), 0, restore.item)
      return next
    })
  }

  function toggleSelect(id: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div
      className={cn(
        'relative w-full rounded-xl border border-border/70 bg-card p-2 text-start shadow-sm',
        className
      )}
    >
      {/* Compact capture input — dashed border, leading icon swaps to link while typing a URL */}
      <form
        onSubmit={handleSubmit}
        className={cn(
          'group flex items-center gap-1.5 rounded-md border-[1.5px] border-dashed border-border',
          'px-2.5 py-1 transition-colors duration-150 hover:border-muted/50',
          'focus-within:border-terracotta/60 focus-within:bg-terracotta/5'
        )}
      >
        {looksLikeUrl ? (
          <LinkIcon
            aria-hidden
            className="h-3.5 w-3.5 shrink-0 text-muted/50 transition-colors group-focus-within:text-terracotta"
          />
        ) : (
          <FileText
            aria-hidden
            className="h-3.5 w-3.5 shrink-0 text-muted/50 transition-colors group-focus-within:text-terracotta"
          />
        )}
        <input
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          aria-label="Capture a link or thought"
          placeholder="Capture a link or thought..."
          className="min-w-0 flex-1 bg-transparent text-xs leading-[18px] text-ink placeholder:text-muted/60 focus:outline-none"
        />
        <kbd
          aria-hidden
          className={cn(
            'shrink-0 overflow-hidden rounded-[3px] border border-border bg-ink/5 px-1',
            'font-mono-accent text-[9px] text-muted transition-all duration-150',
            'group-focus-within:w-0 group-focus-within:border-0 group-focus-within:px-0 group-focus-within:opacity-0'
          )}
        >
          Q
        </kbd>
        <span
          aria-hidden
          className="flex h-5 w-5 shrink-0 items-center justify-center text-muted/50 transition-colors duration-150 hover:text-muted"
        >
          <Paperclip className="h-3 w-3" />
        </span>
        <span
          aria-hidden
          className="flex h-5 w-5 shrink-0 items-center justify-center text-muted/50 transition-all duration-150 hover:text-muted active:scale-90"
        >
          <Mic className="h-3 w-3" />
        </span>
        <button
          type="submit"
          disabled={!canSubmit}
          aria-label="Add to inbox"
          className={cn(
            'flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-colors duration-150',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60',
            canSubmit ? 'bg-terracotta text-white' : 'text-muted/30'
          )}
        >
          <Send className="h-3 w-3" />
        </button>
      </form>

      {/* "Today" section header — chevron rotates 90° when open */}
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className={cn(
          'mt-1 flex w-full items-center gap-1.5 rounded-md px-2 py-2 text-start',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60'
        )}
      >
        <ChevronRight
          aria-hidden
          className={cn(
            'h-2.5 w-2.5 shrink-0 text-muted/40 transition-transform duration-200',
            open && 'rotate-90'
          )}
        />
        <span className="text-xs font-semibold tracking-[0.02em] text-muted">Today</span>
        <span className="text-[11px] tabular-nums text-muted/50">{items.length}</span>
      </button>

      {open && (
        <ul className="space-y-px">
          <AnimatePresence initial={false}>
            {items.map((item) => {
              const isSelected = selected.has(item.id)
              return (
                <motion.li
                  key={item.id}
                  layout
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={EXIT}
                  transition={SPRING}
                  className={cn(
                    'group relative flex items-center gap-2.5 overflow-hidden rounded-md px-2 py-1.5',
                    'transition-colors duration-150 ease-out',
                    isSelected
                      ? 'bg-terracotta/5 ring-1 ring-inset ring-terracotta/25'
                      : 'hover:bg-paper-alt'
                  )}
                >
                  {/* Fresh-capture wash — terracotta tint fading out over 1.4s */}
                  {item.fresh && (
                    <motion.span
                      aria-hidden
                      className="pointer-events-none absolute inset-0 rounded-md bg-terracotta/10"
                      initial={{ opacity: 1 }}
                      animate={{ opacity: 0 }}
                      transition={{ duration: 1.4, ease: 'easeOut' }}
                    />
                  )}

                  {/* Checkbox — hidden until hover/focus or when any row is selected */}
                  <button
                    type="button"
                    onClick={() => toggleSelect(item.id)}
                    aria-pressed={isSelected}
                    aria-label={`Select ${item.title}`}
                    className={cn(
                      'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border',
                      'transition-opacity duration-150 focus-visible:opacity-100',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60',
                      isSelected || hasSelection
                        ? 'opacity-100'
                        : 'opacity-0 group-hover:opacity-100',
                      isSelected ? 'border-brand-600 bg-brand-600' : 'border-muted/40'
                    )}
                  >
                    {isSelected && <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} />}
                  </button>

                  <TypeIcon type={item.type} />

                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink/90">
                    {item.title}
                  </span>

                  {/* Voice duration pill — fades out as hover actions appear */}
                  {item.type === 'voice' && item.duration && (
                    <span
                      className={cn(
                        'shrink-0 rounded-[10px] border border-terracotta/30 px-[7px] py-px',
                        'text-[11px] leading-[14px] text-terracotta transition-opacity duration-150',
                        'group-hover:opacity-0 group-focus-within:opacity-0'
                      )}
                    >
                      {item.duration}
                    </span>
                  )}

                  {/* Right slot: meta (domain + relative time) swaps to snooze/archive on hover */}
                  <span className="relative flex min-w-[3.75rem] shrink-0 items-center justify-end">
                    <span
                      className={cn(
                        'flex items-center gap-2 text-[11px] text-muted/60 transition-opacity',
                        'duration-150 group-hover:opacity-0 group-focus-within:opacity-0'
                      )}
                    >
                      {item.domain && <span className="truncate">{item.domain}</span>}
                      <span className="w-9 text-end tabular-nums">{item.time}</span>
                    </span>
                    <span
                      className={cn(
                        'pointer-events-none absolute inset-0 flex items-center justify-end gap-0.5',
                        'opacity-0 transition-opacity duration-150',
                        'group-hover:pointer-events-auto group-hover:opacity-100',
                        'group-focus-within:pointer-events-auto group-focus-within:opacity-100'
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => removeItem(item, 'Snoozed until tomorrow')}
                        aria-label={`Snooze ${item.title}`}
                        className={cn(
                          'rounded-md p-1.5 text-muted transition-all duration-100',
                          'hover:scale-110 hover:bg-paper-deep hover:text-ink active:scale-95',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60'
                        )}
                      >
                        <Clock className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => removeItem(item, 'Item archived')}
                        aria-label={`Archive ${item.title}`}
                        className={cn(
                          'rounded-md p-1.5 text-muted transition-all duration-100',
                          'hover:scale-110 hover:bg-paper-deep hover:text-ink active:scale-95',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60'
                        )}
                      >
                        <Archive className="h-4 w-4" />
                      </button>
                    </span>
                  </span>
                </motion.li>
              )
            })}
          </AnimatePresence>
          {items.length === 0 && (
            <li className="px-2 py-3 text-center text-xs text-muted/70">
              Inbox zero. Capture something above.
            </li>
          )}
        </ul>
      )}

      {/* Undo toast — mirrors the app's archive/snooze toast */}
      <div role="status" aria-live="polite">
        <AnimatePresence>
          {toast && (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              className={cn(
                'absolute inset-x-2 bottom-2 flex items-center justify-between gap-2 rounded-md',
                'border border-border bg-paper-alt px-3 py-1.5 shadow-sm'
              )}
            >
              <span className="truncate text-xs text-ink">{toast.message}</span>
              <button
                type="button"
                onClick={undoRemove}
                className={cn(
                  'shrink-0 rounded text-xs font-medium text-terracotta hover:underline',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60'
                )}
              >
                Undo
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
