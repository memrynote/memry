import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlarmClock,
  Bookmark,
  ChevronLeft,
  EllipsisVertical,
  FileText,
  Plus,
  X
} from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Interactive replica of the MemryNote desktop note editor for the Notes mega-card.
 * Faithful to the real note page: floating translucent chrome with a scroll-edge
 * shadow, 42px-style title, tinted-text tag chips, hover-only ghost affordances,
 * BlockNote-style blocks (editable), a togglable todo, and a wiki-link whose
 * hover raises a preview card after 300ms with a 100ms leave grace.
 */

/* Muted tag palette hashed from name in the app — hardcoded per sample tag here. */
const TAG_COLORS: Record<string, string> = {
  travel: '#64A0D8',
  ideas: '#7CB86C',
  summer: '#C4A44E'
}

const TAG_POOL = ['travel', 'ideas', 'summer'] as const

const GHOST_BUTTON =
  'flex h-7 w-7 items-center justify-center rounded-md text-muted transition-[color,background-color,transform] duration-150 ease-out hover:bg-paper-deep hover:text-ink active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60'

const CRUMB_BUTTON =
  'rounded-sm px-1 py-0.5 text-muted transition-colors duration-150 hover:bg-paper-deep hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60'

const GHOST_PILL =
  'inline-flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-1 text-xs text-muted transition-colors duration-150 hover:border-muted/60 hover:text-ink focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60 disabled:pointer-events-none disabled:opacity-40'

interface PreviewPos {
  x: number
  y: number
}

interface NoteEditorWidgetProps {
  className?: string
}

export function NoteEditorWidget({ className }: NoteEditorWidgetProps) {
  const [scrolled, setScrolled] = useState(false)
  const [bookmarked, setBookmarked] = useState(false)
  const [tags, setTags] = useState<string[]>(['travel', 'ideas'])
  const [showStatus, setShowStatus] = useState(false)
  const [carDone, setCarDone] = useState(false)
  const [dinnerDone, setDinnerDone] = useState(true)
  const [preview, setPreview] = useState<PreviewPos | null>(null)

  const rootRef = useRef<HTMLDivElement>(null)
  const linkRef = useRef<HTMLSpanElement>(null)
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (showTimer.current) clearTimeout(showTimer.current)
      if (hideTimer.current) clearTimeout(hideTimer.current)
    },
    []
  )

  const openPreview = () => {
    const root = rootRef.current
    const link = linkRef.current
    if (!root || !link) return
    const rootRect = root.getBoundingClientRect()
    const linkRect = link.getBoundingClientRect()
    setPreview({
      x: Math.max(8, Math.min(linkRect.left - rootRect.left, rootRect.width - 268)),
      y: linkRect.bottom - rootRect.top + 6
    })
  }

  const cancelTimers = () => {
    if (showTimer.current) clearTimeout(showTimer.current)
    if (hideTimer.current) clearTimeout(hideTimer.current)
  }

  /* App behavior: card appears after 300ms of hover, survives a 100ms leave grace. */
  const handleLinkEnter = () => {
    cancelTimers()
    showTimer.current = setTimeout(openPreview, 300)
  }

  const handleLinkLeave = () => {
    cancelTimers()
    hideTimer.current = setTimeout(() => setPreview(null), 100)
  }

  const handleCardEnter = () => cancelTimers()

  const closePreview = () => {
    cancelTimers()
    setPreview(null)
  }

  const hiddenTags = TAG_POOL.filter((tag) => !tags.includes(tag))

  return (
    <div
      ref={rootRef}
      className={cn(
        'relative w-full overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm',
        className
      )}
    >
      {/* ── Floating chrome — content scrolls under it; shadow only once scrolled ── */}
      <div
        className="absolute inset-x-0 top-0 z-10 flex h-9 items-center justify-between bg-card/65 px-3 text-xs backdrop-blur-md backdrop-saturate-150 transition-shadow duration-200 ease-out sm:px-4"
        style={{
          boxShadow: scrolled
            ? '0 1px 0 0 color-mix(in srgb, var(--color-border) 55%, transparent), 0 4px 16px -8px rgb(0 0 0 / 0.1)'
            : 'none'
        }}
      >
        <div className="flex min-w-0 items-center gap-0.5">
          <button type="button" aria-label="Back" className={cn(GHOST_BUTTON, 'active:scale-90')}>
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button type="button" className={CRUMB_BUTTON}>
            Notes
          </button>
          <span aria-hidden className="text-muted/50">
            /
          </span>
          <button type="button" className={CRUMB_BUTTON}>
            Travel
          </button>
          <span aria-hidden className="text-muted/50">
            /
          </span>
          <span className="max-w-[140px] truncate ps-1 text-muted/60">Weekend in Kaş</span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button type="button" aria-label="Set reminder" className={GHOST_BUTTON}>
            <AlarmClock className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="Bookmark note"
            aria-pressed={bookmarked}
            onClick={() => setBookmarked((value) => !value)}
            className={cn(GHOST_BUTTON, bookmarked && 'text-terracotta hover:text-terracotta')}
          >
            <Bookmark className="h-3.5 w-3.5" fill={bookmarked ? 'currentColor' : 'none'} />
          </button>
          <button type="button" aria-label="More options" className={GHOST_BUTTON}>
            <EllipsisVertical className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* ── Scrollable note canvas ── */}
      <div
        className="h-[400px] overflow-y-auto sm:h-[440px]"
        onScroll={(event) => {
          setScrolled(event.currentTarget.scrollTop > 0)
          if (preview) closePreview()
        }}
      >
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ type: 'spring', duration: 0.35, bounce: 0 }}
          className="mx-auto max-w-[560px] px-6 pb-24 pt-[60px] sm:px-10"
        >
          {/* Metadata zone — ghost affordances fade in only while hovering here */}
          <div className="group/meta flex flex-col gap-2.5 pb-4">
            <h3
              contentEditable
              suppressContentEditableWarning
              spellCheck={false}
              aria-label="Note title"
              className="text-[26px] font-medium leading-[1.2] tracking-[-0.02em] text-ink outline-none sm:text-[30px]"
            >
              Weekend in Kaş
            </h3>

            {showStatus && (
              <div className="flex items-center gap-2 text-xs">
                <span className="w-16 shrink-0 text-muted">Status</span>
                <span className="rounded-md bg-paper-deep px-1.5 py-0.5 font-medium text-ink">
                  Draft
                </span>
              </div>
            )}

            <div className="flex min-h-8 flex-wrap items-center gap-2">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="group/chip relative inline-flex cursor-pointer rounded-full px-2.5 py-1 text-xs font-medium transition-opacity duration-150 hover:opacity-80"
                  style={{ backgroundColor: `${TAG_COLORS[tag]}1F`, color: TAG_COLORS[tag] }}
                >
                  {tag}
                  <button
                    type="button"
                    aria-label={`Remove tag ${tag}`}
                    onClick={() => setTags((value) => value.filter((item) => item !== tag))}
                    className="absolute -end-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#78716c] text-white opacity-0 shadow-sm transition-[opacity,transform] duration-150 hover:scale-110 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60 group-hover/chip:opacity-100"
                  >
                    <X className="h-2 w-2" strokeWidth={3} />
                  </button>
                </span>
              ))}
            </div>

            <div className="flex items-center gap-2 opacity-0 transition-opacity duration-200 group-focus-within/meta:opacity-100 group-hover/meta:opacity-100">
              <button
                type="button"
                aria-pressed={showStatus}
                onClick={() => setShowStatus((value) => !value)}
                className={GHOST_PILL}
              >
                <Plus className="h-3 w-3" />
                Add property
              </button>
              <button
                type="button"
                disabled={hiddenTags.length === 0}
                onClick={() =>
                  setTags((value) => (hiddenTags[0] ? [...value, hiddenTags[0]] : value))
                }
                className={GHOST_PILL}
              >
                <Plus className="h-3 w-3" />
                Add tag
              </button>
            </div>
          </div>

          {/* Body — BlockNote-style blocks, each text span editable */}
          <div className="text-[15px] leading-[1.5] text-ink">
            <h4
              contentEditable
              suppressContentEditableWarning
              spellCheck={false}
              className="py-0.5 text-[22px] font-semibold leading-[1.3] outline-none"
            >
              Where to stay
            </h4>

            <p
              contentEditable
              suppressContentEditableWarning
              spellCheck={false}
              className="py-0.5 outline-none"
            >
              Two nights near the old harbour. The shortlist from last spring lives in{' '}
              <span
                ref={linkRef}
                contentEditable={false}
                role="button"
                tabIndex={0}
                aria-label="Preview linked note: Kaş travel notes"
                onMouseEnter={handleLinkEnter}
                onMouseLeave={handleLinkLeave}
                onFocus={openPreview}
                onBlur={handleLinkLeave}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') closePreview()
                }}
                className="cursor-pointer px-0.5 font-medium text-brand-600 transition-colors duration-200 hover:underline focus-visible:underline focus-visible:outline-none"
              >
                Kaş travel notes
              </span>{' '}
              — start there, then book whatever still has a sea view.
            </p>

            <h4
              contentEditable
              suppressContentEditableWarning
              spellCheck={false}
              className="mt-[18px] py-0.5 text-[22px] font-semibold leading-[1.3] outline-none"
            >
              Saturday plan
            </h4>

            <div className="flex py-0.5">
              <span aria-hidden className="w-6 shrink-0 select-none pe-1 text-center">
                •
              </span>
              <span
                contentEditable
                suppressContentEditableWarning
                spellCheck={false}
                className="min-w-0 flex-1 outline-none"
              >
                Morning swim at Küçük Çakıl
              </span>
            </div>
            <div className="flex py-0.5">
              <span aria-hidden className="w-6 shrink-0 select-none pe-1 text-center">
                •
              </span>
              <span
                contentEditable
                suppressContentEditableWarning
                spellCheck={false}
                className="min-w-0 flex-1 outline-none"
              >
                Boat to Kekova, back before sunset
              </span>
            </div>

            {/* Todos — own block type in the app: checkbox row, no bullet dot */}
            <div className="flex min-h-6 items-center py-0.5">
              <input
                type="checkbox"
                checked={carDone}
                onChange={() => setCarDone((value) => !value)}
                aria-label="Toggle todo: Book the rental car"
                className="me-2 ms-1 h-3.5 w-3.5 shrink-0 cursor-pointer accent-terracotta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60"
              />
              <span
                contentEditable
                suppressContentEditableWarning
                spellCheck={false}
                className={cn('min-w-0 flex-1 outline-none', carDone && 'line-through')}
              >
                Book the rental car
              </span>
            </div>
            <div className="flex min-h-6 items-center py-0.5">
              <input
                type="checkbox"
                checked={dinnerDone}
                onChange={() => setDinnerDone((value) => !value)}
                aria-label="Toggle todo: Reserve the harbour dinner"
                className="me-2 ms-1 h-3.5 w-3.5 shrink-0 cursor-pointer accent-terracotta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60"
              />
              <span
                contentEditable
                suppressContentEditableWarning
                spellCheck={false}
                className={cn('min-w-0 flex-1 outline-none', dinnerDone && 'line-through')}
              >
                Reserve the harbour dinner
              </span>
            </div>

            <p
              contentEditable
              suppressContentEditableWarning
              spellCheck={false}
              className="py-0.5 outline-none"
            >
              Pack light. One bag, one book, no laptop.
            </p>
          </div>
        </motion.div>
      </div>

      {/* ── Wiki-link hover preview card ── */}
      <AnimatePresence>
        {preview && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.97 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            onMouseEnter={handleCardEnter}
            onMouseLeave={handleLinkLeave}
            style={{ insetInlineStart: preview.x, top: preview.y, transformOrigin: 'top' }}
            className="absolute z-20 w-[260px] rounded-[10px] border border-border/70 bg-card px-3.5 py-3 shadow-card"
          >
            <div className="flex items-center gap-1.5">
              <FileText aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted" />
              <p className="truncate text-[13px] font-semibold text-ink">Kaş travel notes</p>
            </div>
            <p className="mt-1.5 line-clamp-3 text-xs leading-[18px] text-muted">
              Ferry times, the pension by the harbour, and the cove you can only reach on foot. Ask
              for the upstairs room — the one with the fig tree outside the window.
            </p>
            <div className="mt-2 flex items-center justify-between gap-2">
              <span
                className="rounded-[10px] px-2 py-0.5 text-[11px] font-medium"
                style={{ backgroundColor: `${TAG_COLORS.travel}1F`, color: TAG_COLORS.travel }}
              >
                travel
              </span>
              <span className="text-[11px] text-muted/80">Jul 6, 2026</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
