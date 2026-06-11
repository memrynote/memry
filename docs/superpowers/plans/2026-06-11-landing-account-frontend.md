# Landing Account — Frontend (landing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a passwordless sign-in (`/auth`) and an authenticated account dashboard (`/account/*`) to the landing site, with a left-sidebar layout (Profile, Billing, Sync) and bottom Logout / Back-to-homepage.

**Architecture:** The browser authenticates as a lightweight **device**: it generates its own Ed25519 keypair (libsodium), signs the device challenge, and exchanges the setup token for access/refresh tokens. No vault keys, no E2E setup. Auth/session logic lives in pure, node:test-tested modules under `lib/account/`; React screens consume them through an `AuthProvider`. Account routes are client-only (excluded from the SSR prerender list).

**Tech Stack:** React 19, Vite, react-router-dom v7, Tailwind, libsodium-wrappers-sumo, node:test (pure modules), manual QA (components).

**Spec:** `docs/superpowers/specs/2026-06-11-landing-account-area-design.md`
**Depends on:** `docs/superpowers/plans/2026-06-11-landing-account-backend.md` (endpoints must exist).

**Testing reality:** `apps/landing` runs `node:test` with no jsdom/RTL (confirmed in `lib/analytics.test.ts`). Therefore: TDD applies to the pure modules in `lib/account/` (jti decode, device challenge, token storage with injected storage, api-client with injected fetch). React components are verified with `pnpm --filter @memry/landing typecheck`, `pnpm lint`, `pnpm --filter @memry/landing build`, and a manual QA pass. Do **not** add vitest/jsdom unless a later task explicitly calls for it.

---

## File Structure

- Create: `apps/landing/src/lib/account/config.ts` — `SYNC_SERVER_URL` from env.
- Create: `apps/landing/src/lib/account/extract-jti.ts` — decode a JWT `jti` (pure).
- Create: `apps/landing/src/lib/account/sodium.ts` — lazy libsodium init.
- Create: `apps/landing/src/lib/account/device-identity.ts` — keypair + device challenge.
- Create: `apps/landing/src/lib/account/auth-storage.ts` — token + device-key storage (injectable).
- Create: `apps/landing/src/lib/account/sync-api.ts` — typed sync-server calls (injectable fetch).
- Create: `apps/landing/src/lib/account/auth-client.ts` — sign-in orchestration + refresh-on-401.
- Create: `apps/landing/src/contexts/auth-context.tsx` — `AuthProvider` + `useAuth`.
- Create: `apps/landing/src/components/account/RequireAuth.tsx` — route guard.
- Create: `apps/landing/src/components/account/AccountLayout.tsx` — sidebar + `<Outlet>`.
- Create: `apps/landing/src/components/account/CheckoutPanel.tsx` — extracted from `Checkout.tsx`.
- Create: `apps/landing/src/pages/Auth.tsx` — sign-in (OTP + Google).
- Create: `apps/landing/src/pages/AuthCallback.tsx` — Google OAuth return handler.
- Create: `apps/landing/src/pages/account/ProfileSection.tsx`
- Create: `apps/landing/src/pages/account/BillingSection.tsx`
- Create: `apps/landing/src/pages/account/SyncSection.tsx`
- Modify: `apps/landing/src/pages/Checkout.tsx` — render the shared `CheckoutPanel`.
- Modify: `apps/landing/src/App.tsx` — routes + `AuthProvider`.
- Modify: `apps/landing/src/components/layout/Header.tsx` — Account nav item.
- Modify: `apps/landing/src/lib/analytics.ts` — new event names.
- Modify: `apps/landing/.env.example` — `VITE_SYNC_SERVER_URL`.

Test command (pure modules): `pnpm --filter @memry/landing test` (runs `node --test`).
Build/verify: `pnpm --filter @memry/landing typecheck && pnpm lint && pnpm --filter @memry/landing build`.

---

## Task 1: Add libsodium dep + env config

**Files:**
- Modify: `apps/landing/package.json`
- Create: `apps/landing/src/lib/account/config.ts`
- Modify: `apps/landing/.env.example`

- [ ] **Step 1: Add the dependency**

Run: `pnpm --filter @memry/landing add libsodium-wrappers-sumo && pnpm --filter @memry/landing add -D @types/libsodium-wrappers-sumo`
Expected: package.json updated, lockfile updated.

- [ ] **Step 2: Create config**

```typescript
// apps/landing/src/lib/account/config.ts
const fallback = 'http://localhost:8787'

export const SYNC_SERVER_URL: string =
  (import.meta.env.VITE_SYNC_SERVER_URL as string | undefined)?.replace(/\/$/, '') ?? fallback

export const WEB_OAUTH_REDIRECT_PATH = '/auth/oauth/callback'
```

- [ ] **Step 3: Document the env var**

Add to `apps/landing/.env.example`:

```
# Sync server base URL (no trailing slash). Dev default: http://localhost:8787
VITE_SYNC_SERVER_URL=http://localhost:8787
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @memry/landing typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/landing/package.json apps/landing/src/lib/account/config.ts apps/landing/.env.example pnpm-lock.yaml
git commit -m "chore(landing): add libsodium + sync-server URL config for account area"
```

---

## Task 2: `extract-jti` (pure)

**Files:**
- Create: `apps/landing/src/lib/account/extract-jti.ts`
- Test: `apps/landing/src/lib/account/extract-jti.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { extractJti } from './extract-jti'

describe('extractJti', () => {
  it('reads the jti claim from a JWT payload', () => {
    const payload = Buffer.from(JSON.stringify({ jti: 'abc-123', sub: 'u1' })).toString('base64url')
    const jwt = `header.${payload}.sig`
    assert.equal(extractJti(jwt), 'abc-123')
  })

  it('throws when the token has no jti', () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'u1' })).toString('base64url')
    assert.throws(() => extractJti(`h.${payload}.s`))
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @memry/landing test`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement**

```typescript
// apps/landing/src/lib/account/extract-jti.ts
function base64UrlDecode(input: string): string {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4))
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/') + pad
  if (typeof atob === 'function') return atob(base64)
  return Buffer.from(base64, 'base64').toString('binary')
}

export function extractJti(jwt: string): string {
  const parts = jwt.split('.')
  if (parts.length < 2) throw new Error('Malformed token')
  const payload = JSON.parse(base64UrlDecode(parts[1])) as { jti?: string }
  if (!payload.jti) throw new Error('Token missing jti claim')
  return payload.jti
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @memry/landing test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/landing/src/lib/account/extract-jti.ts apps/landing/src/lib/account/extract-jti.test.ts
git commit -m "feat(landing): extractJti helper for device registration"
```

---

## Task 3: sodium init + device identity (challenge signing)

**Files:**
- Create: `apps/landing/src/lib/account/sodium.ts`
- Create: `apps/landing/src/lib/account/device-identity.ts`
- Test: `apps/landing/src/lib/account/device-identity.test.ts`

This mirrors the desktop scheme in `apps/desktop/src/main/sync/device-registration.ts`: Ed25519 `crypto_sign_detached` over `` `${nonce}:${jti}` ``, base64 `ORIGINAL`.

- [ ] **Step 1: Write the failing test**

```typescript
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import sodium from 'libsodium-wrappers-sumo'
import { generateDeviceKeypair, buildDeviceChallenge } from './device-identity'

describe('device identity', () => {
  it('produces a challenge signature the server scheme would verify', async () => {
    await sodium.ready
    const kp = await generateDeviceKeypair()
    const jwt = `h.${Buffer.from(JSON.stringify({ jti: 'jti-1' })).toString('base64url')}.s`

    const challenge = await buildDeviceChallenge(jwt, kp.secretKeyBase64, 'nonce-1')

    // Re-derive what the server verifies: nonce:jti signed by the device key.
    const sig = sodium.from_base64(challenge.challengeSignature, sodium.base64_variants.ORIGINAL)
    const pub = sodium.from_base64(challenge.authPublicKey, sodium.base64_variants.ORIGINAL)
    const msg = new TextEncoder().encode('nonce-1:jti-1')
    assert.equal(sodium.crypto_sign_verify_detached(sig, msg, pub), true)
    assert.equal(challenge.challengeNonce, 'nonce-1')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @memry/landing test`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement**

```typescript
// apps/landing/src/lib/account/sodium.ts
import sodium from 'libsodium-wrappers-sumo'

export async function getSodium(): Promise<typeof sodium> {
  await sodium.ready
  return sodium
}
```

```typescript
// apps/landing/src/lib/account/device-identity.ts
import { getSodium } from './sodium'
import { extractJti } from './extract-jti'

export interface DeviceKeypair {
  publicKeyBase64: string
  secretKeyBase64: string
}

export async function generateDeviceKeypair(): Promise<DeviceKeypair> {
  const sodium = await getSodium()
  const kp = sodium.crypto_sign_keypair()
  return {
    publicKeyBase64: sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL),
    secretKeyBase64: sodium.to_base64(kp.privateKey, sodium.base64_variants.ORIGINAL)
  }
}

export interface DeviceChallenge {
  authPublicKey: string
  challengeSignature: string
  challengeNonce: string
}

export async function buildDeviceChallenge(
  setupToken: string,
  secretKeyBase64: string,
  nonce: string = crypto.randomUUID()
): Promise<DeviceChallenge> {
  const sodium = await getSodium()
  const secretKey = sodium.from_base64(secretKeyBase64, sodium.base64_variants.ORIGINAL)
  const publicKey = secretKey.slice(32) // Ed25519 secret key = seed(32) || public(32)
  const jti = extractJti(setupToken)
  const payload = new TextEncoder().encode(`${nonce}:${jti}`)
  const signature = sodium.crypto_sign_detached(payload, secretKey)
  return {
    authPublicKey: sodium.to_base64(publicKey, sodium.base64_variants.ORIGINAL),
    challengeSignature: sodium.to_base64(signature, sodium.base64_variants.ORIGINAL),
    challengeNonce: nonce
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @memry/landing test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/landing/src/lib/account/sodium.ts apps/landing/src/lib/account/device-identity.ts apps/landing/src/lib/account/device-identity.test.ts
git commit -m "feat(landing): device keypair + challenge signing"
```

---

## Task 4: auth storage (injectable)

**Files:**
- Create: `apps/landing/src/lib/account/auth-storage.ts`
- Test: `apps/landing/src/lib/account/auth-storage.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createAuthStorage } from './auth-storage'

function memoryStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k)
  }
}

describe('auth storage', () => {
  it('round-trips tokens and clears them', () => {
    const s = createAuthStorage(memoryStorage())
    s.setSession({ accessToken: 'a', refreshToken: 'r', deviceId: 'd' })
    assert.deepEqual(s.getSession(), { accessToken: 'a', refreshToken: 'r', deviceId: 'd' })
    s.clearSession()
    assert.equal(s.getSession(), null)
  })

  it('persists the device keypair separately from the session', () => {
    const s = createAuthStorage(memoryStorage())
    s.setDeviceKeypair({ publicKeyBase64: 'p', secretKeyBase64: 'k' })
    s.clearSession()
    assert.deepEqual(s.getDeviceKeypair(), { publicKeyBase64: 'p', secretKeyBase64: 'k' })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @memry/landing test`
Expected: FAIL

- [ ] **Step 3: Implement**

```typescript
// apps/landing/src/lib/account/auth-storage.ts
export interface Session {
  accessToken: string
  refreshToken: string
  deviceId: string
}

export interface StoredKeypair {
  publicKeyBase64: string
  secretKeyBase64: string
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @memry/landing test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/landing/src/lib/account/auth-storage.ts apps/landing/src/lib/account/auth-storage.test.ts
git commit -m "feat(landing): injectable auth storage (session + device keypair)"
```

---

## Task 5: sync-api client (injectable fetch + refresh-on-401)

**Files:**
- Create: `apps/landing/src/lib/account/sync-api.ts`
- Test: `apps/landing/src/lib/account/sync-api.test.ts`

Before implementing, open `apps/sync-server/src/routes/auth.ts` at the `/refresh` handler (~line 644) and confirm the request body shape (`{ refreshToken }`) and response (`{ accessToken, refreshToken }`). Match exactly.

- [ ] **Step 1: Write the failing test**

```typescript
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createSyncApi } from './sync-api'
import { createAuthStorage } from './auth-storage'

function memoryStorage() {
  const m = new Map<string, string>()
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }
}

describe('sync api', () => {
  it('retries once after refreshing on a 401', async () => {
    const storage = createAuthStorage(memoryStorage())
    storage.setSession({ accessToken: 'old', refreshToken: 'r', deviceId: 'd' })
    const calls: string[] = []
    const fakeFetch = async (url: string, init?: RequestInit) => {
      calls.push(url)
      if (url.endsWith('/auth/billing') && (init?.headers as any).Authorization === 'Bearer old') {
        return new Response('{}', { status: 401 })
      }
      if (url.endsWith('/auth/refresh')) {
        return new Response(JSON.stringify({ accessToken: 'new', refreshToken: 'r2' }), { status: 200 })
      }
      return new Response(JSON.stringify({ plan: 'pro' }), { status: 200 })
    }
    const api = createSyncApi({ baseUrl: 'https://s', storage, fetchImpl: fakeFetch as typeof fetch })
    const res = await api.authedJson('/auth/billing')
    assert.deepEqual(res, { plan: 'pro' })
    assert.equal(storage.getSession()?.accessToken, 'new')
    assert.ok(calls.includes('https://s/auth/refresh'))
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @memry/landing test`
Expected: FAIL

- [ ] **Step 3: Implement**

```typescript
// apps/landing/src/lib/account/sync-api.ts
import type { AuthStorage } from './auth-storage'

interface SyncApiOptions {
  baseUrl: string
  storage: AuthStorage
  fetchImpl?: typeof fetch
}

export function createSyncApi({ baseUrl, storage, fetchImpl = fetch }: SyncApiOptions) {
  async function refresh(): Promise<boolean> {
    const session = storage.getSession()
    if (!session) return false
    const res = await fetchImpl(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: session.refreshToken })
    })
    if (!res.ok) return false
    const data = (await res.json()) as { accessToken: string; refreshToken: string }
    storage.setSession({ ...session, ...data })
    return true
  }

  async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const send = () => {
      const token = storage.getSession()?.accessToken
      return fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
      })
    }
    let res = await send()
    if (res.status === 401 && (await refresh())) {
      res = await send()
    }
    return res
  }

  async function authedJson<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const res = await authedFetch(path, init)
    if (!res.ok) {
      const message = await res.text().catch(() => '')
      throw new Error(message || `Request failed: ${res.status}`)
    }
    return (await res.json()) as T
  }

  // Public (unauthenticated) helper for OTP/OAuth/device endpoints.
  async function publicJson<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }
    })
    if (!res.ok) {
      const message = await res.text().catch(() => '')
      throw new Error(message || `Request failed: ${res.status}`)
    }
    return (await res.json()) as T
  }

  return { authedFetch, authedJson, publicJson }
}

export type SyncApi = ReturnType<typeof createSyncApi>
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @memry/landing test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/landing/src/lib/account/sync-api.ts apps/landing/src/lib/account/sync-api.test.ts
git commit -m "feat(landing): sync-server api client with refresh-on-401"
```

---

## Task 6: auth-client (sign-in orchestration)

**Files:**
- Create: `apps/landing/src/lib/account/auth-client.ts`
- Test: `apps/landing/src/lib/account/auth-client.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import sodium from 'libsodium-wrappers-sumo'
import { registerWebDevice } from './auth-client'
import { createAuthStorage } from './auth-storage'

function memoryStorage() {
  const m = new Map<string, string>()
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }
}

describe('registerWebDevice', () => {
  it('registers a device with a signed challenge and stores the session', async () => {
    await sodium.ready
    const storage = createAuthStorage(memoryStorage())
    const setupToken = `h.${Buffer.from(JSON.stringify({ jti: 'jti-1' })).toString('base64url')}.s`
    let body: any
    const fakeFetch = async (_url: string, init?: RequestInit) => {
      body = JSON.parse(init!.body as string)
      return new Response(
        JSON.stringify({ deviceId: 'dev-1', accessToken: 'a', refreshToken: 'r' }),
        { status: 200 }
      )
    }
    await registerWebDevice({
      setupToken,
      baseUrl: 'https://s',
      storage,
      fetchImpl: fakeFetch as typeof fetch
    })
    assert.equal(body.platform, 'web')
    assert.equal(typeof body.authPublicKey, 'string')
    assert.deepEqual(storage.getSession(), { accessToken: 'a', refreshToken: 'r', deviceId: 'dev-1' })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @memry/landing test`
Expected: FAIL

- [ ] **Step 3: Implement**

```typescript
// apps/landing/src/lib/account/auth-client.ts
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
    keypair = await generateDeviceKeypair()
    storage.setDeviceKeypair(keypair)
  }

  const challenge = await buildDeviceChallenge(setupToken, keypair.secretKeyBase64)

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
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @memry/landing test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/landing/src/lib/account/auth-client.ts apps/landing/src/lib/account/auth-client.test.ts
git commit -m "feat(landing): registerWebDevice exchanges setup token for session"
```

---

## Task 7: AuthProvider + useAuth (SSR-safe)

**Files:**
- Create: `apps/landing/src/contexts/auth-context.tsx`

Component task — verified by typecheck/lint/build + manual QA (no jsdom).

- [ ] **Step 1: Implement**

```tsx
// apps/landing/src/contexts/auth-context.tsx
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { SYNC_SERVER_URL } from '@/lib/account/config'
import { browserAuthStorage, type AuthStorage } from '@/lib/account/auth-storage'
import { createSyncApi, type SyncApi } from '@/lib/account/sync-api'

interface AuthState {
  ready: boolean
  isSignedIn: boolean
  storage: AuthStorage
  api: SyncApi
  refreshSignedIn: () => void
  signOutLocal: () => void
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const storage = useMemo(() => browserAuthStorage(), [])
  const api = useMemo(
    () => createSyncApi({ baseUrl: SYNC_SERVER_URL, storage }),
    [storage]
  )
  const [ready, setReady] = useState(false)
  const [isSignedIn, setIsSignedIn] = useState(false)

  useEffect(() => {
    // Client-only: localStorage is unavailable during SSR.
    setIsSignedIn(Boolean(storage.getSession()))
    setReady(true)
  }, [storage])

  const value: AuthState = {
    ready,
    isSignedIn,
    storage,
    api,
    refreshSignedIn: () => setIsSignedIn(Boolean(storage.getSession())),
    signOutLocal: () => {
      storage.clearSession()
      setIsSignedIn(false)
    }
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @memry/landing typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/landing/src/contexts/auth-context.tsx
git commit -m "feat(landing): AuthProvider + useAuth (SSR-safe)"
```

---

## Task 8: Analytics events + Account nav item

**Files:**
- Modify: `apps/landing/src/lib/analytics.ts`
- Modify: `apps/landing/src/components/layout/Header.tsx`

- [ ] **Step 1: Add event names**

In the `LandingEventName` union (analytics.ts:1), add:

```typescript
  | 'landing_account_open'
  | 'landing_account_signin'
  | 'landing_account_signout'
```

- [ ] **Step 2: Add the Account nav button (desktop CTA cluster)**

In `Header.tsx`, in the desktop cluster (lines 495-510, before the "Join" button), add an Account link. Use `useAuth` to point at `/account` when signed in else `/auth`:

```tsx
// near the top of Header(): const { isSignedIn } = useAuth()
<Button variant="ghost" size="sm" className="rounded-full px-4" asChild>
  <Link
    to={isSignedIn ? '/account' : '/auth'}
    onClick={() => trackLandingEvent('landing_account_open', 'nav:account')}
  >
    Account
  </Link>
</Button>
```

Add the matching entry to the mobile menu (lines 556-575 area) using `MobileNavLink` with `href={isSignedIn ? '/account' : '/auth'}` and label `"Account"`.

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm --filter @memry/landing typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/landing/src/lib/analytics.ts apps/landing/src/components/layout/Header.tsx
git commit -m "feat(landing): Account nav item + account analytics events"
```

---

## Task 9: Sign-in page `/auth` (OTP + Google)

**Files:**
- Create: `apps/landing/src/pages/Auth.tsx`

Component task — verify by typecheck/lint/build + manual QA.

- [ ] **Step 1: Implement**

Build a two-step OTP form (enter email → enter code) plus a "Continue with Google" button. Use `useAuth().api.publicJson` for OTP and `registerWebDevice` after verify. On success call `refreshSignedIn()` and `navigate('/account/profile')`. Redirect to `/account` immediately if already signed in.

```tsx
// apps/landing/src/pages/Auth.tsx
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageHead } from '@/components/shared/PageHead'
import { Container } from '@/components/layout/Container'
import { useAuth } from '@/contexts/auth-context'
import { registerWebDevice } from '@/lib/account/auth-client'
import { SYNC_SERVER_URL, WEB_OAUTH_REDIRECT_PATH } from '@/lib/account/config'
import { trackLandingEvent } from '@/lib/analytics'

export function AuthPage() {
  const { api, storage, refreshSignedIn } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function requestCode() {
    setBusy(true)
    setError(null)
    try {
      await api.publicJson('/auth/otp/request', {
        method: 'POST',
        body: JSON.stringify({ email })
      })
      setStep('code')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send code')
    } finally {
      setBusy(false)
    }
  }

  async function verifyCode() {
    setBusy(true)
    setError(null)
    try {
      const res = await api.publicJson<{ setupToken: string }>('/auth/otp/verify', {
        method: 'POST',
        body: JSON.stringify({ email, code })
      })
      await registerWebDevice({ setupToken: res.setupToken, baseUrl: SYNC_SERVER_URL, storage })
      refreshSignedIn()
      trackLandingEvent('landing_account_signin', 'auth:otp')
      navigate('/account/profile')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid code')
    } finally {
      setBusy(false)
    }
  }

  function continueWithGoogle() {
    const redirectUri = `${window.location.origin}${WEB_OAUTH_REDIRECT_PATH}`
    window.location.href =
      `${SYNC_SERVER_URL}/auth/oauth/google?redirect_uri=${encodeURIComponent(redirectUri)}`
  }

  return (
    <>
      <PageHead page="pricing" />
      <main className="py-24">
        <Container size="sm">
          <div className="mx-auto max-w-sm rounded-2xl border border-border bg-card p-8 shadow-card">
            <h1 className="font-editorial text-xl tracking-[-0.01em]">Sign in to Memry</h1>
            {error ? <p className="mt-3 text-sm text-red-500">{error}</p> : null}
            {step === 'email' ? (
              <div className="mt-6 space-y-3">
                <Input
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <Button className="w-full" disabled={busy || !email} onClick={requestCode}>
                  {busy ? 'Sending…' : 'Email me a code'}
                </Button>
              </div>
            ) : (
              <div className="mt-6 space-y-3">
                <Input
                  inputMode="numeric"
                  placeholder="123456"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
                <Button className="w-full" disabled={busy || code.length !== 6} onClick={verifyCode}>
                  {busy ? 'Verifying…' : 'Verify & sign in'}
                </Button>
              </div>
            )}
            <div className="my-5 text-center text-xs text-muted">or</div>
            <Button variant="outline" className="w-full" onClick={continueWithGoogle}>
              Continue with Google
            </Button>
          </div>
        </Container>
      </main>
    </>
  )
}
```

Confirm the `/auth/otp/verify` response field name is `setupToken` (it is — `auth.ts:243-248`). Confirm the `/auth/otp/request` response is `{ success, expiresIn }`.

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm --filter @memry/landing typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/landing/src/pages/Auth.tsx
git commit -m "feat(landing): /auth sign-in page (OTP + Google)"
```

---

## Task 10: OAuth callback page `/auth/oauth/callback`

**Files:**
- Create: `apps/landing/src/pages/AuthCallback.tsx`

- [ ] **Step 1: Implement**

Reads `code` + `state` from the URL, POSTs to `/auth/oauth/google/callback`, registers the device, redirects to `/account/profile`.

```tsx
// apps/landing/src/pages/AuthCallback.tsx
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Container } from '@/components/layout/Container'
import { useAuth } from '@/contexts/auth-context'
import { registerWebDevice } from '@/lib/account/auth-client'
import { SYNC_SERVER_URL } from '@/lib/account/config'
import { trackLandingEvent } from '@/lib/analytics'

export function AuthCallbackPage() {
  const { api, storage, refreshSignedIn } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [error, setError] = useState<string | null>(null)
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true
    const code = params.get('code')
    const state = params.get('state')
    if (!code || !state) {
      setError('Missing OAuth parameters')
      return
    }
    ;(async () => {
      try {
        const res = await api.publicJson<{ setupToken: string }>('/auth/oauth/google/callback', {
          method: 'POST',
          body: JSON.stringify({ code, state })
        })
        await registerWebDevice({ setupToken: res.setupToken, baseUrl: SYNC_SERVER_URL, storage })
        refreshSignedIn()
        trackLandingEvent('landing_account_signin', 'auth:google')
        navigate('/account/profile', { replace: true })
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Sign-in failed')
      }
    })()
  }, [api, storage, params, navigate, refreshSignedIn])

  return (
    <main className="py-24">
      <Container size="sm">
        <p className="text-center text-sm text-muted">
          {error ? error : 'Finishing sign-in…'}
        </p>
      </Container>
    </main>
  )
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm --filter @memry/landing typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/landing/src/pages/AuthCallback.tsx
git commit -m "feat(landing): Google OAuth callback page"
```

---

## Task 11: RequireAuth guard + AccountLayout (sidebar)

**Files:**
- Create: `apps/landing/src/components/account/RequireAuth.tsx`
- Create: `apps/landing/src/components/account/AccountLayout.tsx`

- [ ] **Step 1: Implement the guard**

```tsx
// apps/landing/src/components/account/RequireAuth.tsx
import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '@/contexts/auth-context'

export function RequireAuth({ children }: { children: ReactNode }) {
  const { ready, isSignedIn } = useAuth()
  if (!ready) return null // avoid SSR/first-paint flash
  if (!isSignedIn) return <Navigate to="/auth" replace />
  return <>{children}</>
}
```

- [ ] **Step 2: Implement the layout**

Left sidebar with NavLinks (Profile/Billing/Sync), bottom Logout + Back to homepage, right `<Outlet>`.

```tsx
// apps/landing/src/components/account/AccountLayout.tsx
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { Container } from '@/components/layout/Container'
import { cn } from '@/lib/utils'
import { useAuth } from '@/contexts/auth-context'
import { SYNC_SERVER_URL } from '@/lib/account/config'
import { trackLandingEvent } from '@/lib/analytics'

const TABS = [
  { to: '/account/profile', label: 'Profile' },
  { to: '/account/billing', label: 'Billing' },
  { to: '/account/sync', label: 'Sync' }
]

export function AccountLayout() {
  const { api, signOutLocal } = useAuth()
  const navigate = useNavigate()

  async function logout() {
    try {
      await api.authedFetch('/auth/logout', { method: 'POST' })
    } catch {
      // best-effort; clear local session regardless
    }
    signOutLocal()
    trackLandingEvent('landing_account_signout', 'account:logout')
    navigate('/')
  }

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      'block rounded-lg px-3 py-2 text-sm font-medium transition-colors',
      isActive ? 'bg-paper-alt text-ink' : 'text-muted hover:text-ink'
    )

  return (
    <main className="py-24">
      <Container size="lg">
        <div className="mx-auto grid max-w-5xl gap-8 md:grid-cols-[200px_1fr]">
          <aside className="flex flex-col gap-1">
            {TABS.map((t) => (
              <NavLink key={t.to} to={t.to} className={linkClass}>
                {t.label}
              </NavLink>
            ))}
            <div className="mt-6 border-t border-border pt-4 space-y-1">
              <button
                type="button"
                onClick={logout}
                className="block w-full rounded-lg px-3 py-2 text-start text-sm font-medium text-muted hover:text-ink"
              >
                Log out
              </button>
              <NavLink to="/" className="block rounded-lg px-3 py-2 text-sm font-medium text-muted hover:text-ink">
                Back to homepage
              </NavLink>
            </div>
          </aside>
          <section>
            <Outlet />
          </section>
        </div>
      </Container>
    </main>
  )
}
```

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm --filter @memry/landing typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/landing/src/components/account/RequireAuth.tsx apps/landing/src/components/account/AccountLayout.tsx
git commit -m "feat(landing): account layout shell + route guard"
```

---

## Task 12: Profile section

**Files:**
- Create: `apps/landing/src/pages/account/ProfileSection.tsx`

Implements: current email + change-email (OTP), contact support (mailto), log out everywhere, delete account (typed confirm + OTP).

- [ ] **Step 1: Implement**

```tsx
// apps/landing/src/pages/account/ProfileSection.tsx
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/contexts/auth-context'

const SUPPORT_EMAIL = 'support@memrynote.com'

export function ProfileSection() {
  const { api, signOutLocal } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState<string>('')
  const [newEmail, setNewEmail] = useState('')
  const [emailCode, setEmailCode] = useState('')
  const [emailStep, setEmailStep] = useState<'idle' | 'code'>('idle')
  const [deleteCode, setDeleteCode] = useState('')
  const [confirmText, setConfirmText] = useState('')
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    api
      .authedJson<{ email: string }>('/auth/billing')
      .then((b) => setEmail(b.email))
      .catch(() => {})
  }, [api])

  async function requestEmailChange() {
    await api.authedJson('/auth/email/change', { method: 'POST', body: JSON.stringify({ newEmail }) })
    setEmailStep('code')
    setMsg('Code sent to ' + newEmail)
  }
  async function verifyEmailChange() {
    await api.authedJson('/auth/email/change/verify', {
      method: 'POST',
      body: JSON.stringify({ newEmail, code: emailCode })
    })
    setEmail(newEmail)
    setEmailStep('idle')
    setMsg('Email updated')
  }
  async function logoutEverywhere() {
    await api.authedFetch('/auth/logout-all', { method: 'POST' })
    signOutLocal()
    navigate('/')
  }
  async function requestDeleteCode() {
    await api.authedJson('/auth/otp/request', { method: 'POST', body: JSON.stringify({ email }) })
    setMsg('Confirmation code sent to ' + email)
  }
  async function deleteAccount() {
    await api.authedFetch('/auth/account', { method: 'DELETE', body: JSON.stringify({ code: deleteCode }) })
    signOutLocal()
    navigate('/')
  }

  return (
    <div className="space-y-8">
      <h1 className="font-editorial text-2xl tracking-[-0.01em]">Profile</h1>
      {msg ? <p className="text-sm text-muted">{msg}</p> : null}

      <section className="rounded-2xl border border-border bg-card p-6">
        <h2 className="text-sm font-semibold">Email</h2>
        <p className="mt-1 text-sm text-muted">{email || '—'}</p>
        {emailStep === 'idle' ? (
          <div className="mt-4 flex gap-2">
            <Input type="email" placeholder="new@example.com" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
            <Button variant="outline" disabled={!newEmail} onClick={requestEmailChange}>Change</Button>
          </div>
        ) : (
          <div className="mt-4 flex gap-2">
            <Input inputMode="numeric" placeholder="123456" value={emailCode} onChange={(e) => setEmailCode(e.target.value)} />
            <Button disabled={emailCode.length !== 6} onClick={verifyEmailChange}>Confirm</Button>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-border bg-card p-6">
        <h2 className="text-sm font-semibold">Support & sessions</h2>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <a href={`mailto:${SUPPORT_EMAIL}`}>Contact support</a>
          </Button>
          <Button variant="outline" onClick={logoutEverywhere}>Log out everywhere</Button>
        </div>
      </section>

      <section className="rounded-2xl border border-red-500/30 bg-card p-6">
        <h2 className="text-sm font-semibold text-red-500">Delete account</h2>
        <p className="mt-1 text-sm text-muted">This permanently erases your account and synced data. It cannot be undone.</p>
        <div className="mt-4 space-y-2">
          <Button variant="outline" onClick={requestDeleteCode}>Email me a confirmation code</Button>
          <Input inputMode="numeric" placeholder="Confirmation code" value={deleteCode} onChange={(e) => setDeleteCode(e.target.value)} />
          <Input placeholder='Type "DELETE" to confirm' value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
          <Button
            className="bg-red-500 text-white hover:bg-red-600"
            disabled={confirmText !== 'DELETE' || deleteCode.length !== 6}
            onClick={deleteAccount}
          >
            Delete my account
          </Button>
        </div>
      </section>
    </div>
  )
}
```

Confirm `GET /auth/billing` returns an `email` field (`getBillingStatus` → `formatBillingStatus(entitlement, user.email)`); if the field name differs, adjust.

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm --filter @memry/landing typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/landing/src/pages/account/ProfileSection.tsx
git commit -m "feat(landing): account Profile section (email, support, logout-all, delete)"
```

---

## Task 13: Billing section (invoices + portal)

**Files:**
- Create: `apps/landing/src/pages/account/BillingSection.tsx`

- [ ] **Step 1: Implement**

```tsx
// apps/landing/src/pages/account/BillingSection.tsx
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/auth-context'

interface InvoiceRow {
  id: string
  status: string
  billedAt: string | null
  amount: string
  currency: string
}

export function BillingSection() {
  const { api } = useAuth()
  const [billing, setBilling] = useState<Record<string, unknown> | null>(null)
  const [invoices, setInvoices] = useState<InvoiceRow[]>([])

  useEffect(() => {
    api.authedJson<Record<string, unknown>>('/auth/billing').then(setBilling).catch(() => {})
    api.authedJson<{ invoices: InvoiceRow[] }>('/auth/billing/invoices')
      .then((r) => setInvoices(r.invoices))
      .catch(() => {})
  }, [api])

  async function openPortal() {
    const { portalUrl } = await api.authedJson<{ portalUrl: string }>('/auth/billing/portal-session', {
      method: 'POST'
    })
    window.open(portalUrl, '_blank', 'noopener')
  }

  async function openInvoice(id: string) {
    const { url } = await api.authedJson<{ url: string }>(`/auth/billing/invoices/${id}/pdf`)
    window.open(url, '_blank', 'noopener')
  }

  return (
    <div className="space-y-8">
      <h1 className="font-editorial text-2xl tracking-[-0.01em]">Billing</h1>

      <section className="rounded-2xl border border-border bg-card p-6">
        <h2 className="text-sm font-semibold">Subscription</h2>
        <p className="mt-1 text-sm text-muted">
          {billing ? JSON.stringify(billing.plan ?? billing.status ?? 'See portal') : 'Loading…'}
        </p>
        <Button variant="outline" className="mt-4" onClick={openPortal}>
          Manage payment method
        </Button>
      </section>

      <section className="rounded-2xl border border-border bg-card p-6">
        <h2 className="text-sm font-semibold">Invoices</h2>
        {invoices.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No invoices yet.</p>
        ) : (
          <ul className="mt-4 divide-y divide-border">
            {invoices.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between py-3 text-sm">
                <span>{inv.billedAt?.slice(0, 10) ?? '—'}</span>
                <span>
                  {(Number(inv.amount) / 100).toFixed(2)} {inv.currency}
                </span>
                <span className="text-muted">{inv.status}</span>
                <button className="text-terracotta hover:underline" onClick={() => openInvoice(inv.id)}>
                  PDF
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
```

Render the subscription summary using whatever fields `getBillingStatus` actually returns (open `formatBillingStatus` in `paddle-billing.ts`); replace the placeholder `JSON.stringify` with the real field(s) before declaring done.

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm --filter @memry/landing typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/landing/src/pages/account/BillingSection.tsx
git commit -m "feat(landing): account Billing section (invoices + portal)"
```

---

## Task 14: Extract CheckoutPanel + Sync section

**Files:**
- Create: `apps/landing/src/components/account/CheckoutPanel.tsx`
- Modify: `apps/landing/src/pages/Checkout.tsx`
- Create: `apps/landing/src/pages/account/SyncSection.tsx`

- [ ] **Step 1: Extract the panel**

Move the plan-selector + cadence + order-summary JSX out of `Checkout.tsx` into a `CheckoutPanel` component that accepts the checkout token as a prop instead of reading the URL hash:

```tsx
// apps/landing/src/components/account/CheckoutPanel.tsx
// Props: { token: string | null; onTokenMissing?: ReactNode }
// Body: the existing plan/cadence/OrderSummary UI and `proceed()` logic
// currently inside Checkout.tsx (lines ~31-219), with `token` taken from props.
```

Keep the existing `openPaddleCheckout`, `getCheckoutSummary`, plan/cadence state, and status handling verbatim — only the token *source* changes from `parseCheckoutToken(window.location.hash)` to the `token` prop.

- [ ] **Step 2: Point Checkout.tsx at the panel**

`Checkout.tsx` keeps reading the hash token (`parseCheckoutToken`) and renders `<CheckoutPanel token={token} onTokenMissing={<NoTokenNotice />} />`. This preserves the existing desktop→checkout deep-link flow.

- [ ] **Step 3: Sync section mints its own token**

```tsx
// apps/landing/src/pages/account/SyncSection.tsx
import { useEffect, useState } from 'react'
import { CheckoutPanel } from '@/components/account/CheckoutPanel'
import { useAuth } from '@/contexts/auth-context'

export function SyncSection() {
  const { api } = useAuth()
  const [token, setToken] = useState<string | null>(null)

  useEffect(() => {
    api
      .authedJson<{ checkoutToken: string }>('/auth/checkout-token', { method: 'POST' })
      .then((r) => setToken(r.checkoutToken))
      .catch(() => setToken(null))
  }, [api])

  return (
    <div className="space-y-6">
      <h1 className="font-editorial text-2xl tracking-[-0.01em]">Sync</h1>
      <CheckoutPanel token={token} />
    </div>
  )
}
```

- [ ] **Step 4: Verify build (round-trip)**

Run: `pnpm --filter @memry/landing typecheck && pnpm lint && pnpm --filter @memry/landing build`
Expected: PASS, and `/checkout` still renders the same panel.

- [ ] **Step 5: Commit**

```bash
git add apps/landing/src/components/account/CheckoutPanel.tsx apps/landing/src/pages/Checkout.tsx apps/landing/src/pages/account/SyncSection.tsx
git commit -m "feat(landing): extract CheckoutPanel + account Sync section"
```

---

## Task 15: Wire routes + AuthProvider (keep account out of SSR prerender)

**Files:**
- Modify: `apps/landing/src/App.tsx`
- Modify: `apps/landing/src/entry-server.tsx` (do NOT add `/auth` or `/account/*` to `ROUTE_MAP`)

- [ ] **Step 1: Wrap the app + add routes**

In `App.tsx`, wrap `AppContent` (or the `BrowserRouter` subtree) with `<AuthProvider>`, import the new pages, and add:

```tsx
import { AuthProvider } from '@/contexts/auth-context'
import { AuthPage } from '@/pages/Auth'
import { AuthCallbackPage } from '@/pages/AuthCallback'
import { RequireAuth } from '@/components/account/RequireAuth'
import { AccountLayout } from '@/components/account/AccountLayout'
import { ProfileSection } from '@/pages/account/ProfileSection'
import { BillingSection } from '@/pages/account/BillingSection'
import { SyncSection } from '@/pages/account/SyncSection'

// inside <Routes>:
<Route path="/auth" element={<AuthPage />} />
<Route path="/auth/oauth/callback" element={<AuthCallbackPage />} />
<Route
  path="/account"
  element={
    <RequireAuth>
      <AccountLayout />
    </RequireAuth>
  }
>
  <Route index element={<ProfileSection />} />
  <Route path="profile" element={<ProfileSection />} />
  <Route path="billing" element={<BillingSection />} />
  <Route path="sync" element={<SyncSection />} />
</Route>
```

Wrap the provider at the top level:

```tsx
export default function App() {
  return (
    <HelmetProvider>
      <BrowserRouter>
        <AuthProvider>
          <AppContent />
        </AuthProvider>
      </BrowserRouter>
    </HelmetProvider>
  )
}
```

- [ ] **Step 2: Confirm SSR safety**

`entry-server.tsx` `ROUTE_MAP` must NOT include `/auth` or `/account/*` (they are client-only and auth-gated). The `AuthProvider` reads `localStorage` only inside `useEffect`, and `RequireAuth` renders `null` until `ready`, so server rendering of any accidental hit is inert.

- [ ] **Step 3: Verify build**

Run: `pnpm --filter @memry/landing typecheck && pnpm lint && pnpm --filter @memry/landing build`
Expected: PASS (prerender step does not attempt `/account`).

- [ ] **Step 4: Commit**

```bash
git add apps/landing/src/App.tsx
git commit -m "feat(landing): wire /auth + /account routes under AuthProvider"
```

---

## Task 16: Manual QA pass

No code. Run the app against a local sync-server (`pnpm dev:sync-server` + `pnpm dev:landing`) with `VITE_SYNC_SERVER_URL=http://localhost:8787`.

- [ ] Navbar **Account** → `/auth` when signed out; `/account` when signed in.
- [ ] OTP: request code → email arrives (or dev log) → verify → lands on `/account/profile`.
- [ ] Google: "Continue with Google" → consent → returns to `/account/profile`. (Requires the backend OAuth web-redirect change + Google client redirect URI registered.)
- [ ] Profile: change email (OTP) updates the shown email; contact support opens mail client; log out everywhere returns home and a re-visit to `/account` redirects to `/auth`.
- [ ] Billing: subscription summary renders; invoices list (empty is fine on a fresh account); "Manage payment method" opens the Paddle portal in a new tab.
- [ ] Sync: panel loads with a freshly-minted token and can open Paddle checkout.
- [ ] Delete account: confirmation code + typed DELETE wipes and returns home; the account can no longer sign in.
- [ ] Refresh-on-401: let the access token expire (or revoke it) and confirm a billing call transparently refreshes.

- [ ] **Commit** (if any fixes were needed during QA): group them logically with `fix(landing): …` messages.

---

## Self-Review (run before handing off)

- **Spec coverage:** sidebar IA — Profile (Task 12), Billing (Task 13), Sync (Task 14), bottom logout/home (Task 11). Sign-in OTP+Google (Tasks 9-10). Session/device model (Tasks 2-7). Nav + analytics (Task 8). Routing/SSR (Task 15). Env (Task 1).
- **Type consistency:** `Session`, `DeviceKeypair`/`StoredKeypair`, `InvoiceRow`, `createSyncApi`/`SyncApi`, `registerWebDevice` signatures are used identically across tasks.
- **Confirm before done:** `/auth/refresh` request/response shape (Task 5); `/auth/otp/verify` returns `setupToken` (Task 9 — verified at `auth.ts:243`); `GET /auth/billing` field names for email + plan (Tasks 12-13); device `platform: 'web'` accepted (depends on backend Task 1).
- **Deferred (not built):** password, 2FA, in-app discount — by design.
