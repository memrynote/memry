import { initializePaddle, type Paddle, type PaddleEventData } from '@paddle/paddle-js'

import type { CheckoutPlanId, SyncPlanId } from './constants'

export type PaddleCheckoutCadence = 'monthly' | 'annual' | 'lifetime'
export type PaddleCheckoutEventHandler = (event: PaddleEventData) => void

export interface CheckoutHashIntent {
  plan: CheckoutPlanId
  cadence: PaddleCheckoutCadence
  checkoutToken: string
}

type CheckoutResponse = {
  transactionId: string
  checkoutUrl: string | null
}

let paddlePromise: Promise<Paddle | undefined> | null = null
let activeCheckoutEventHandler: PaddleCheckoutEventHandler | null = null

function getPaddleClient() {
  const token = import.meta.env.VITE_PADDLE_CLIENT_TOKEN
  if (!token) return null

  paddlePromise ??= initializePaddle({
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

  return paddlePromise
}

export function parseCheckoutHash(hash: string): CheckoutHashIntent | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const plan = params.get('checkout_plan')
  const cadence = params.get('checkout_cadence')
  const checkoutToken = params.get('checkout_token')?.trim()

  if (!isCheckoutPlan(plan) || !isCheckoutCadence(cadence) || !checkoutToken) return null
  return { plan, cadence, checkoutToken }
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
    throw new Error('Open Memry and sign in from Account to start hosted sync.')
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

function isCheckoutPlan(value: string | null): value is CheckoutPlanId {
  return value === 'plus' || value === 'pro' || value === 'believer'
}

function isCheckoutCadence(value: string | null): value is PaddleCheckoutCadence {
  return value === 'monthly' || value === 'annual' || value === 'lifetime'
}
