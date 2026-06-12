import { useEffect, useState } from 'react'
import { CheckoutPanel } from '@/components/account/CheckoutPanel'
import { useAuth } from '@/contexts/auth-context'

export function SyncSection() {
  const { api } = useAuth()
  const [token, setToken] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    api
      .authedJson<{ checkoutToken: string }>('/auth/checkout-token', { method: 'POST' })
      .then((r) => setToken(r.checkoutToken))
      .catch(() => setError(true))
  }, [api])

  return (
    <div className="space-y-6">
      <h1 className="font-editorial text-2xl tracking-[-0.01em]">Sync</h1>
      {error ? (
        <p className="text-sm text-red-500">Could not start checkout. Reload to try again.</p>
      ) : token ? (
        <CheckoutPanel token={token} />
      ) : (
        <p className="text-sm text-muted">Loading…</p>
      )}
    </div>
  )
}
