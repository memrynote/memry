import { useState } from 'react'
import { Container } from '@/components/layout/Container'
import { PageHead } from '@/components/shared/PageHead'
import { CheckoutPanel, NoTokenNotice } from '@/components/account/CheckoutPanel'
import { parseCheckoutToken } from '@/lib/checkout-summary'

const NO_TOKEN_NOTICE = <NoTokenNotice />

export function CheckoutPage() {
  const [token] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : parseCheckoutToken(window.location.hash)
  )

  return (
    <>
      <PageHead page="pricing" />
      <main className="overflow-hidden py-16 md:py-24">
        <Container size="sm">
          <CheckoutPanel token={token} onTokenMissing={NO_TOKEN_NOTICE} />
        </Container>
      </main>
    </>
  )
}
