import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Navigate, useSearchParams } from 'react-router'
import { Container } from '@/components/layout/Container'
import { PageHead } from '@/components/shared/PageHead'
import { Button } from '@/components/ui/button'
import { CheckoutPanel, NoTokenNotice } from '@/components/account/CheckoutPanel'
import { parseCheckoutToken } from '@/lib/checkout-summary'
import { useAuth } from '@/contexts/use-auth'
import type { CheckoutPlanId } from '@/lib/constants'
import {
  parseCheckoutCadence,
  parseCheckoutPlan,
  type PaddleCheckoutCadence
} from '@/lib/paddle-checkout'

const NO_TOKEN_NOTICE = <NoTokenNotice />

export function CheckoutPage() {
  const { ready, isSignedIn, api } = useAuth()
  const [params] = useSearchParams()
  const initialPlan = parseCheckoutPlan(params.get('plan'))
  const initialCadence = parseCheckoutCadence(params.get('cadence'))

  // Desktop opens /checkout#token=<checkoutToken>. Web pricing has no hash token
  // and mints one from the signed-in session instead.
  const [hashToken] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : parseCheckoutToken(window.location.hash)
  )
  const [webToken, setWebToken] = useState<string | null>(null)
  const [minting, setMinting] = useState(false)
  const [mintError, setMintError] = useState<string | null>(null)

  const mintToken = useCallback(async () => {
    setMinting(true)
    setMintError(null)
    try {
      const res = await api.authedJson<{ checkoutToken: string }>('/auth/checkout-token', {
        method: 'POST'
      })
      setWebToken(res.checkoutToken)
    } catch {
      setMintError('Could not start checkout. Please try again.')
    } finally {
      setMinting(false)
    }
  }, [api])

  useEffect(() => {
    // oxlint-disable-next-line react-you-might-not-need-an-effect/no-event-handler -- mints a checkout token once the session is ready; there is no user event to hang it on
    if (hashToken || !ready || !isSignedIn || webToken || minting || mintError) return
    // oxlint-disable-next-line react/set-state-in-effect -- mints a checkout token from the session on mount; the effect synchronizes with the API
    void mintToken()
  }, [hashToken, ready, isSignedIn, webToken, minting, mintError, mintToken])

  return (
    <>
      <PageHead page="pricing" />
      <main className="overflow-hidden py-16 md:py-24">
        <Container size="sm">
          <CheckoutContent
            hashToken={hashToken}
            ready={ready}
            isSignedIn={isSignedIn}
            search={params.toString()}
            webToken={webToken}
            mintError={mintError}
            onRetry={mintToken}
            initialPlan={initialPlan}
            initialCadence={initialCadence}
          />
        </Container>
      </main>
    </>
  )
}

function CheckoutContent({
  hashToken,
  ready,
  isSignedIn,
  search,
  webToken,
  mintError,
  onRetry,
  initialPlan,
  initialCadence
}: {
  hashToken: string | null
  ready: boolean
  isSignedIn: boolean
  search: string
  webToken: string | null
  mintError: string | null
  onRetry: () => void
  initialPlan?: CheckoutPlanId
  initialCadence?: PaddleCheckoutCadence
}) {
  // Desktop-minted token path (unchanged).
  if (hashToken) {
    return (
      <CheckoutPanel
        token={hashToken}
        onTokenMissing={NO_TOKEN_NOTICE}
        initialPlan={initialPlan}
        initialCadence={initialCadence}
      />
    )
  }

  if (!ready) return null // avoid SSR/first-paint flash

  if (!isSignedIn) {
    const next = search ? `/checkout?${search}` : '/checkout'
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />
  }

  if (mintError) {
    return (
      <CheckoutNotice>
        <p className="text-sm text-terracotta">{mintError}</p>
        <Button className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      </CheckoutNotice>
    )
  }

  if (!webToken) {
    return (
      <CheckoutNotice>
        <p className="text-sm text-muted">Preparing checkout…</p>
      </CheckoutNotice>
    )
  }

  return (
    <CheckoutPanel token={webToken} initialPlan={initialPlan} initialCadence={initialCadence} />
  )
}

function CheckoutNotice({ children }: { children: ReactNode }) {
  return (
    <div className="animate-fade-up mx-auto max-w-sm rounded-2xl border border-border bg-card p-8 text-center shadow-card">
      {children}
    </div>
  )
}
