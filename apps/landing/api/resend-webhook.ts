import { PostHog } from 'posthog-node'
import { Resend } from 'resend'
import type { VercelRequest, VercelResponse } from '@vercel/node'

import { toMarketingEmailEvent, type ResendWebhookPayload } from './resend-webhook-support.js'

function getPostHogClient(): PostHog | null {
  const key = process.env.POSTHOG_API_KEY
  const host = process.env.POSTHOG_HOST
  if (!key || !host) return null
  return new PostHog(key, { host })
}

function getHeaderValue(req: VercelRequest, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0]
  return typeof value === 'string' && value ? value : undefined
}

async function readRawBody(req: VercelRequest): Promise<string> {
  if (typeof req.body === 'string') return req.body
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body)

  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  return Buffer.concat(chunks).toString('utf8')
}

async function verifyResendWebhook(req: VercelRequest): Promise<ResendWebhookPayload> {
  const apiKey = process.env.RESEND_API_KEY
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET
  if (!apiKey) throw new Error('Missing RESEND_API_KEY')
  if (!webhookSecret) throw new Error('Missing RESEND_WEBHOOK_SECRET')

  const resend = new Resend(apiKey)
  const payload = await readRawBody(req)
  const id = getHeaderValue(req, 'svix-id')
  const timestamp = getHeaderValue(req, 'svix-timestamp')
  const signature = getHeaderValue(req, 'svix-signature')
  if (!id || !timestamp || !signature) throw new Error('Missing Resend webhook signature')

  const verifiedPayload = await resend.webhooks.verify({
    payload,
    headers: {
      id,
      timestamp,
      signature
    },
    webhookSecret
  })

  return verifiedPayload as unknown as ResendWebhookPayload
}

function parseEventTimestamp(value: string | undefined): Date | undefined {
  if (!value) return undefined
  const timestamp = new Date(value)
  return Number.isNaN(timestamp.valueOf()) ? undefined : timestamp
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  let payload: ResendWebhookPayload
  try {
    payload = await verifyResendWebhook(req)
  } catch {
    return res.status(400).json({ error: 'Invalid webhook' })
  }

  const event = toMarketingEmailEvent(payload)
  const posthog = getPostHogClient()

  if (event && posthog) {
    posthog.capture({
      distinctId: event.distinctId,
      event: event.event,
      properties: event.properties,
      timestamp: parseEventTimestamp(event.timestamp)
    })
    await posthog.shutdown()
  }

  return res.status(200).json({ received: true })
}
