# Landing Account — Backend (sync-server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the sync-server endpoints the landing account area needs — email change, log out everywhere, delete account, billing invoices — plus the contract + OAuth changes to let a browser authenticate as a device.

**Architecture:** New routes added to the existing `auth` Hono router (`apps/sync-server/src/routes/auth.ts`). They reuse the established service layer (otp, user, device, paddle-billing) and the `authMiddleware`/`setupAuthMiddleware` pattern. Account/billing endpoints require only an access token (no vault keys). Tests follow the in-memory D1-mock harness in `auth.test.ts`.

**Tech Stack:** Cloudflare Workers, Hono, D1 (SQLite), R2, Zod (via `@memry/contracts`), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-11-landing-account-area-design.md`

---

## File Structure

- Modify: `packages/contracts/src/auth-api.ts` — add `'web'` to device platform enum; add `EmailChangeRequestSchema`, `EmailChangeVerifySchema`, `DeleteAccountRequestSchema`.
- Modify: `apps/sync-server/src/routes/auth.ts` — add 5 handlers; extend OAuth redirect allowlist.
- Modify: `apps/sync-server/src/services/paddle-billing.ts` — add `listPaddleInvoices`, `getPaddleInvoicePdfUrl`.
- Modify: `apps/sync-server/src/services/user.ts` — add `updateUserEmail`.
- Create: `apps/sync-server/src/services/account-deletion.ts` — `deleteUserData` (D1 + R2 wipe).
- Modify: `apps/sync-server/src/routes/auth.test.ts` — tests for every new endpoint.

Run all sync-server tests with: `pnpm test:sync-server`

---

## Task 1: Extend contracts (device platform + new schemas)

**Files:**
- Modify: `packages/contracts/src/auth-api.ts`

- [ ] **Step 1: Add `'web'` to the device platform enum**

In `DeviceRegisterRequestSchema`, change the platform line to:

```typescript
  platform: z.enum(['macos', 'windows', 'linux', 'ios', 'android', 'web']),
```

- [ ] **Step 2: Add the new request schemas**

Append to `packages/contracts/src/auth-api.ts`:

```typescript
export const EmailChangeRequestSchema = z.object({
  newEmail: z.string().email()
})

export const EmailChangeVerifySchema = z.object({
  newEmail: z.string().email(),
  code: z.string().regex(/^\d{6}$/)
})

export const DeleteAccountRequestSchema = z.object({
  code: z.string().regex(/^\d{6}$/)
})

export type EmailChangeRequest = z.infer<typeof EmailChangeRequestSchema>
export type EmailChangeVerify = z.infer<typeof EmailChangeVerifySchema>
export type DeleteAccountRequest = z.infer<typeof DeleteAccountRequestSchema>
```

- [ ] **Step 3: Typecheck the package**

Run: `pnpm --filter @memry/contracts typecheck` (or `pnpm typecheck`)
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/contracts/src/auth-api.ts
git commit -m "feat(contracts): add web device platform + account schemas"
```

---

## Task 2: `updateUserEmail` service

**Files:**
- Modify: `apps/sync-server/src/services/user.ts`
- Test: `apps/sync-server/src/services/user.test.ts` (create if absent; otherwise add to existing)

- [ ] **Step 1: Add the function**

Append to `apps/sync-server/src/services/user.ts` (mirror the inline-query style already in the file):

```typescript
export async function updateUserEmail(
  db: D1Database,
  userId: string,
  newEmail: string
): Promise<void> {
  await db
    .prepare('UPDATE users SET email = ?, email_verified = 1, updated_at = ? WHERE id = ?')
    .bind(newEmail, Math.floor(Date.now() / 1000), userId)
    .run()
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @memry/sync-server typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/sync-server/src/services/user.ts
git commit -m "feat(sync-server): add updateUserEmail service"
```

---

## Task 3: `POST /auth/email/change` (request OTP to new address)

**Files:**
- Modify: `apps/sync-server/src/routes/auth.ts`
- Test: `apps/sync-server/src/routes/auth.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `auth.test.ts`. Note: `getUserByEmail` for the new address must return `null` (available). The env D1 mock returns `firstRows` in order: first call = lookup of new email (null → available), then the OTP store path runs.

```typescript
describe('POST /auth/email/change', () => {
  it('sends an OTP to the new address when it is free', async () => {
    const env = createEnv({ firstRows: [null] }) // new email not taken
    const res = await app.request(
      '/auth/email/change',
      jsonPostAuthed('/auth/email/change', { newEmail: 'new@example.com' }),
      env
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, expiresIn: 600 })
  })

  it('rejects an email already in use', async () => {
    const env = createEnv({ firstRows: [{ id: 'other-user', email: 'new@example.com' }] })
    const res = await app.request(
      '/auth/email/change',
      jsonPostAuthed('/auth/email/change', { newEmail: 'new@example.com' }),
      env
    )
    expect(res.status).toBe(409)
  })
})
```

If `jsonPostAuthed` does not exist yet, add this helper near `jsonPost` in the test file. It attaches a valid access token; reuse the same token-minting helper the existing authed tests use (search the file for how `authMiddleware`-protected endpoints like `/auth/billing` are tested and copy that token setup). If the file has no authed-endpoint helper, build the Request with `Authorization: Bearer <token>` where `<token>` is produced by the test's existing access-token factory.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:sync-server -- -t "email/change"`
Expected: FAIL (route not defined → 404)

- [ ] **Step 3: Implement the handler**

In `auth.ts`, add the imports if missing (top of file already imports otp helpers for the existing OTP routes — reuse them):

```typescript
import { generateOtp, storeOtp, verifyOtp } from '../services/otp'
import { sendEmail } from '../services/email'
import { buildOtpEmailHtml } from '../services/email-templates' // use the SAME import the /otp/request handler uses
import { getUserByEmail } from '../services/user'
import { updateUserEmail } from '../services/user'
import {
  EmailChangeRequestSchema,
  EmailChangeVerifySchema,
  DeleteAccountRequestSchema
} from '@memry/contracts/auth-api'
```

(Confirm the exact import paths for `sendEmail` / `buildOtpEmailHtml` by reading the top of `auth.ts` where `/otp/request`'s `handleOtpRequest` lives, and reuse those exact symbols.)

Add the handler (place near the other `/auth` routes):

```typescript
auth.post('/email/change', authMiddleware, async (c) => {
  const body = await c.req.json()
  const parsed = EmailChangeRequestSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid request body', 400)
  }

  const { newEmail } = parsed.data
  const existing = await getUserByEmail(c.env.DB, newEmail)
  if (existing) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Email already in use', 409)
  }

  const code = generateOtp()
  await storeOtp(c.env.DB, newEmail, code, c.env.OTP_HMAC_KEY)
  const html = buildOtpEmailHtml(code, 10)
  await sendEmail(newEmail, 'Confirm your new Memry email', html, c.env.RESEND_API_KEY)

  return c.json({ success: true, expiresIn: 600 })
})
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:sync-server -- -t "email/change"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/sync-server/src/routes/auth.ts apps/sync-server/src/routes/auth.test.ts
git commit -m "feat(sync-server): POST /auth/email/change requests OTP to new email"
```

---

## Task 4: `POST /auth/email/change/verify`

**Files:**
- Modify: `apps/sync-server/src/routes/auth.ts`
- Test: `apps/sync-server/src/routes/auth.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe('POST /auth/email/change/verify', () => {
  it('updates the email after a valid OTP', async () => {
    // verifyOtp reads the otp row; mock it to resolve. The D1 run() default
    // returns changes:1 so updateUserEmail succeeds.
    const env = createEnv({ firstRows: [/* otp row for verifyOtp */] })
    const res = await app.request(
      '/auth/email/change/verify',
      jsonPostAuthed('/auth/email/change/verify', {
        newEmail: 'new@example.com',
        code: '123456'
      }),
      env
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
  })
})
```

Mirror how the existing `/auth/otp/verify` test seeds the OTP row so `verifyOtp` passes (copy that fixture). If `verifyOtp` is hard to satisfy with the mock, follow the exact pattern the OTP-verify test already uses.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:sync-server -- -t "email/change/verify"`
Expected: FAIL (404)

- [ ] **Step 3: Implement**

```typescript
auth.post('/email/change/verify', authMiddleware, async (c) => {
  const body = await c.req.json()
  const parsed = EmailChangeVerifySchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid request body', 400)
  }

  const { newEmail, code } = parsed.data

  // Re-check availability to close the gap between request and verify.
  const existing = await getUserByEmail(c.env.DB, newEmail)
  if (existing) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Email already in use', 409)
  }

  await verifyOtp(c.env.DB, newEmail, code, c.env.OTP_HMAC_KEY)

  const userId = c.get('userId')!
  await updateUserEmail(c.env.DB, userId, newEmail)

  return c.json({ success: true })
})
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:sync-server -- -t "email/change/verify"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/sync-server/src/routes/auth.ts apps/sync-server/src/routes/auth.test.ts
git commit -m "feat(sync-server): POST /auth/email/change/verify updates email"
```

---

## Task 5: `POST /auth/logout-all` (revoke all devices + tokens)

**Files:**
- Modify: `apps/sync-server/src/routes/auth.ts`
- Test: `apps/sync-server/src/routes/auth.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe('POST /auth/logout-all', () => {
  it('revokes every device and refresh token for the user', async () => {
    const env = createEnv()
    const res = await app.request(
      '/auth/logout-all',
      jsonPostAuthed('/auth/logout-all', {}),
      env
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:sync-server -- -t "logout-all"`
Expected: FAIL (404)

- [ ] **Step 3: Implement**

```typescript
auth.post('/logout-all', authMiddleware, async (c) => {
  const userId = c.get('userId')!
  const now = Math.floor(Date.now() / 1000)

  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE devices SET revoked_at = ?, updated_at = ? WHERE user_id = ? AND revoked_at IS NULL'
    ).bind(now, now, userId),
    c.env.DB.prepare(
      'UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ? AND revoked = 0'
    ).bind(userId)
  ])

  return c.json({ success: true })
})
```

(Note: revoking devices does not eagerly close live WebSockets here; the existing `/revoke-device` Durable Object path handles instant socket close for single-device revoke. For the web account use-case, lazy revocation on next token use is acceptable. If instant socket close across all devices is required later, loop device ids through the `USER_SYNC_STATE` DO `/revoke-device` route — out of scope for this plan.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:sync-server -- -t "logout-all"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/sync-server/src/routes/auth.ts apps/sync-server/src/routes/auth.test.ts
git commit -m "feat(sync-server): POST /auth/logout-all revokes all devices + tokens"
```

---

## Task 6: `deleteUserData` service (D1 + R2 wipe)

**Files:**
- Create: `apps/sync-server/src/services/account-deletion.ts`
- Test: `apps/sync-server/src/services/account-deletion.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { deleteUserData } from './account-deletion'

const makeDb = () => {
  const stmt = {
    bind: vi.fn(),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
    first: vi.fn().mockResolvedValue({ email: 'a@b.com' })
  }
  stmt.bind.mockReturnValue(stmt)
  return {
    prepare: vi.fn().mockReturnValue(stmt),
    batch: vi.fn().mockResolvedValue([])
  } as unknown as D1Database
}

const makeBucket = () => {
  const objects = [{ key: 'user-1/vaults/default/items/x' }]
  return {
    list: vi.fn().mockResolvedValue({ objects, truncated: false, cursor: undefined }),
    delete: vi.fn().mockResolvedValue(undefined)
  } as unknown as R2Bucket
}

describe('deleteUserData', () => {
  it('lists and deletes R2 objects under the user prefix, then clears D1 rows', async () => {
    const db = makeDb()
    const bucket = makeBucket()
    await deleteUserData(db, bucket, 'user-1', 'a@b.com')
    expect(bucket.list).toHaveBeenCalledWith({ prefix: 'user-1/' })
    expect(bucket.delete).toHaveBeenCalledWith(['user-1/vaults/default/items/x'])
    expect(db.batch).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:sync-server -- account-deletion`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement**

```typescript
// apps/sync-server/src/services/account-deletion.ts

/**
 * Irreversibly delete all data for a user across R2 (encrypted payloads) and
 * D1 (sync + auth rows). Child rows are deleted before the parent `users` row
 * to avoid foreign-key violations in a single batch.
 */
export async function deleteUserData(
  db: D1Database,
  bucket: R2Bucket,
  userId: string,
  email: string
): Promise<void> {
  // 1. Wipe R2 objects under the user prefix (paginated).
  let cursor: string | undefined
  do {
    const listing = await bucket.list({ prefix: `${userId}/`, cursor })
    const keys = listing.objects.map((o) => o.key)
    if (keys.length > 0) {
      await bucket.delete(keys)
    }
    cursor = listing.truncated ? listing.cursor : undefined
  } while (cursor)

  // 2. Wipe D1 rows — children first, `users` last.
  const now = Math.floor(Date.now() / 1000)
  void now
  await db.batch([
    db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM consumed_setup_tokens WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM sync_items WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM crdt_snapshots WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM blob_chunks WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM sync_vaults WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM server_cursor_sequence WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM sync_entitlements WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM devices WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM otp_codes WHERE email = ?').bind(email),
    db.prepare('DELETE FROM users WHERE id = ?').bind(userId)
  ])
}
```

Before running, open `apps/sync-server/schema/d1.sql` and confirm every table name above exists and is keyed by `user_id` (or `email` for `otp_codes`). Add any per-user table the schema has that is missing here (e.g. an `identities` table if present); remove any that does not exist. Do not guess — match the schema file.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:sync-server -- account-deletion`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/sync-server/src/services/account-deletion.ts apps/sync-server/src/services/account-deletion.test.ts
git commit -m "feat(sync-server): add deleteUserData (R2 + D1 wipe)"
```

---

## Task 7: `DELETE /auth/account` (OTP-gated)

**Files:**
- Modify: `apps/sync-server/src/routes/auth.ts`
- Test: `apps/sync-server/src/routes/auth.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe('DELETE /auth/account', () => {
  it('deletes the account after a valid OTP', async () => {
    const env = createEnv({ firstRows: [{ id: 'user-1', email: 'a@b.com' }] })
    // Make STORAGE a working R2 mock on env:
    ;(env as any).STORAGE = {
      list: () => Promise.resolve({ objects: [], truncated: false }),
      delete: () => Promise.resolve()
    }
    const res = await app.request(
      '/auth/account',
      { ...jsonPostAuthed('/auth/account', { code: '123456' }), method: 'DELETE' },
      env
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:sync-server -- -t "DELETE /auth/account"`
Expected: FAIL (404)

- [ ] **Step 3: Implement**

```typescript
import { deleteUserData } from '../services/account-deletion'
import { getUserById } from '../services/user'

auth.delete('/account', authMiddleware, async (c) => {
  const body = await c.req.json()
  const parsed = DeleteAccountRequestSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid request body', 400)
  }

  const userId = c.get('userId')!
  const user = await getUserById(c.env.DB, userId)
  if (!user) {
    throw new AppError(ErrorCodes.NOT_FOUND, 'User not found', 404)
  }

  // Fresh OTP confirmation against the account's current email.
  await verifyOtp(c.env.DB, user.email, parsed.data.code, c.env.OTP_HMAC_KEY)

  await deleteUserData(c.env.DB, c.env.STORAGE, userId, user.email)

  return c.json({ success: true })
})
```

Add a companion request flow: the client calls the existing `POST /auth/otp/request` (or a dedicated step) to send the confirmation code to the current email before calling DELETE. No new endpoint needed — reuse `/auth/otp/request` with the account email.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:sync-server -- -t "DELETE /auth/account"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/sync-server/src/routes/auth.ts apps/sync-server/src/routes/auth.test.ts
git commit -m "feat(sync-server): DELETE /auth/account wipes user data after OTP"
```

---

## Task 8: Paddle invoices service

**Files:**
- Modify: `apps/sync-server/src/services/paddle-billing.ts`
- Test: `apps/sync-server/src/services/paddle-billing.test.ts` (add cases)

- [ ] **Step 1: Write the failing test**

```typescript
describe('listPaddleInvoices', () => {
  it('maps Paddle transactions to invoice rows', async () => {
    const env = {
      DB: dbWithEntitlement({ paddle_customer_id: 'ctm_1' }),
      PADDLE_API_KEY: 'pdl_sandbox_key',
      PADDLE_ENVIRONMENT: 'sandbox',
      fetch: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'txn_1',
                status: 'completed',
                billed_at: '2026-06-01T00:00:00Z',
                currency_code: 'USD',
                details: { totals: { grand_total: '4900' } }
              }
            ]
          }),
          { status: 200 }
        )
      )
    } as unknown as Bindings
    const rows = await listPaddleInvoices(env, 'user-1')
    expect(rows).toEqual([
      {
        id: 'txn_1',
        status: 'completed',
        billedAt: '2026-06-01T00:00:00Z',
        amount: '4900',
        currency: 'USD'
      }
    ])
  })
})
```

Reuse whatever helper the existing paddle-billing tests use to build a DB with an entitlement row (search the test file). If none, build a minimal D1 mock whose `first()` returns `{ paddle_customer_id: 'ctm_1', paddle_subscription_id: null }`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:sync-server -- listPaddleInvoices`
Expected: FAIL (function not exported)

- [ ] **Step 3: Implement**

Add to `paddle-billing.ts` (reuse the file's existing `normalizePaddleApiKey`, `getPaddleBaseUrl`, `PaddleResponse`, `AppError`, `ErrorCodes`):

```typescript
export interface InvoiceRow {
  id: string
  status: string
  billedAt: string | null
  amount: string
  currency: string
}

interface PaddleTransactionListItem {
  id: string
  status: string
  billed_at: string | null
  currency_code: string
  details?: { totals?: { grand_total?: string } }
}

export async function listPaddleInvoices(env: Bindings, userId: string): Promise<InvoiceRow[]> {
  const entitlement = await env.DB.prepare(
    'SELECT paddle_customer_id FROM sync_entitlements WHERE user_id = ?'
  )
    .bind(userId)
    .first<{ paddle_customer_id: string | null }>()

  if (!entitlement?.paddle_customer_id) {
    return []
  }

  const apiKey = normalizePaddleApiKey(env.PADDLE_API_KEY)
  if (!apiKey) {
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Paddle API key is not configured', 503)
  }

  const url =
    `${getPaddleBaseUrl(env)}/transactions` +
    `?customer_id=${encodeURIComponent(entitlement.paddle_customer_id)}` +
    `&per_page=30&order_by=billed_at[DESC]`

  const response = await (env.fetch ?? fetch)(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
  })
  if (!response.ok) {
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Could not list Paddle invoices', 502)
  }

  const payload = (await response.json()) as PaddleResponse<PaddleTransactionListItem[]>
  const items = payload.data ?? []
  return items.map((t) => ({
    id: t.id,
    status: t.status,
    billedAt: t.billed_at,
    amount: t.details?.totals?.grand_total ?? '0',
    currency: t.currency_code
  }))
}

export async function getPaddleInvoicePdfUrl(env: Bindings, transactionId: string): Promise<string> {
  const apiKey = normalizePaddleApiKey(env.PADDLE_API_KEY)
  if (!apiKey) {
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Paddle API key is not configured', 503)
  }
  const response = await (env.fetch ?? fetch)(
    `${getPaddleBaseUrl(env)}/transactions/${encodeURIComponent(transactionId)}/invoice`,
    { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } }
  )
  if (!response.ok) {
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Could not fetch invoice PDF', 502)
  }
  const payload = (await response.json()) as PaddleResponse<{ url?: string }>
  const url = payload.data?.url
  if (!url) {
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Invoice PDF URL missing', 502)
  }
  return url
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:sync-server -- listPaddleInvoices`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/sync-server/src/services/paddle-billing.ts apps/sync-server/src/services/paddle-billing.test.ts
git commit -m "feat(sync-server): list Paddle invoices + invoice PDF URL"
```

---

## Task 9: Billing invoice endpoints

**Files:**
- Modify: `apps/sync-server/src/routes/auth.ts`
- Test: `apps/sync-server/src/routes/auth.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe('GET /auth/billing/invoices', () => {
  it('returns invoice rows for the user', async () => {
    const env = createEnv({
      firstRows: [{ paddle_customer_id: 'ctm_1' }],
      paddleFetch: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), { status: 200 })
      )
    })
    const res = await app.request('/auth/billing/invoices', getAuthed('/auth/billing/invoices'), env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ invoices: [] })
  })
})
```

Add a `getAuthed(path)` helper (GET with `Authorization: Bearer <token>`) alongside `jsonPostAuthed` if not present.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:sync-server -- -t "billing/invoices"`
Expected: FAIL (404)

- [ ] **Step 3: Implement**

```typescript
import { listPaddleInvoices, getPaddleInvoicePdfUrl } from '../services/paddle-billing'

auth.get('/billing/invoices', authMiddleware, async (c) => {
  const userId = c.get('userId')!
  const invoices = await listPaddleInvoices(c.env, userId)
  return c.json({ invoices })
})

auth.get('/billing/invoices/:id/pdf', authMiddleware, async (c) => {
  const url = await getPaddleInvoicePdfUrl(c.env, c.req.param('id'))
  return c.json({ url })
})
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:sync-server -- -t "billing/invoices"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/sync-server/src/routes/auth.ts apps/sync-server/src/routes/auth.test.ts
git commit -m "feat(sync-server): GET /auth/billing/invoices + invoice PDF"
```

---

## Task 10: Allow the landing origin as an OAuth redirect URI

**Files:**
- Modify: `apps/sync-server/src/routes/auth.ts:258-267`
- Test: `apps/sync-server/src/routes/auth.test.ts`

Today the `redirect_uri` query is restricted to `127.0.0.1` loopback (for desktop). Web OAuth needs the landing https origin allowed.

- [ ] **Step 1: Write the failing test**

```typescript
describe('GET /auth/oauth/google web redirect', () => {
  it('accepts the configured web origin as redirect_uri', async () => {
    const env = createEnv()
    ;(env as any).WEB_OAUTH_REDIRECT_URI = 'https://memrynote.com/auth/oauth/callback'
    const res = await app.request(
      '/auth/oauth/google?redirect_uri=' +
        encodeURIComponent('https://memrynote.com/auth/oauth/callback'),
      { method: 'GET' },
      env
    )
    expect(res.status).toBe(302)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:sync-server -- -t "web redirect"`
Expected: FAIL (400 — redirect_uri rejected)

- [ ] **Step 3: Implement**

Replace the loopback-only validation with a check that also allows an explicit, configured web redirect URI. Change the block at `auth.ts:261`:

```typescript
  const clientRedirectUri = c.req.query('redirect_uri')
  const redirectUri = clientRedirectUri ?? c.env.GOOGLE_REDIRECT_URI

  const isLoopback =
    clientRedirectUri != null &&
    /^http:\/\/127\.0\.0\.1(:\d+)?(\/.*)?$/.test(clientRedirectUri)
  const isConfiguredWeb =
    clientRedirectUri != null && clientRedirectUri === c.env.WEB_OAUTH_REDIRECT_URI

  if (clientRedirectUri && !isLoopback && !isConfiguredWeb) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      'redirect_uri must be a 127.0.0.1 loopback address or the configured web origin',
      400
    )
  }
```

Add `WEB_OAUTH_REDIRECT_URI?: string` to the `Bindings` type (`apps/sync-server/src/types.ts`) and to `apps/sync-server/wrangler.toml` `[vars]` for staging/production (value = landing origin + `/auth/oauth/callback`). The same `WEB_OAUTH_REDIRECT_URI` must also be registered in the Google Cloud OAuth client's Authorized redirect URIs.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:sync-server -- -t "web redirect"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/sync-server/src/routes/auth.ts apps/sync-server/src/types.ts apps/sync-server/wrangler.toml
git commit -m "feat(sync-server): allow configured web origin as OAuth redirect_uri"
```

---

## Task 11: CORS for the landing origin + full suite

**Files:**
- Modify: `apps/sync-server/wrangler.toml` (set `ALLOWED_ORIGIN` for staging + production to the landing origin)

- [ ] **Step 1: Set `ALLOWED_ORIGIN`**

In `wrangler.toml`, under the staging and production `[env.*.vars]`, set `ALLOWED_ORIGIN` to the landing site origin (e.g. `https://memrynote.com`). Dev already allows `http://localhost:5173` via `ORIGIN_BY_ENV` (`index.ts:36`). This is read at `index.ts:112`.

- [ ] **Step 2: Run the full sync-server suite**

Run: `pnpm test:sync-server`
Expected: PASS (all new + existing). If `better-sqlite3` ABI errors appear, run `pnpm --filter @memry/desktop rebuild:node` is NOT relevant here — sync-server tests use mocks; investigate any real failures.

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm --filter @memry/sync-server typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/sync-server/wrangler.toml
git commit -m "chore(sync-server): allow landing origin via ALLOWED_ORIGIN (CORS)"
```

---

## Self-Review (run before handing off)

- **Spec coverage:** email change (Tasks 3-4), logout-all (Task 5), delete account (Tasks 6-7), invoices (Tasks 8-9), OAuth web redirect (Task 10), CORS (Task 11), `web` device platform (Task 1). All spec backend items covered.
- **Deferred (correctly not here):** password, 2FA, discount UI.
- **Verify before done:** open `apps/sync-server/schema/d1.sql` and reconcile Task 6's table list against the real schema; confirm the exact `sendEmail` / `buildOtpEmailHtml` import symbols from the existing `/otp/request` handler; confirm the test token helper used by existing `authMiddleware` tests.
