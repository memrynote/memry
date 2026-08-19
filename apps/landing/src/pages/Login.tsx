import { useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router'
import { Helmet } from 'react-helmet-async'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/contexts/auth-context'
import { registerWebDevice } from '@/lib/account/auth-client'
import { authErrorMessage } from '@/lib/account/auth-error'
import { SYNC_SERVER_URL, WEB_OAUTH_REDIRECT_PATH } from '@/lib/account/config'
import { OAUTH_NEXT_STORAGE_KEY, safeNextPath } from '@/lib/account/next-path'
import { trackLandingEvent } from '@/lib/analytics'

const EASE = [0.16, 1, 0.3, 1] as const

function continueWithGoogle(next: string | null) {
  sessionStorage.setItem(OAUTH_NEXT_STORAGE_KEY, next ?? '')
  const redirectUri = `${window.location.origin}${WEB_OAUTH_REDIRECT_PATH}`
  window.location.href = `${SYNC_SERVER_URL}/auth/oauth/google?redirect_uri=${encodeURIComponent(redirectUri)}`
}

function GoogleIcon() {
  return (
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
  )
}

/* Layered background: paper gradient wash + terracotta aura + sage whisper + oversized
   brand glyph watermark. The global body grain adds the paper texture on top. */
function LoginBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(180deg,var(--color-paper)_0%,var(--color-paper-alt)_55%,var(--color-paper-deep)_100%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(60%_45%_at_50%_0%,rgb(255_103_26/0.14),transparent_70%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(45%_35%_at_8%_100%,rgb(91_127_106/0.12),transparent_70%)]" />
      <svg
        viewBox="0 0 1280 1032"
        className="absolute -bottom-24 -end-24 w-[26rem] rotate-[-8deg] text-terracotta opacity-[0.04] sm:-bottom-28 sm:-end-28 sm:w-[40rem]"
        fill="currentColor"
      >
        <path d="M637.44 648L1.28 304.64C5.20707 223.285 40.0147 146.493 98.5973 89.9066C157.18 33.3199 235.144 1.2039 316.571 0.103899C398.013 -1.00026 476.811 28.9946 536.904 83.9732C596.997 138.952 633.863 214.776 639.992 296C646.154 215.041 682.856 139.453 742.669 84.5466C802.481 29.6399 880.936 -0.480104 962.123 0.295896C1043.31 1.06672 1121.18 32.6759 1179.92 88.7119C1238.68 144.748 1273.94 221.024 1278.56 302.085L637.44 648ZM0 650.239V1031.04H1280V650.239H0Z" />
      </svg>
    </div>
  )
}

export function LoginPage() {
  const { api, storage, ready, isSignedIn, refreshSignedIn } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const next = params.get('next')
  const toCheckout = safeNextPath(next).startsWith('/checkout')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reduce = useReducedMotion()

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
      setError(authErrorMessage(e, 'Invalid code'))
    } finally {
      setBusy(false)
    }
  }

  if (ready && isSignedIn) return <Navigate to={safeNextPath(next)} replace />

  return (
    <>
      <Helmet>
        <title>Sign in — memrynote</title>
        <meta name="robots" content="noindex" />
      </Helmet>
      <div className="relative isolate flex min-h-dvh flex-col items-center justify-center px-4 py-16">
        <LoginBackdrop />
        <div className="w-full max-w-sm animate-fade-up">
          <div className="relative rounded-3xl border border-border bg-card/80 px-8 pb-8 pt-14 shadow-elevated backdrop-blur-xl sm:px-10">
            {/* Floating logo chip, half over the card's top edge — doubles as the way home */}
            <div className="absolute inset-x-0 -top-7 flex justify-center">
              <Link
                to="/"
                aria-label="memrynote home"
                className="flex h-14 w-14 rotate-[-4deg] items-center justify-center rounded-2xl border border-border bg-card shadow-elevated transition-transform duration-300 hover:rotate-0 motion-reduce:rotate-0"
              >
                <img src="/favicon.svg" alt="" className="h-7 w-7" />
              </Link>
            </div>

            <h1 className="text-center font-editorial text-2xl font-medium tracking-[-0.02em]">
              {toCheckout ? 'Sign in to continue' : 'Welcome to memrynote'}
            </h1>
            <p className="mt-2 text-center text-sm text-muted text-balance">
              {toCheckout ? (
                'Log in first to choose your plan and check out.'
              ) : step === 'email' ? (
                'Sign in with your email to continue.'
              ) : (
                <>
                  {/* data-ph-mask: keeps the entered email out of session replay */}
                  We emailed a 6-digit code to <span data-ph-mask>{email}</span>.
                </>
              )}
            </p>

            <AnimatePresence>
              {error ? (
                <motion.p
                  key="login-error"
                  className="mt-4 text-center text-sm text-red-500"
                  initial={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
                  transition={{ duration: 0.18, ease: EASE }}
                >
                  {error}
                </motion.p>
              ) : null}
            </AnimatePresence>

            {/* Step swap slides forward: outgoing form exits left, incoming enters from the
                right. mode="wait" keeps them from overlapping; initial={false} skips the entrance
                on first mount, since the card already animates in via `.animate-fade-up`. */}
            <AnimatePresence mode="wait" initial={false}>
              {step === 'email' ? (
                <motion.form
                  key="email"
                  className="mt-8 space-y-3"
                  initial={reduce ? { opacity: 0 } : { opacity: 0, x: 8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, x: -8 }}
                  transition={{ duration: 0.2, ease: EASE }}
                  onSubmit={(e) => {
                    e.preventDefault()
                    void requestCode()
                  }}
                >
                  <Input
                    type="email"
                    autoComplete="email"
                    placeholder="Your email"
                    aria-label="Email address"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                  <Button type="submit" className="w-full" disabled={busy || !email}>
                    {busy ? 'Sending…' : 'Continue'}
                  </Button>
                </motion.form>
              ) : (
                <motion.form
                  key="code"
                  className="mt-8 space-y-3"
                  initial={reduce ? { opacity: 0 } : { opacity: 0, x: 8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, x: -8 }}
                  transition={{ duration: 0.2, ease: EASE }}
                  onSubmit={(e) => {
                    e.preventDefault()
                    void verifyCode()
                  }}
                >
                  <Input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder="123456"
                    aria-label="6-digit code"
                    className="text-center font-mono-accent tracking-[0.4em]"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                  <Button type="submit" className="w-full" disabled={busy || code.length !== 6}>
                    {busy ? 'Verifying…' : 'Verify & sign in'}
                  </Button>
                  <button
                    type="button"
                    className="mx-auto block text-xs text-muted underline underline-offset-2 transition-colors hover:text-ink"
                    onClick={() => {
                      setStep('email')
                      setCode('')
                      setError(null)
                    }}
                  >
                    Use a different email
                  </button>
                </motion.form>
              )}
            </AnimatePresence>

            <div className="my-6 flex items-center gap-3 text-xs text-muted">
              <span className="h-px flex-1 bg-border" />
              or
              <span className="h-px flex-1 bg-border" />
            </div>

            <Button
              variant="outline"
              className="inline-flex w-full items-center justify-center gap-2"
              onClick={() => continueWithGoogle(next)}
            >
              <GoogleIcon />
              Continue with Google
            </Button>

            <p className="mt-8 text-center text-xs leading-relaxed text-muted text-balance">
              By continuing, you agree to our{' '}
              <Link to="/terms" className="underline underline-offset-2 hover:text-ink">
                Terms
              </Link>{' '}
              and{' '}
              <Link to="/privacy" className="underline underline-offset-2 hover:text-ink">
                Privacy Policy
              </Link>
              .
            </p>
          </div>
        </div>
      </div>
    </>
  )
}
