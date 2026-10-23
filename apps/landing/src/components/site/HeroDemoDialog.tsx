import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { X } from 'lucide-react'
import { trackLandingEvent, type LandingEventName } from '@/lib/analytics'

const DEMO_VIDEO = '/demos/memrynote-demo.mp4'
const DEMO_POSTER = '/demos/memrynote-demo-poster.webp'
const TARGET = 'demo:film'
const MILESTONES = [25, 50, 75] as const

interface HeroDemoDialogProps {
  open: boolean
  onClose: () => void
}

/**
 * Lightbox that plays the narrated product demo over the hero. Hand-rolled portal
 * (MockupFrame lightbox convention) rather than a dialog dependency: Escape + backdrop
 * close, body-scroll lock, and focus restore on close. The video only mounts while
 * open, so its ~6MB load on intent, never on hero paint. It starts with sound: the
 * click that opened the dialog is the user gesture browsers require for unmuted
 * autoplay. If a browser still refuses, it falls back to muted playback.
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

          <motion.div
            className="relative z-10 w-full max-w-[min(80rem,calc(88vh*16/9))] overflow-hidden rounded-2xl bg-ink shadow-2xl"
            initial={{ opacity: 0, scale: 0.96, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 10 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            onClick={(event) => {
              event.stopPropagation()
            }}
          >
            <DemoVideo />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}

function DemoVideo() {
  const ref = useRef<HTMLVideoElement>(null)
  const reached = useRef(new Set<number>())

  useEffect(() => {
    const video = ref.current
    if (!video) return
    video.play().catch(() => {
      video.muted = true
      void video.play()
    })
  }, [])

  const track = (name: LandingEventName) => {
    trackLandingEvent(name, TARGET)
  }

  return (
    <video
      ref={ref}
      src={DEMO_VIDEO}
      poster={DEMO_POSTER}
      controls
      playsInline
      preload="auto"
      aria-label="MemryNote product demo, narrated"
      className="block aspect-video w-full"
      onPlay={() => {
        track(reached.current.size ? 'landing_demo_resume' : 'landing_demo_start')
      }}
      onPause={(e) => {
        if (!e.currentTarget.ended) track('landing_demo_pause')
      }}
      onEnded={() => {
        track('landing_demo_complete')
      }}
      onVolumeChange={(e) => {
        track(e.currentTarget.muted ? 'landing_demo_mute' : 'landing_demo_unmute')
      }}
      onTimeUpdate={(e) => {
        const { currentTime, duration } = e.currentTarget
        reached.current.add(0)
        for (const m of MILESTONES) {
          if (duration && currentTime / duration >= m / 100 && !reached.current.has(m)) {
            reached.current.add(m)
            track(`landing_demo_progress_${m}`)
          }
        }
      }}
    />
  )
}
