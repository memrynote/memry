import type { AuthStorage } from './auth-storage'
import { generateDeviceKeypair, buildDeviceChallenge } from './device-identity'

const WEB_APP_VERSION = 'web-1.0.0'

function browserLabel(): string {
  if (typeof navigator === 'undefined') return 'Web'
  const ua = navigator.userAgent
  if (ua.includes('Firefox')) return 'Web — Firefox'
  if (ua.includes('Edg')) return 'Web — Edge'
  if (ua.includes('Chrome')) return 'Web — Chrome'
  if (ua.includes('Safari')) return 'Web — Safari'
  return 'Web'
}

interface RegisterOptions {
  setupToken: string
  baseUrl: string
  storage: AuthStorage
  fetchImpl?: typeof fetch
}

export async function registerWebDevice({
  setupToken,
  baseUrl,
  storage,
  fetchImpl = fetch
}: RegisterOptions): Promise<void> {
  let keypair = storage.getDeviceKeypair()
  if (!keypair) {
    const kp = await generateDeviceKeypair()
    keypair = { publicKeyBase64: kp.publicKeyBase64, signingKeyBase64: kp.signingKeyBase64 }
    storage.setDeviceKeypair(keypair)
  }

  const challenge = await buildDeviceChallenge(setupToken, keypair.signingKeyBase64)

  const res = await fetchImpl(`${baseUrl}/auth/devices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${setupToken}` },
    body: JSON.stringify({
      name: browserLabel(),
      platform: 'web',
      appVersion: WEB_APP_VERSION,
      authPublicKey: challenge.authPublicKey,
      challengeSignature: challenge.challengeSignature,
      challengeNonce: challenge.challengeNonce,
      vaultId: 'default'
    })
  })
  if (!res.ok) {
    const msg = await res.text().catch(() => '')
    throw new Error(msg || `Device registration failed: ${res.status}`)
  }
  const data = (await res.json()) as { deviceId: string; accessToken: string; refreshToken: string }
  storage.setSession({
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    deviceId: data.deviceId
  })
}
