import { memo, useState } from 'react'
import type { ComponentType, FocusEvent, KeyboardEvent } from 'react'
import { motion } from 'framer-motion'
import {
  Bookmark,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  FileText,
  History,
  Maximize,
  MoreVertical,
  Settings,
  Type
} from 'lucide-react'
import { cn } from '@/lib/utils'

/* ── Hardcoded sample days (fiction — July 2026, deterministic for SSR) ── */

type FogKey = 'morning' | 'afternoon' | 'evening'

interface SampleDay {
  id: string
  title: string
  day: string
  modified: string
  isToday: boolean
  fog: FogKey
  placeholder: string
  seed: string
}

const DAYS: SampleDay[] = [
  {
    id: 'jul-8',
    title: 'Wednesday, July 8',
    day: '8',
    modified: 'Jul 8, 2026',
    isToday: false,
    fog: 'afternoon',
    placeholder: 'Reflect on this day...',
    seed: 'Slow start, better afternoon. Cleared the inbox and sketched the reading-corner idea.\n\nNote to self: fewer tabs, more walks.'
  },
  {
    id: 'jul-9',
    title: 'Thursday, July 9',
    day: '9',
    modified: 'Jul 9, 2026',
    isToday: false,
    fog: 'evening',
    placeholder: 'Reflect on this day...',
    seed: 'Finished the chapter draft before lunch. Long walk by the water — the quiet helped.\n\nTomorrow: call Mia, book the train tickets.'
  },
  {
    id: 'jul-10',
    title: 'Friday, July 10',
    day: '10',
    modified: 'Jul 10, 2026',
    isToday: true,
    fog: 'morning',
    placeholder: "What's on your mind today...",
    seed: 'Coffee first, then the plan. Three things today: ship the draft, water the plants, nothing else.'
  }
]

/* Time-of-day fog tints behind the date header (same rgba values as the app). */
const FOG_TINTS: Record<FogKey, [string, string]> = {
  morning: ['rgba(217,119,6,0.72)', 'rgba(245,158,11,0.55)'],
  afternoon: ['rgba(234,88,12,0.72)', 'rgba(249,115,22,0.55)'],
  evening: ['rgba(99,102,241,0.65)', 'rgba(129,140,248,0.5)']
}

const MENU_ITEMS: { icon: ComponentType<{ className?: string }>; label: string }[] = [
  { icon: History, label: 'Version history' },
  { icon: Download, label: 'Export' },
  { icon: Maximize, label: 'Focus mode' },
  { icon: Settings, label: 'Journal settings' }
]

const DAY_SWAP = { type: 'spring', bounce: 0, duration: 0.35 } as const

const CHEVRON_BTN =
  'flex h-6 w-6 items-center justify-center rounded-sm text-muted transition-all duration-150 ease-out hover:text-ink active:scale-90 disabled:pointer-events-none disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/50'

const GHOST_BTN =
  'flex h-7 w-7 items-center justify-center rounded-md text-muted transition-all duration-150 ease-out hover:bg-paper-deep hover:text-ink active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/50'

function countWords(text: string) {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}

/* ── Editor body — real contentEditable, seeded once per day, never re-rendered
      while typing (stats update via onInput without touching the DOM). ── */

interface EditorAreaProps {
  initialText: string
  placeholder: string
  onInput: (text: string) => void
}

const EditorArea = memo(
  function EditorArea({ initialText, placeholder, onInput }: EditorAreaProps) {
    return (
      <div
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        role="textbox"
        aria-multiline="true"
        aria-label="Journal entry — try typing"
        data-placeholder={placeholder}
        onInput={(e) => {
          const el = e.currentTarget
          if (!el.textContent?.trim()) el.innerHTML = ''
          onInput(el.textContent ?? '')
        }}
        className={cn(
          'min-h-[140px] flex-1 whitespace-pre-wrap pb-14 text-[15px] leading-relaxed',
          'text-ink caret-ink outline-none',
          'before:pointer-events-none before:text-muted/70',
          'empty:before:content-[attr(data-placeholder)]'
        )}
      >
        {initialText}
      </div>
    )
  },
  () => true
)

/* ── Fog — two blurred blobs drifting slowly behind the date (transform loop is
      disabled automatically for reduced-motion users via global MotionConfig). ── */

function DateFog({ fog }: { fog: FogKey }) {
  const [tintA, tintB] = FOG_TINTS[fog]
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 opacity-60 dark:opacity-30">
      <motion.div
        animate={{ x: [0, 12, -8, 0], y: [0, -4, 3, 0] }}
        transition={{ duration: 15, repeat: Infinity, ease: 'easeInOut' }}
        className="absolute -top-2 start-1 h-10 w-36 rounded-full blur-2xl"
        style={{ background: `radial-gradient(closest-side, ${tintA}, transparent)` }}
      />
      <motion.div
        animate={{ x: [0, -10, 7, 0], y: [0, 3, -4, 0] }}
        transition={{ duration: 19, repeat: Infinity, ease: 'easeInOut' }}
        className="absolute top-2 start-24 h-8 w-28 rounded-full blur-2xl"
        style={{ background: `radial-gradient(closest-side, ${tintB}, transparent)` }}
      />
    </div>
  )
}

/**
 * Interactive replica of the MemryNote journal day view — floating chrome bar with
 * prev/next day chevrons + breadcrumb, fog-lit date header, a really editable entry
 * body, and the sticky word-count footer. Everything is local state and fiction.
 */
export function JournalWidget({ className }: { className?: string }) {
  const [index, setIndex] = useState(DAYS.length - 1)
  const [entries, setEntries] = useState<Record<string, string>>(() =>
    Object.fromEntries(DAYS.map((d) => [d.id, d.seed]))
  )
  const [bookmarked, setBookmarked] = useState<Record<string, boolean>>({})
  const [menuOpen, setMenuOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)

  const day = DAYS[index]
  const text = entries[day.id]
  const words = countWords(text)
  const minutes = Math.max(1, Math.ceil(words / 200))

  const goTo = (next: number) => {
    if (next < 0 || next >= DAYS.length) return
    setMenuOpen(false)
    setIndex(next)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && menuOpen) {
      setMenuOpen(false)
      return
    }
    const target = e.target as HTMLElement
    if (target.isContentEditable) return
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      goTo(index - 1)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      goTo(index + 1)
    }
  }

  const handleMenuBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setMenuOpen(false)
  }

  return (
    <div
      onKeyDown={handleKeyDown}
      className={cn(
        'relative w-full overflow-hidden rounded-xl border border-border/70 bg-card shadow-sm',
        className
      )}
    >
      {/* Floating chrome — content scrolls under it; edge appears once scrolled */}
      <div
        className={cn(
          'absolute inset-x-0 top-0 z-10 flex h-9 items-center justify-between ps-3 pe-2',
          'bg-card/65 text-xs backdrop-blur-xl backdrop-saturate-150',
          'transition-shadow duration-200 ease-out',
          scrolled &&
            'shadow-[0_1px_0_color-mix(in_srgb,var(--color-border)_70%,transparent),0_4px_16px_-8px_rgb(0_0_0/0.1)]'
        )}
      >
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous day"
            disabled={index === 0}
            onClick={() => goTo(index - 1)}
            className={CHEVRON_BTN}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="Next day"
            disabled={index === DAYS.length - 1}
            onClick={() => goTo(index + 1)}
            className={CHEVRON_BTN}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          <span className="ms-1 flex items-center text-muted">
            <span className="rounded-sm px-1 py-0.5">2026</span>
            <span className="px-0.5 text-muted/60">/</span>
            <span className="rounded-sm px-1 py-0.5">July</span>
            <span className="px-0.5 text-muted/60">/</span>
            <span className="px-1 py-0.5 font-medium text-ink">{day.day}</span>
          </span>
          {day.isToday && (
            <span className="ms-1 rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-amber-700 dark:text-amber-400">
              Today
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label="Bookmark this day"
            aria-pressed={!!bookmarked[day.id]}
            onClick={() => setBookmarked((prev) => ({ ...prev, [day.id]: !prev[day.id] }))}
            className={GHOST_BTN}
          >
            <Bookmark
              className={cn('h-3.5 w-3.5', bookmarked[day.id] && 'fill-amber-500 text-amber-500')}
            />
          </button>
          <div className="relative" onBlur={handleMenuBlur}>
            <button
              type="button"
              aria-label="More options"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
              className={GHOST_BTN}
            >
              <MoreVertical className="h-3.5 w-3.5" />
            </button>
            {menuOpen && (
              <div
                role="menu"
                className="absolute end-0 top-full z-20 mt-1 w-44 rounded-lg border border-border bg-card p-1 shadow-lg"
              >
                {MENU_ITEMS.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    role="menuitem"
                    onClick={() => setMenuOpen(false)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-ink transition-colors hover:bg-paper-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/50"
                  >
                    <item.icon className="h-3.5 w-3.5 text-muted" />
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Scroll area — day content + sticky stats footer */}
      <div
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
        className="h-[340px] overflow-y-auto overscroll-contain"
      >
        <div className="flex min-h-full flex-col">
          <motion.div
            key={day.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={DAY_SWAP}
            className="flex flex-1 flex-col px-5 pt-13 sm:px-7"
          >
            <div className="relative mb-3">
              <DateFog fog={day.fog} />
              <p className="relative font-geist text-[26px] font-normal leading-tight tracking-[-0.02em] text-ink sm:text-[28px]">
                {day.title}
              </p>
            </div>
            <EditorArea
              initialText={text}
              placeholder={day.placeholder}
              onInput={(value) => setEntries((prev) => ({ ...prev, [day.id]: value }))}
            />
          </motion.div>
          <div className="sticky bottom-0 z-10 mt-auto flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-t border-border/40 bg-card/95 px-4 py-2 text-[11px] text-muted backdrop-blur-sm">
            <span className="flex items-center gap-1.5 whitespace-nowrap">
              <FileText className="h-3 w-3" />
              {words} words
            </span>
            <span aria-hidden className="text-border">
              ·
            </span>
            <span className="flex items-center gap-1.5 whitespace-nowrap">
              <Type className="h-3 w-3" />
              {text.length} characters
            </span>
            <span aria-hidden className="text-border">
              ·
            </span>
            <span className="flex items-center gap-1.5 whitespace-nowrap">
              <Clock className="h-3 w-3" />
              {minutes} min read
            </span>
            <span aria-hidden className="text-border">
              ·
            </span>
            <span className="flex items-center gap-1.5 whitespace-nowrap">
              <Calendar className="h-3 w-3" />
              Modified {day.modified}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
