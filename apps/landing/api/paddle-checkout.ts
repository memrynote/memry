import { Environment, Paddle } from '@paddle/paddle-node-sdk'
import type { VercelRequest, VercelResponse } from '@vercel/node'

import {
  getPaddleCheckoutConfig,
  normalizePaddleApiKey,
  parsePaddleCheckoutIntent
} from './paddle-checkout-config.js'

function getPaddleEnvironment() {
  return process.env.PADDLE_ENVIRONMENT === 'production'
    ? Environment.production
    : Environment.sandbox
}

function getPaddleApiKey(environment: Environment) {
  if (environment === Environment.production) {
    return normalizePaddleApiKey(process.env.PADDLE_API_KEY)
  }

  return normalizePaddleApiKey(process.env.PADDLE_SANDBOX_API_KEY ?? process.env.PADDLE_API_KEY)
}

type CheckoutRequestBody = Record<string, unknown>

/** Vercel hands us either a parsed body or the raw string, depending on the content type. */
function getRequestBody(req: VercelRequest): CheckoutRequestBody | null {
  if (typeof req.body === 'string') {
    try {
      const parsed: unknown = JSON.parse(req.body)
      return parsed && typeof parsed === 'object' ? (parsed as CheckoutRequestBody) : null
    } catch {
      return null
    }
  }

  return req.body && typeof req.body === 'object' ? (req.body as CheckoutRequestBody) : null
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const paddleEnvironment = getPaddleEnvironment()
  const apiKey = getPaddleApiKey(paddleEnvironment)
  if (!apiKey) {
    console.error('[paddle-checkout] Paddle API key is not configured')
    return res.status(500).json({ error: 'Paddle is not configured' })
  }

  const intent = await parsePaddleCheckoutIntent(getRequestBody(req), process.env)
  if (!intent) {
    return res.status(400).json({ error: 'Invalid checkout request' })
  }

  // Hard stop on the double-billing path: a second checkout for an account that already has a
  // live subscription creates a parallel one in Paddle and charges the card twice. Plan changes
  // go through the sync-server change-plan endpoint, which prorates the existing subscription.
  if (intent.hasSubscription) {
    return res.status(409).json({
      error: 'This account already has an active subscription. Change your plan instead.',
      code: 'subscription_exists'
    })
  }

  let checkoutConfig
  try {
    checkoutConfig = getPaddleCheckoutConfig(intent, process.env)
  } catch {
    console.error('[paddle-checkout] checkout config unavailable')
    return res.status(500).json({ error: 'Paddle price is not configured' })
  }

  try {
    const paddle = new Paddle(apiKey, { environment: paddleEnvironment })
    const checkoutUrl = process.env.PADDLE_CHECKOUT_URL
    const transaction = await paddle.transactions.create({
      collectionMode: 'automatic',
      items: [{ priceId: checkoutConfig.priceId, quantity: 1 }],
      customData: checkoutConfig.customData,
      checkout: checkoutUrl ? { url: checkoutUrl } : undefined
    })

    return res.status(200).json({
      environment: paddleEnvironment,
      transactionId: transaction.id,
      checkoutUrl: transaction.checkout?.url ?? null,
      plan: intent.plan,
      cadence: intent.cadence
    })
  } catch (error) {
    console.error('[paddle-checkout] transaction creation failed', error)
    const detail =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : JSON.stringify(error)
    return res.status(502).json({ error: `Could not start checkout: ${detail}` })
  }
}
