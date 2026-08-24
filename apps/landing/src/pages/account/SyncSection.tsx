import { useEffect, useState } from 'react'
import { CheckoutPanel } from '@/components/account/CheckoutPanel'
import { parseCheckoutToken } from '@/lib/checkout-summary'
import { useAuth } from '@/contexts/auth-context'

export function SyncSection() {
  const { api } = useAuth()
  // Desktop opens /account/sync#token=<checkoutToken>; that token already
  // scopes the purchase to the account, so no web session (or mint) is needed.
  const [hashToken] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : parseCheckoutToken(window.location.hash)
  )
  const [mintedToken, setMintedToken] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (hashToken) return
    api
      .authedJson<{ checkoutToken: string }>('/auth/checkout-token', { method: 'POST' })
      .then((r) => setMintedToken(r.checkoutToken))
      .catch(() => setError(true))
  }, [api, hashToken])

  const token = hashToken ?? mintedToken

  return (
    <div className="space-y-6">
      <h1 className="font-editorial text-2xl tracking-[-0.01em]">Sync</h1>
      {token ? (
        <CheckoutPanel token={token} />
      ) : error ? (
        <p className="text-sm text-red-500">Could not start checkout. Reload to try again.</p>
      ) : (
        <p className="text-sm text-muted">Loading…</p>
      )}
    </div>
  )
}
