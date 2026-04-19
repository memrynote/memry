export interface GoogleCalendarChannelRow {
  channel_id: string
  user_id: string
  device_id: string
  source_id: string
  resource_id: string | null
  token_hash: string
  expires_at: number
}

const encoder = new TextEncoder()

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
}

export async function hashChannelToken(secret: string, token: string): Promise<string> {
  const key = await importHmacKey(secret)
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(token))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function verifyChannelToken(
  secret: string,
  presented: string,
  expectedHash: string
): Promise<boolean> {
  const computed = await hashChannelToken(secret, presented)
  if (computed.length !== expectedHash.length) return false
  let diff = 0
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ expectedHash.charCodeAt(i)
  }
  return diff === 0
}

export async function lookupChannel(
  db: D1Database,
  channelId: string
): Promise<GoogleCalendarChannelRow | null> {
  const row = await db
    .prepare(
      `SELECT channel_id, user_id, device_id, source_id, resource_id, token_hash, expires_at
       FROM google_calendar_channels WHERE channel_id = ?`
    )
    .bind(channelId)
    .first<GoogleCalendarChannelRow>()
  return row ?? null
}
