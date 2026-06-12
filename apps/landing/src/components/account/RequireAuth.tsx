import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '@/contexts/auth-context'

export function RequireAuth({ children }: { children: ReactNode }) {
  const { ready, isSignedIn } = useAuth()
  if (!ready) return null // avoid SSR/first-paint flash
  if (!isSignedIn) return <Navigate to="/auth" replace />
  return <>{children}</>
}
