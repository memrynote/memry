import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router'
import { useAuth } from '@/contexts/auth-context'
import { parseCheckoutToken } from '@/lib/checkout-summary'

export function RequireAuth({ children }: { children: ReactNode }) {
  const { ready, isSignedIn } = useAuth()
  const location = useLocation()
  // Desktop hands free users a checkout token at /account/sync#token=... so
  // they can pick a plan without a separate web login; only that route is
  // reachable this way — the other account tabs still require a session.
  const hasCheckoutHandoff =
    location.pathname === '/account/sync' && parseCheckoutToken(location.hash) != null
  if (!ready) return null // avoid SSR/first-paint flash
  if (!isSignedIn && !hasCheckoutHandoff) return <Navigate to="/login" replace />
  return <>{children}</>
}
