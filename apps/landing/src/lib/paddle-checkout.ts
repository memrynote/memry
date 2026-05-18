import { initializePaddle, type Paddle } from '@paddle/paddle-js'

import type { SyncPlanId } from './constants'

export type PaddleCheckoutCadence = 'monthly' | 'annual' | 'lifetime'

type CheckoutResponse = {
  transactionId: string
  checkoutUrl: string | null
}

let paddlePromise: Promise<Paddle | undefined> | null = null

function getPaddleClient() {
  const token = import.meta.env.VITE_PADDLE_CLIENT_TOKEN
  if (!token) return null

  paddlePromise ??= initializePaddle({
    token,
    environment:
      import.meta.env.VITE_PADDLE_ENVIRONMENT === 'production' ? 'production' : 'sandbox',
    checkout: {
      settings: {
        displayMode: 'overlay',
        variant: 'one-page',
        theme: 'light',
        locale: 'en'
      }
    }
  })

  return paddlePromise
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
  userId?: string
) {
  const normalizedUserId = userId?.trim()
  if (!normalizedUserId) {
    throw new Error('Open Memry and sign in from Account to start hosted sync.')
  }

  const response = await fetch('/api/paddle-checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan, cadence, userId: normalizedUserId })
  })
  const checkout = await readCheckoutResponse(response)
  const paddle = await getPaddleClient()

  if (paddle) {
    paddle.Checkout.open({
      transactionId: checkout.transactionId,
      settings: {
        successUrl: `${window.location.origin}/pricing?checkout=success`
      }
    })
    return
  }

  if (checkout.checkoutUrl) {
    window.location.assign(checkout.checkoutUrl)
    return
  }

  throw new Error('Paddle client token is missing')
}
