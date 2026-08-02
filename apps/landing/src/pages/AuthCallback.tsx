import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { Container } from '@/components/layout/Container'
import { useAuth } from '@/contexts/auth-context'
import { registerWebDevice } from '@/lib/account/auth-client'
import { SYNC_SERVER_URL } from '@/lib/account/config'
import { OAUTH_NEXT_STORAGE_KEY, safeNextPath } from '@/lib/account/next-path'
import { trackLandingEvent } from '@/lib/analytics'

export function AuthCallbackPage() {
  const { api, storage, refreshSignedIn } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [callbackError, setCallbackError] = useState<string | null>(null)
  const ran = useRef(false)

  const code = params.get('code')
  const state = params.get('state')
  const missingParams = !code || !state

  useEffect(() => {
    if (missingParams || ran.current) return
    ran.current = true
    ;(async () => {
      try {
        const res = await api.publicJson<{ setupToken: string }>('/auth/oauth/google/callback', {
          method: 'POST',
          body: JSON.stringify({ code, state })
        })
        await registerWebDevice({ setupToken: res.setupToken, baseUrl: SYNC_SERVER_URL, storage })
        refreshSignedIn()
        trackLandingEvent('landing_account_signin', 'auth:google')
        const stored = sessionStorage.getItem(OAUTH_NEXT_STORAGE_KEY)
        sessionStorage.removeItem(OAUTH_NEXT_STORAGE_KEY)
        navigate(safeNextPath(stored), { replace: true })
      } catch (e) {
        setCallbackError(e instanceof Error ? e.message : 'Sign-in failed')
      }
    })()
  }, [missingParams, code, state, api, storage, navigate, refreshSignedIn])

  const message = missingParams
    ? 'Missing OAuth parameters'
    : (callbackError ?? 'Finishing sign-in…')

  return (
    <main className="py-24">
      <Container size="sm">
        <p className="text-center text-sm text-muted">{message}</p>
      </Container>
    </main>
  )
}
