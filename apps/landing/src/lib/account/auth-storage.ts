export interface Session {
  accessToken: string
  refreshToken: string
  deviceId: string
}

export interface StoredKeypair {
  publicKeyBase64: string
  signingKeyBase64: string
}

interface KeyValue {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const SESSION_KEY = 'memry.account.session'
const KEYPAIR_KEY = 'memry.account.deviceKeypair'

export function createAuthStorage(backend: KeyValue) {
  return {
    getSession(): Session | null {
      const raw = backend.getItem(SESSION_KEY)
      return raw ? (JSON.parse(raw) as Session) : null
    },
    setSession(session: Session): void {
      backend.setItem(SESSION_KEY, JSON.stringify(session))
    },
    clearSession(): void {
      backend.removeItem(SESSION_KEY)
    },
    getDeviceKeypair(): StoredKeypair | null {
      const raw = backend.getItem(KEYPAIR_KEY)
      return raw ? (JSON.parse(raw) as StoredKeypair) : null
    },
    setDeviceKeypair(kp: StoredKeypair): void {
      backend.setItem(KEYPAIR_KEY, JSON.stringify(kp))
    }
  }
}

export type AuthStorage = ReturnType<typeof createAuthStorage>

export const browserAuthStorage = (): AuthStorage =>
  createAuthStorage(
    typeof window !== 'undefined'
      ? window.localStorage
      : { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  )
