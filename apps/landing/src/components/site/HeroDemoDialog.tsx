import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { X } from 'lucide-react'
import { DemoPlayer } from '@/components/demo/DemoPlayer'

interface HeroDemoDialogProps {
  open: boolean
  onClose: () => void
}

/**
 * Lightbox that plays the full app demo (4 tabs) over the hero. Hand-rolled
 * portal to match the existing modal convention (VideoScene fullscreen expand,
 * MockupFrame lightbox) rather than pull in a dialog dependency: Escape + backdrop
 * close, body-scroll lock, and focus restore on close. The DemoPlayer only mounts
 * while open, so the ~5–9MB clips load on intent — never on hero paint.
 */
export function HeroDemoDialog({ open, onClose }: HeroDemoDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return

    previouslyFocused.current = document.activeElement as HTMLElement | null
    document.body.style.overflow = 'hidden'

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)

    const focusTimer = window.setTimeout(() => closeRef.current?.focus(), 0)

    return () => {
      window.removeEventListener('keydown', handleKey)
      window.clearTimeout(focusTimer)
      document.body.style.overflow = ''
      previouslyFocused.current?.focus?.()
    }
  }, [open, onClose])

  if (typeof document === 'undefined') return null

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label="MemryNote product demo"
          // bg + backdrop-blur live on THIS opacity-animating element, not a child: an
          // element's own opacity does not suppress its own backdrop-filter, but an
          // ancestor's opacity animation would (the filter/bg stays unpainted until a
          // repaint — e.g. a click). Same fix as the nav liquid-glass dropdowns.
          className="fixed inset-0 z-[100] flex items-center justify-center bg-ink/85 p-4 backdrop-blur-md md:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={onClose}
        >
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close demo"
            className="absolute top-4 end-4 z-20 flex h-10 w-10 items-center justify-center rounded-full border border-white/25 bg-paper/25 text-white shadow-[0_10px_30px_rgba(35,28,23,0.28)] backdrop-blur-xl transition-colors hover:bg-paper/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60"
          >
            <X className="h-5 w-5" strokeWidth={1.8} />
          </button>

          {/* Light paper panel = the exact surface the player expects. The ChapterRail's
              inactive cards are transparent by design (on the page they reveal the paper body
              bg); without this panel they'd reveal the dark dim and read as murky glass. */}
          <motion.div
            className="relative z-10 max-h-[88vh] w-full max-w-7xl overflow-y-auto rounded-2xl bg-paper p-4 shadow-2xl md:p-5"
            initial={{ opacity: 0, scale: 0.96, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 10 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            onClick={(event) => event.stopPropagation()}
          >
            <DemoPlayer initialEngaged />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}
