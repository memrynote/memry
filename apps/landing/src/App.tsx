import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router'
import { useEffect } from 'react'
import { MotionConfig } from 'motion/react'
import { HelmetProvider } from 'react-helmet-async'
import { SmoothScroll } from '@/components/layout/SmoothScroll'
import { SiteShell } from '@/components/layout/SiteShell'
import {
  PAGE_ROUTES,
  NotFoundPage,
  AccountLayoutPage,
  ProfileSectionPage,
  BillingSectionPage,
  SyncSectionPage
} from '@/routes'
import { RequireAuth } from '@/components/account/RequireAuth'
import { scrollToLandingTarget } from '@/lib/smooth-scroll'
import { trackLandingEvent, trackLandingPageView, type LandingEventName } from '@/lib/analytics'
import { AuthProvider } from '@/contexts/auth-context'
import { Analytics } from '@vercel/analytics/react'
import { SpeedInsights } from '@vercel/speed-insights/react'

const SCROLL_DEPTH_EVENTS: readonly { depth: number; event: LandingEventName }[] = [
  { depth: 25, event: 'landing_scroll_25' },
  { depth: 50, event: 'landing_scroll_50' },
  { depth: 75, event: 'landing_scroll_75' },
  { depth: 100, event: 'landing_scroll_100' }
]

function ScrollToHash() {
  const { pathname, hash } = useLocation()

  useEffect(() => {
    if (hash) {
      const id = hash.replace('#', '')
      const scrollTo = () => {
        const el = document.getElementById(id)
        if (el) {
          scrollToLandingTarget(el)
          return true
        }
        return false
      }
      if (!scrollTo()) {
        requestAnimationFrame(() => scrollTo())
      }
      return
    }
    scrollToLandingTarget(0, { immediate: true, offset: 0 })
  }, [pathname, hash])

  return null
}

function ScrollDepthAnalytics() {
  const { pathname } = useLocation()
  useEffect(() => {
    const firedDepths = new Set<number>()
    let frame = 0

    const measure = () => {
      frame = 0
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight
      const depth = maxScroll <= 0 ? 100 : Math.min((window.scrollY / maxScroll) * 100, 100)

      for (const { depth: threshold, event } of SCROLL_DEPTH_EVENTS) {
        if (depth >= threshold && !firedDepths.has(threshold)) {
          firedDepths.add(threshold)
          trackLandingEvent(event, `scroll:${threshold}`)
        }
      }
    }

    const scheduleMeasure = () => {
      if (frame) return
      frame = window.requestAnimationFrame(measure)
    }

    measure()
    window.addEventListener('scroll', scheduleMeasure, { passive: true })
    window.addEventListener('resize', scheduleMeasure)

    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      window.removeEventListener('scroll', scheduleMeasure)
      window.removeEventListener('resize', scheduleMeasure)
    }
  }, [pathname])

  return null
}

function PageViewAnalytics() {
  const { pathname, search } = useLocation()

  useEffect(() => {
    trackLandingPageView(pathname, search)
  }, [pathname, search])

  return null
}

// /login redirects legacy /auth links, preserving ?next= etc.
function LegacyAuthRedirect() {
  const { search } = useLocation()
  return <Navigate to={`/login${search}`} replace />
}

function AppContent() {
  // /login is a standalone surface: full-screen card, no site chrome.
  const standalone = useLocation().pathname === '/login'
  return (
    <>
      {/* All four render null — they only install effects — so they contribute no
          markup for hydration to match. */}
      <SmoothScroll />
      <ScrollToHash />
      <PageViewAnalytics />
      <ScrollDepthAnalytics />
      <SiteShell standalone={standalone}>
        <Routes>
          {PAGE_ROUTES.map(({ path, Component }) => (
            <Route key={path} path={path} element={<Component />} />
          ))}
          <Route path="/alternatives" element={<Navigate to="/compare" replace />} />
          <Route path="/auth" element={<LegacyAuthRedirect />} />
          <Route
            path="/account"
            element={
              <RequireAuth>
                <AccountLayoutPage />
              </RequireAuth>
            }
          >
            <Route index element={<ProfileSectionPage />} />
            <Route path="profile" element={<ProfileSectionPage />} />
            <Route path="billing" element={<BillingSectionPage />} />
            <Route path="sync" element={<SyncSectionPage />} />
          </Route>
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </SiteShell>
    </>
  )
}

export default function App() {
  return (
    <HelmetProvider>
      <BrowserRouter>
        <AuthProvider>
          {/* reducedMotion="user": transform/layout animations degrade to crossfades
              for prefers-reduced-motion users, across every motion.* on the site. */}
          <MotionConfig reducedMotion="user">
            <AppContent />
          </MotionConfig>
          <Analytics />
          <SpeedInsights />
        </AuthProvider>
      </BrowserRouter>
    </HelmetProvider>
  )
}
