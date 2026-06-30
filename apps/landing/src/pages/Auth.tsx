import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageHead } from '@/components/shared/PageHead'
import { Container } from '@/components/layout/Container'
import { useAuth } from '@/contexts/auth-context'
import { registerWebDevice } from '@/lib/account/auth-client'
import { SYNC_SERVER_URL, WEB_OAUTH_REDIRECT_PATH } from '@/lib/account/config'
import { trackLandingEvent } from '@/lib/analytics'

function continueWithGoogle() {
  const redirectUri = `${window.location.origin}${WEB_OAUTH_REDIRECT_PATH}`
  window.location.href = `${SYNC_SERVER_URL}/auth/oauth/google?redirect_uri=${encodeURIComponent(redirectUri)}`
}

export function AuthPage() {
  const { api, storage, refreshSignedIn } = useAuth()
  const navigate = useNavigate()
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
      navigate('/account/profile')
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
            <h1 className="font-editorial text-xl tracking-[-0.01em]">Sign in to Memry</h1>
            {error ? <p className="mt-3 text-sm text-red-500">{error}</p> : null}
            {step === 'email' ? (
              <div className="mt-6 space-y-3">
                <Input
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
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
            <Button variant="outline" className="w-full" onClick={continueWithGoogle}>
              Continue with Google
            </Button>
          </div>
        </Container>
      </main>
    </>
  )
}
