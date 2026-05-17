import { useEffect } from 'react'
import type Lenis from 'lenis'
import {
  LANDING_ANCHOR_SCROLL_OPTIONS,
  prefersReducedLandingMotion,
  setLandingLenis
} from '@/lib/smooth-scroll'

export function SmoothScroll() {
  useEffect(() => {
    if (prefersReducedLandingMotion()) return

    let cancelled = false
    let lenis: Lenis | null = null

    void import('lenis').then(({ default: Lenis }) => {
      if (cancelled) return

      lenis = new Lenis({
        autoRaf: true,
        autoToggle: true,
        allowNestedScroll: true,
        stopInertiaOnNavigate: true,
        smoothWheel: true,
        lerp: 0.09,
        anchors: LANDING_ANCHOR_SCROLL_OPTIONS
      })
      setLandingLenis(lenis)
    })

    return () => {
      cancelled = true
      setLandingLenis(null)
      lenis?.destroy()
    }
  }, [])

  return null
}
