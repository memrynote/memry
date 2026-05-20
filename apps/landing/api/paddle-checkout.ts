import { Environment, Paddle } from '@paddle/paddle-node-sdk'
import { PostHog } from 'posthog-node'
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

function getRequestBody(req: VercelRequest): unknown {
  if (typeof req.body !== 'string') return req.body

  try {
    return JSON.parse(req.body)
  } catch {
    return null
  }
}

function getPostHogClient(): PostHog | null {
  const key = process.env.POSTHOG_API_KEY
  const host = process.env.POSTHOG_HOST
  if (!key || !host) return null
  return new PostHog(key, { host })
}

async function captureCheckoutInitiated(transactionId: string, plan: string, cadence: string) {
  const posthog = getPostHogClient()
  if (!posthog) return

  try {
    posthog.capture({
      distinctId: transactionId,
      event: 'checkout_initiated',
      properties: { plan, cadence, transactionId }
    })
    await posthog.shutdown()
  } catch {
    console.error('[paddle-checkout] PostHog capture failed')
  }
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

    await captureCheckoutInitiated(transaction.id, intent.plan, intent.cadence)

    return res.status(200).json({
      environment: paddleEnvironment,
      transactionId: transaction.id,
      checkoutUrl: transaction.checkout?.url ?? null,
      plan: intent.plan,
      cadence: intent.cadence
    })
  } catch {
    console.error('[paddle-checkout] transaction creation failed')
    return res.status(502).json({ error: 'Could not start checkout' })
  }
}
