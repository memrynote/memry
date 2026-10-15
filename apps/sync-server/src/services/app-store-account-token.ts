const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Fixed namespace for deriving a token from a user id that is not itself a UUID. Changing it
// orphans every App Store purchase made under the old token.
const APP_ACCOUNT_TOKEN_NAMESPACE = 'b8e0b8a6-5b7e-4a0c-9d3e-6f1c2a4d7e91'

/**
 * StoreKit's `appAccountToken` must be a UUID. User ids are UUIDs (services/user.ts mints them
 * with crypto.randomUUID), so the token is the user id itself and the App Store webhook can map a
 * notification straight back to `users.id`. Any other id gets a stable UUIDv5.
 */
export async function appAccountTokenForUser(userId: string): Promise<string> {
  if (UUID_PATTERN.test(userId)) return userId.toLowerCase()
  return uuidV5(APP_ACCOUNT_TOKEN_NAMESPACE, userId)
}

async function uuidV5(namespace: string, name: string): Promise<string> {
  const namespaceBytes = Uint8Array.from(
    namespace
      .replace(/-/g, '')
      .match(/../g)!
      .map((byte) => parseInt(byte, 16))
  )
  const nameBytes = new TextEncoder().encode(name)
  const input = new Uint8Array(namespaceBytes.length + nameBytes.length)
  input.set(namespaceBytes)
  input.set(nameBytes, namespaceBytes.length)
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', input)).slice(0, 16)
  hash[6] = (hash[6] & 0x0f) | 0x50
  hash[8] = (hash[8] & 0x3f) | 0x80
  const hex = Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
