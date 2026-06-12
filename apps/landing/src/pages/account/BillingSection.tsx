import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/auth-context'

interface BillingStatus {
  plan: string
  status: string
  canManageBilling: boolean
}

interface InvoiceRow {
  id: string
  status: string
  billedAt: string | null
  amount: string
  currency: string
}

export function BillingSection() {
  const { api } = useAuth()
  const [billing, setBilling] = useState<BillingStatus | null>(null)
  const [invoices, setInvoices] = useState<InvoiceRow[]>([])
  const [billingError, setBillingError] = useState<string | null>(null)
  const [portalError, setPortalError] = useState<string | null>(null)
  const [invoicesError, setInvoicesError] = useState<string | null>(null)

  useEffect(() => {
    api
      .authedJson<BillingStatus>('/auth/billing')
      .then(setBilling)
      .catch(() => setBillingError('Could not load billing info.'))
    api
      .authedJson<{ invoices: InvoiceRow[] }>('/auth/billing/invoices')
      .then((r) => setInvoices(r.invoices))
      .catch(() => setInvoicesError('Could not load invoices. Try again later.'))
  }, [api])

  async function openPortal() {
    setPortalError(null)
    try {
      const { portalUrl } = await api.authedJson<{ portalUrl: string }>(
        '/auth/billing/portal-session',
        { method: 'POST' }
      )
      window.open(portalUrl, '_blank', 'noopener')
    } catch {
      setPortalError('Could not open billing portal. Try again.')
    }
  }

  async function openInvoice(id: string) {
    setInvoicesError(null)
    try {
      const { url } = await api.authedJson<{ url: string }>(`/auth/billing/invoices/${id}/pdf`)
      window.open(url, '_blank', 'noopener')
    } catch {
      setInvoicesError('Could not open invoice PDF. Try again.')
    }
  }

  return (
    <div className="space-y-8">
      <h1 className="font-editorial text-2xl tracking-[-0.01em]">Billing</h1>

      <section className="rounded-2xl border border-border bg-card p-6">
        <h2 className="text-sm font-semibold">Subscription</h2>
        {billingError ? (
          <p className="mt-1 text-sm text-red-500">{billingError}</p>
        ) : billing ? (
          <p className="mt-1 text-sm text-muted capitalize">
            {billing.plan} · {billing.status}
          </p>
        ) : (
          <p className="mt-1 text-sm text-muted">Loading…</p>
        )}
        {portalError ? <p className="mt-2 text-sm text-red-500">{portalError}</p> : null}
        <Button variant="outline" className="mt-4" onClick={openPortal}>
          Manage payment method
        </Button>
      </section>

      <section className="rounded-2xl border border-border bg-card p-6">
        <h2 className="text-sm font-semibold">Invoices</h2>
        {invoicesError ? (
          <p className="mt-2 text-sm text-red-500">{invoicesError}</p>
        ) : invoices.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No invoices yet.</p>
        ) : (
          <ul className="mt-4 divide-y divide-border">
            {invoices.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between gap-4 py-3 text-sm">
                <span className="shrink-0">{inv.billedAt?.slice(0, 10) ?? '—'}</span>
                <span className="shrink-0">
                  {(Number(inv.amount) / 100).toFixed(2)} {inv.currency}
                </span>
                <span className="text-muted capitalize shrink-0">{inv.status}</span>
                <button
                  type="button"
                  className="text-terracotta hover:underline shrink-0"
                  onClick={() => openInvoice(inv.id)}
                >
                  PDF
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
