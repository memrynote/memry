import type { ReactNode } from 'react'
import { Navigate } from 'react-router'
import { useAuth } from '@/contexts/auth-context'

export function RequireAuth({ children }: { children: ReactNode }) {
  const { ready, isSignedIn } = useAuth()
  if (!ready) return null // avoid SSR/first-paint flash
  if (!isSignedIn) return <Navigate to="/login" replace />
  return <>{children}</>
}
