import type { Paddle, PaddleEventData } from '@paddle/paddle-js'

import type { CheckoutPlanId, SyncPlanId } from './constants'

export type PaddleCheckoutCadence = 'monthly' | 'annual' | 'lifetime'
export type PaddleCheckoutEventHandler = (event: PaddleEventData) => void

type CheckoutResponse = {
  transactionId: string
  checkoutUrl: string | null
}

let paddlePromise: Promise<Paddle | undefined> | null = null
let activeCheckoutEventHandler: PaddleCheckoutEventHandler | null = null

function getPaddleClient() {
  const token = import.meta.env.VITE_PADDLE_CLIENT_TOKEN
  if (!token) return null

  // Loaded on demand. Only the pricing and checkout screens ever open a checkout,
  // but a static import put the whole @paddle/paddle-js chunk in the entry graph
  // for every visitor, including someone who only reads the homepage.
  paddlePromise ??= import('@paddle/paddle-js').then(({ initializePaddle }) =>
    initializePaddle({
      token,
      environment:
        import.meta.env.VITE_PADDLE_ENVIRONMENT === 'production' ? 'production' : 'sandbox',
      eventCallback: (event) => {
        activeCheckoutEventHandler?.(event)
      },
      checkout: {
        settings: {
          displayMode: 'overlay',
          variant: 'one-page',
          theme: 'light',
          locale: 'en'
        }
      }
    })
  )

  return paddlePromise
}

export function buildMemryBillingStartUrl(plan: CheckoutPlanId, cadence: PaddleCheckoutCadence) {
  const params = new URLSearchParams({ plan, cadence })
  return `memry://billing/start?${params.toString()}`
}

export function buildMemryBillingCompleteUrl(transactionId: string) {
  const params = new URLSearchParams({ transactionId })
  return `memry://billing/complete?${params.toString()}`
}

export function buildCheckoutSuccessUrl(origin: string, transactionId: string) {
  const params = new URLSearchParams({ checkout: 'success', transactionId })
  return `${origin}/pricing?${params.toString()}`
}

async function readJsonBody(response: Response) {
  const contentType = response.headers.get('Content-Type')?.toLowerCase() ?? ''
  if (!contentType.includes('application/json')) return {}

  try {
    return (await response.json()) as Partial<CheckoutResponse> & { error?: string }
  } catch {
    return {}
  }
}

export async function readCheckoutResponse(response: Response): Promise<CheckoutResponse> {
  const data = await readJsonBody(response)

  if (!response.ok) {
    throw new Error(data.error || 'Could not start checkout')
  }

  if (!data.transactionId) {
    throw new Error('Checkout did not return a transaction')
  }

  return {
    transactionId: data.transactionId,
    checkoutUrl: data.checkoutUrl ?? null
  }
}

export async function openPaddleCheckout(
  plan: SyncPlanId,
  cadence: PaddleCheckoutCadence,
  checkoutToken?: string,
  onEvent?: PaddleCheckoutEventHandler
) {
  const normalizedCheckoutToken = checkoutToken?.trim()
  if (!normalizedCheckoutToken) {
    throw new Error('Open Memrynote and sign in from Account to start hosted sync.')
  }

  const response = await fetch('/api/paddle-checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan, cadence, checkoutToken: normalizedCheckoutToken })
  })
  const checkout = await readCheckoutResponse(response)
  const paddle = await getPaddleClient()

  if (paddle) {
    activeCheckoutEventHandler = onEvent ?? null
    paddle.Checkout.open({
      transactionId: checkout.transactionId,
      settings: {
        successUrl: buildCheckoutSuccessUrl(window.location.origin, checkout.transactionId)
      }
    })
    return checkout
  }

  if (checkout.checkoutUrl) {
    window.location.assign(checkout.checkoutUrl)
    return checkout
  }

  throw new Error('Paddle client token is missing')
}
