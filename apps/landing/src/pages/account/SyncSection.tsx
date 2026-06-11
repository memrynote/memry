import { useEffect, useState } from 'react'
import { CheckoutPanel } from '@/components/account/CheckoutPanel'
import { useAuth } from '@/contexts/auth-context'

export function SyncSection() {
  const { api } = useAuth()
  const [token, setToken] = useState<string | null>(null)

  useEffect(() => {
    api
      .authedJson<{ checkoutToken: string }>('/auth/checkout-token', { method: 'POST' })
      .then((r) => setToken(r.checkoutToken))
      .catch(() => setToken(null))
  }, [api])

  return (
    <div className="space-y-6">
      <h1 className="font-editorial text-2xl tracking-[-0.01em]">Sync</h1>
      <CheckoutPanel token={token} />
    </div>
  )
}
