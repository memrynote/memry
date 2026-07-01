import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageHead } from '@/components/shared/PageHead'
import { Container } from '@/components/layout/Container'
import { useAuth } from '@/contexts/auth-context'
import { registerWebDevice } from '@/lib/account/auth-client'
import { SYNC_SERVER_URL, WEB_OAUTH_REDIRECT_PATH } from '@/lib/account/config'
import { OAUTH_NEXT_STORAGE_KEY, safeNextPath } from '@/lib/account/next-path'
import { trackLandingEvent } from '@/lib/analytics'

function continueWithGoogle(next: string | null) {
  sessionStorage.setItem(OAUTH_NEXT_STORAGE_KEY, next ?? '')
  const redirectUri = `${window.location.origin}${WEB_OAUTH_REDIRECT_PATH}`
  window.location.href = `${SYNC_SERVER_URL}/auth/oauth/google?redirect_uri=${encodeURIComponent(redirectUri)}`
}

export function AuthPage() {
  const { api, storage, refreshSignedIn } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const next = params.get('next')
  const toCheckout = safeNextPath(next).startsWith('/checkout')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function requestCode() {
    setBusy(true)
    setError(null)
    try {
      await api.publicJson('/auth/otp/request', {
        method: 'POST',
        body: JSON.stringify({ email })
      })
      setStep('code')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send code')
    } finally {
      setBusy(false)
    }
  }

  async function verifyCode() {
    setBusy(true)
    setError(null)
    try {
      const res = await api.publicJson<{ setupToken: string }>('/auth/otp/verify', {
        method: 'POST',
        body: JSON.stringify({ email, code })
      })
      await registerWebDevice({ setupToken: res.setupToken, baseUrl: SYNC_SERVER_URL, storage })
      refreshSignedIn()
      trackLandingEvent('landing_account_signin', 'auth:otp')
      navigate(safeNextPath(next))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid code')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHead page="pricing" />
      <main className="py-24">
        <Container size="sm">
          <div className="mx-auto max-w-sm rounded-2xl border border-border bg-card p-8 shadow-card">
            <h1 className="font-editorial text-xl tracking-[-0.01em]">
              {toCheckout ? 'Sign in to continue' : 'Sign in to Memrynote'}
            </h1>
            {toCheckout ? (
              <p className="mt-2 text-sm text-muted">
                Log in first to choose your plan and check out.
              </p>
            ) : null}
            {error ? <p className="mt-3 text-sm text-red-500">{error}</p> : null}
            {step === 'email' ? (
              <div className="mt-6 space-y-3">
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                <Button className="w-full" disabled={busy || !email} onClick={requestCode}>
                  {busy ? 'Sending…' : 'Email me a code'}
                </Button>
              </div>
            ) : (
              <div className="mt-6 space-y-3">
                <Input
                  inputMode="numeric"
                  placeholder="123456"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
                <Button
                  className="w-full"
                  disabled={busy || code.length !== 6}
                  onClick={verifyCode}
                >
                  {busy ? 'Verifying…' : 'Verify & sign in'}
                </Button>
              </div>
            )}
            <div className="my-5 text-center text-xs text-muted">or</div>
            <Button
              variant="outline"
              className="inline-flex w-full items-center justify-center gap-2"
              onClick={() => continueWithGoogle(next)}
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                  fill="#4285F4"
                />
                <path
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  fill="#34A853"
                />
                <path
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                  fill="#FBBC05"
                />
                <path
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  fill="#EA4335"
                />
              </svg>
              Continue with Google
            </Button>
          </div>
        </Container>
      </main>
    </>
  )
}
