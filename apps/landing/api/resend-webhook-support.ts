import { createHash } from 'node:crypto'

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export type PostHogMarketingEmailEvent = {
  distinctId: string
  event: string
  properties: Record<string, JsonValue>
  timestamp?: string
}

export type ResendWebhookPayload = {
  type: string
  created_at?: string
  data?: Record<string, unknown>
}

const EVENT_NAME_BY_TYPE: Record<string, string> = {
  'email.sent': 'marketing_email_sent',
  'email.delivered': 'marketing_email_delivered',
  'email.opened': 'marketing_email_opened',
  'email.clicked': 'marketing_email_clicked',
  'email.bounced': 'marketing_email_bounced',
  'email.complained': 'marketing_email_complained',
  'email.delivery_delayed': 'marketing_email_delivery_delayed',
  'contact.unsubscribed': 'marketing_email_unsubscribed'
}
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) return stringValue(value[0])
  return stringValue(value)
}

function hashRecipient(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex')
}

function setIfPresent(
  properties: Record<string, JsonValue>,
  key: string,
  value: string | undefined
): void {
  if (value) properties[key] = value
}

function addClickProperties(
  properties: Record<string, JsonValue>,
  data: Record<string, unknown>
): void {
  const click = data.click
  if (!click || typeof click !== 'object') return

  const link = stringValue((click as Record<string, unknown>).link)
  if (!link) return

  try {
    const url = new URL(link)
    properties.click_host = url.host
    properties.campaign_path = url.pathname || '/'

    for (const key of UTM_KEYS) {
      const value = url.searchParams.get(key)
      if (value) properties[key] = value.slice(0, 120)
    }
  } catch {
    return
  }
}

export function toMarketingEmailEvent(
  payload: ResendWebhookPayload
): PostHogMarketingEmailEvent | null {
  const event = EVENT_NAME_BY_TYPE[payload.type]
  const data = payload.data
  if (!event || !data) return null

  const recipient = firstString(data.to) ?? stringValue(data.email)
  const distinctId = recipient
    ? `marketing_email:${hashRecipient(recipient)}`
    : `marketing_email_event:${stringValue(data.email_id) ?? payload.type}`

  const properties: Record<string, JsonValue> = {
    resend_event_type: payload.type
  }

  setIfPresent(properties, 'broadcast_id', stringValue(data.broadcast_id))
  setIfPresent(properties, 'email_id', stringValue(data.email_id))
  setIfPresent(properties, 'template_id', stringValue(data.template_id))
  setIfPresent(properties, 'subject', stringValue(data.subject))
  addClickProperties(properties, data)

  return {
    distinctId,
    event,
    properties,
    timestamp: payload.created_at
  }
}
