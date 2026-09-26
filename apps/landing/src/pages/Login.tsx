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

/* Painted meadow + app window: the right half of the split. Both live in /public for the
   same reason as the homepage hero (a bundled src/assets import 404s after prerender).
   login-bg.webp was generated with: cwebp -q 78 -resize 1200 0 src/assets/hero-bg1.png */
const SHOWCASE_BG = '/login/login-bg.webp'
const SHOWCASE_SHOT = { src: '/screenshots/home_white.webp', width: 1432, height: 1022 } as const

/* Decorative: the window is anchored to the top-start corner and deliberately overflows
   the end and bottom edges, so it reads as the app sitting inside the landscape. */
function LoginShowcase() {
  return (
    <div
      aria-hidden
      className="relative hidden overflow-hidden rounded-[1.25rem] bg-tint-sky lg:block"
    >
      <img
        src={SHOWCASE_BG}
        alt=""
        className="absolute inset-0 h-full w-full object-cover"
        decoding="async"
      />
      <div className="absolute inset-0 bg-[linear-gradient(to_bottom,rgb(122_168_214/0.18),transparent_45%)]" />
      <div className="absolute start-[9%] top-[13%] w-[max(140%,52rem)] animate-fade-up">
        <img
          src={SHOWCASE_SHOT.src}
          width={SHOWCASE_SHOT.width}
          height={SHOWCASE_SHOT.height}
          alt=""
          decoding="async"
          className="block h-auto w-full rounded-xl bg-paper shadow-[0_24px_60px_-12px_rgb(26_26_26/0.35)] ring-1 ring-ink/10"
        />
      </div>
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
      <div className="flex min-h-dvh bg-paper-deep p-3 sm:p-5">
        <div className="grid flex-1 gap-3 rounded-[1.75rem] border border-border bg-paper p-3 shadow-card lg:grid-cols-2">
          <div className="flex flex-col px-5 py-6 sm:px-8">
            <Link to="/" className="group flex w-fit items-center gap-2">
              <img src="/favicon.svg" alt="" className="h-7 w-7" />
              <span className="font-geist text-[17px] font-medium leading-none tracking-[-0.04em] text-ink transition-colors group-hover:text-terracotta">
                memrynote
              </span>
            </Link>

            <div className="flex flex-1 items-center justify-center py-12">
              <div className="w-full max-w-sm animate-fade-up">
                <h1 className="text-center font-editorial text-2xl font-medium tracking-[-0.02em]">
                  {toCheckout ? 'Sign in to continue' : 'Sign in to memrynote'}
                </h1>
                <p className="mt-2 text-center text-sm text-muted text-balance">
                  {toCheckout ? (
                    'Log in first to choose your plan and check out.'
                  ) : step === 'email' ? (
                    'Welcome back. Pick up where you left off.'
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

                <Button
                  variant="outline"
                  className="mt-8 inline-flex w-full items-center justify-center gap-2"
                  onClick={() => continueWithGoogle(next)}
                >
                  <GoogleIcon />
                  Continue with Google
                </Button>

                <div className="my-6 flex items-center gap-3 text-xs text-muted">
                  <span className="h-px flex-1 bg-border" />
                  or
                  <span className="h-px flex-1 bg-border" />
                </div>

                {/* Step swap slides forward: outgoing form exits left, incoming enters from
                    the right. mode="wait" keeps them from overlapping; initial={false} skips
                    the entrance on first mount, since the column already animates in via
                    `.animate-fade-up`. */}
                <AnimatePresence mode="wait" initial={false}>
                  {step === 'email' ? (
                    <motion.form
                      key="email"
                      className="space-y-3"
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
                        placeholder="Enter your email address"
                        aria-label="Email address"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                      />
                      <Button type="submit" className="w-full" disabled={busy || !email}>
                        {busy ? 'Sending…' : 'Continue with email'}
                      </Button>
                    </motion.form>
                  ) : (
                    <motion.form
                      key="code"
                      className="space-y-3"
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
              </div>
            </div>

            <p className="text-center text-xs leading-relaxed text-muted text-balance">
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

          <LoginShowcase />
        </div>
      </div>
    </>
  )
}
