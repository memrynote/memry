import { useEffect, useState } from 'react'
import { Container } from '@/components/layout/Container'
import { PageHead } from '@/components/shared/PageHead'
import { CheckoutPanel, NoTokenNotice } from '@/components/account/CheckoutPanel'
import { parseCheckoutToken } from '@/lib/checkout-summary'

export function CheckoutPage() {
  const [token, setToken] = useState<string | null>(null)

  useEffect(() => {
    setToken(parseCheckoutToken(window.location.hash))
  }, [])

  return (
    <>
      <PageHead page="pricing" />
      <main className="overflow-hidden py-16 md:py-24">
        <Container size="sm">
          <CheckoutPanel token={token} onTokenMissing={<NoTokenNotice />} />
        </Container>
      </main>
    </>
  )
}
