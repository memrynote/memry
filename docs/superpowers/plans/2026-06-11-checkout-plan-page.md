# Checkout / Plan-Selection Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the desktop "Upgrade" button's hardcoded Pro/annual checkout with a flow that lands the user on a dedicated `/checkout` web page where they pick plan + cadence, see an order summary, and proceed to Paddle.

**Architecture:** The signed checkout token becomes an **identity token** (`{userId, exp}` only). Plan/cadence are chosen on the new landing `/checkout` page and sent in the Paddle-checkout request body; the server resolves the price and binds the purchase to the token's userId. Post-payment reconciliation (deep link → sync runtime) is unchanged.

**Tech Stack:** Cloudflare Workers + Hono (sync-server), Vercel serverless + Paddle SDK (landing api), React 19 + Vite + react-router (landing web), Electron main/preload/renderer (desktop). Tests: `node:test` (landing), Vitest (sync-server, desktop).

**Spec:** `docs/superpowers/specs/2026-06-11-checkout-plan-page-design.md`

**Task order rationale:** Task 1 (landing-api) is backward compatible — it reads plan/cadence from the request body while still verifying the token for identity, so old plan-bound tokens keep working. That lets Task 2 (identity token) and Task 4 (desktop) land without a broken intermediate state. Task 3 builds the page the desktop will point at. Task 5 cleans up the now-dead path.

---

## File Map

| File                                                               | Responsibility                                                 | Action |
| ------------------------------------------------------------------ | -------------------------------------------------------------- | ------ |
| `apps/landing/api/paddle-checkout-config.ts`                       | Parse intent: identity from token, plan/cadence from body      | Modify |
| `apps/landing/api/paddle-checkout-config.test.ts`                  | Contract tests for the parser                                  | Modify |
| `apps/sync-server/src/services/checkout-token.ts`                  | Sign identity token `{userId, exp}`                            | Modify |
| `apps/sync-server/src/routes/auth.ts`                              | `/checkout-token` mints identity token, no body                | Modify |
| `apps/sync-server/src/routes/auth.test.ts`                         | Route tests                                                    | Modify |
| `apps/landing/src/lib/checkout-summary.ts`                         | Pure plan/cadence/summary helpers                              | Create |
| `apps/landing/src/lib/checkout-summary.test.ts`                    | Unit tests for helpers                                         | Create |
| `apps/landing/src/pages/Checkout.tsx`                              | Two-column `/checkout` page                                    | Create |
| `apps/landing/src/App.tsx`                                         | Register `/checkout` route                                     | Modify |
| `apps/desktop/src/main/billing/paddle-billing.ts`                  | `startBillingCheckout()` no-arg → identity token → `/checkout` | Modify |
| `apps/desktop/src/preload/api/sync-identity.ts`                    | `startCheckout()` no-arg                                       | Modify |
| `apps/desktop/src/preload/index.d.ts`                              | `AccountClientAPI.startCheckout` no-arg                        | Modify |
| `apps/desktop/src/main/ipc/account-handlers.ts`                    | Call `startBillingCheckout()`                                  | Modify |
| `apps/desktop/src/renderer/src/pages/settings/account-section.tsx` | Call `startCheckout()` no-arg                                  | Modify |
| `apps/desktop/src/preload/api/preload-api.test.ts`                 | Update no-arg call                                             | Modify |
| `apps/desktop/src/main/index.ts`                                   | Deep link `memry://billing/start` → `startBillingCheckout()`   | Modify |
| `apps/landing/src/pages/Pricing.tsx`                               | Remove dead token auto-fire branch                             | Modify |

---

## Task 1: landing-api — source plan/cadence from request body, identity from token

**Files:**

- Modify: `apps/landing/api/paddle-checkout-config.ts:131-170`
- Test: `apps/landing/api/paddle-checkout-config.test.ts`

Today `parsePaddleCheckoutIntent` reads `plan`, `cadence`, AND `userId` from the signed token. The new contract reads **only `userId` + `exp` from the token** and takes **`plan` + `cadence` from the request body**. `signPaddleCheckoutToken` (used by tests to fabricate tokens) becomes an identity signer.

- [ ] **Step 1: Update the test file to the new contract**

Replace the whole `describe('paddle checkout config', ...)` body's relevant cases. Final test file:

```typescript
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import {
  getPaddleCheckoutConfig,
  normalizePaddleApiKey,
  parsePaddleCheckoutIntent,
  signPaddleCheckoutToken
} from './paddle-checkout-config.ts'

const env = {
  PADDLE_PRICE_PLUS_MONTHLY: 'pri_plus_monthly',
  PADDLE_PRICE_PLUS_ANNUAL: 'pri_plus_annual',
  PADDLE_PRICE_PRO_MONTHLY: 'pri_pro_monthly',
  PADDLE_PRICE_PRO_ANNUAL: 'pri_pro_annual',
  PADDLE_PRICE_BELIEVER_LIFETIME: 'pri_believer_lifetime',
  PADDLE_CHECKOUT_TOKEN_SECRET: 'checkout-secret'
}

describe('paddle checkout config', () => {
  it('normalizes common Paddle API key paste formats', () => {
    assert.equal(normalizePaddleApiKey('  "pdl_live_apikey_example"  '), 'pdl_live_apikey_example')
    assert.equal(normalizePaddleApiKey('Bearer pdl_live_apikey_example'), 'pdl_live_apikey_example')
    assert.equal(
      normalizePaddleApiKey('Authorization: Bearer pdl_live_apikey_example'),
      'pdl_live_apikey_example'
    )
    assert.equal(normalizePaddleApiKey(''), undefined)
  })

  it('uses an emitted JavaScript helper import for Vercel functions', () => {
    const source = readFileSync(new URL('./paddle-checkout.ts', import.meta.url), 'utf8')

    assert.doesNotMatch(source, /from ['"]\.\/paddle-checkout-config\.ts['"]/)
    assert.match(source, /from ['"]\.\/paddle-checkout-config\.js['"]/)
  })

  it('takes userId from the identity token and plan/cadence from the request body', async () => {
    const checkoutToken = await signPaddleCheckoutToken(
      { userId: 'user-1', exp: 1_800_000_000 },
      env.PADDLE_CHECKOUT_TOKEN_SECRET
    )
    const intent = await parsePaddleCheckoutIntent(
      { checkoutToken, plan: 'pro', cadence: 'annual', userId: 'attacker' },
      env,
      1_700_000_000
    )

    assert.deepEqual(intent, { plan: 'pro', cadence: 'annual', userId: 'user-1' })
    assert.deepEqual(getPaddleCheckoutConfig(intent, env), {
      priceId: 'pri_pro_annual',
      customData: {
        app: 'memry',
        entitlement: 'sync',
        plan: 'pro',
        cadence: 'annual',
        userId: 'user-1'
      }
    })
  })

  it('ignores plan/cadence baked into a legacy token and uses the body instead', async () => {
    // Legacy tokens still carry plan/cadence; the parser must NOT trust them.
    const legacyToken = await signPaddleCheckoutToken(
      { userId: 'user-1', exp: 1_800_000_000, plan: 'plus', cadence: 'monthly' } as never,
      env.PADDLE_CHECKOUT_TOKEN_SECRET
    )
    const intent = await parsePaddleCheckoutIntent(
      { checkoutToken: legacyToken, plan: 'pro', cadence: 'annual' },
      env,
      1_700_000_000
    )

    assert.deepEqual(intent, { plan: 'pro', cadence: 'annual', userId: 'user-1' })
  })

  it('always maps Believer to the lifetime price', async () => {
    const checkoutToken = await signPaddleCheckoutToken(
      { userId: 'user-1', exp: 1_800_000_000 },
      env.PADDLE_CHECKOUT_TOKEN_SECRET
    )
    const intent = await parsePaddleCheckoutIntent(
      { checkoutToken, plan: 'believer', cadence: 'monthly' },
      env,
      1_700_000_000
    )

    assert.deepEqual(intent, { plan: 'believer', cadence: 'lifetime', userId: 'user-1' })
    assert.equal(getPaddleCheckoutConfig(intent, env).priceId, 'pri_believer_lifetime')
  })

  it('rejects unsupported or missing checkout fields', async () => {
    const checkoutToken = await signPaddleCheckoutToken(
      { userId: 'user-1', exp: 1_800_000_000 },
      env.PADDLE_CHECKOUT_TOKEN_SECRET
    )
    // unknown plan
    assert.equal(
      await parsePaddleCheckoutIntent(
        { checkoutToken, plan: 'enterprise', cadence: 'monthly' },
        env,
        1_700_000_000
      ),
      null
    )
    // recurring plan cannot be lifetime
    assert.equal(
      await parsePaddleCheckoutIntent(
        { checkoutToken, plan: 'plus', cadence: 'lifetime' },
        env,
        1_700_000_000
      ),
      null
    )
    // missing token
    assert.equal(await parsePaddleCheckoutIntent({ plan: 'plus', cadence: 'monthly' }, env), null)
    // missing plan/cadence in body
    assert.equal(await parsePaddleCheckoutIntent({ checkoutToken }, env, 1_700_000_000), null)
  })

  it('rejects tampered or expired identity tokens', async () => {
    const checkoutToken = await signPaddleCheckoutToken(
      { userId: 'user-1', exp: 1_700_000_010 },
      env.PADDLE_CHECKOUT_TOKEN_SECRET
    )

    assert.equal(
      await parsePaddleCheckoutIntent(
        { checkoutToken, plan: 'plus', cadence: 'monthly' },
        env,
        1_700_000_010
      ),
      null
    )
    assert.equal(
      await parsePaddleCheckoutIntent(
        { checkoutToken: `${checkoutToken}tampered`, plan: 'plus', cadence: 'monthly' },
        env
      ),
      null
    )
  })

  it('names the missing price variable for server configuration errors', async () => {
    const checkoutToken = await signPaddleCheckoutToken(
      { userId: 'user-1', exp: 1_800_000_000 },
      env.PADDLE_CHECKOUT_TOKEN_SECRET
    )
    const intent = await parsePaddleCheckoutIntent(
      { checkoutToken, plan: 'plus', cadence: 'monthly' },
      env,
      1_700_000_000
    )

    assert.throws(() => getPaddleCheckoutConfig(intent, {}), /PADDLE_PRICE_PLUS_MONTHLY/)
  })
})
```

- [ ] **Step 2: Run the tests, verify the new cases fail**

Run: `node --import tsx --test apps/landing/api/paddle-checkout-config.test.ts`
Expected: FAIL — e.g. "takes userId from the identity token and plan/cadence from the request body" and "always maps Believer..." fail, because the current parser reads plan/cadence from the token (which the identity token no longer has).

- [ ] **Step 3: Update `signPaddleCheckoutToken` to an identity signer**

In `apps/landing/api/paddle-checkout-config.ts`, change the signer signature (around line 163):

```typescript
export async function signPaddleCheckoutToken(
  payload: { userId: string; exp: number },
  secret: string
): Promise<string> {
  const encodedPayload = base64UrlEncode(encoder.encode(JSON.stringify(payload)))
  const signature = await hmacSha256(secret, encodedPayload)
  return `${encodedPayload}.${base64UrlEncode(signature)}`
}
```

- [ ] **Step 4: Rewrite `parsePaddleCheckoutIntent` to merge token identity with body plan/cadence**

Replace the function (lines 131-161):

```typescript
export async function parsePaddleCheckoutIntent(
  input: unknown,
  env: PaddleEnv,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<PaddleCheckoutIntent | null> {
  if (!input || typeof input !== 'object') return null

  const { checkoutToken, plan, cadence } = input as {
    checkoutToken?: unknown
    plan?: unknown
    cadence?: unknown
  }
  if (typeof checkoutToken !== 'string' || checkoutToken.trim().length === 0) return null

  const tokenPayload = await verifyCheckoutToken(
    checkoutToken.trim(),
    env.PADDLE_CHECKOUT_TOKEN_SECRET
  )
  if (!tokenPayload) return null

  const { userId, exp } = tokenPayload
  if (typeof userId !== 'string' || userId.trim().length === 0) return null
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= nowSeconds) return null

  if (!isPlan(plan) || !isCadence(cadence)) return null

  if (plan === 'believer') {
    return { plan, cadence: 'lifetime', userId: userId.trim() }
  }

  if (cadence === 'lifetime') return null

  return { plan, cadence, userId: userId.trim() }
}
```

(The `CheckoutTokenPayload` type at lines 10-15 already declares `plan?/cadence?/userId?/exp?` as `unknown`; leave it unchanged — the parser simply stops reading `plan`/`cadence` from it.)

- [ ] **Step 5: Run the tests, verify they pass**

Run: `node --import tsx --test apps/landing/api/paddle-checkout-config.test.ts`
Expected: PASS — `tests 8 pass 8 fail 0`.

- [ ] **Step 6: Commit**

```bash
git add apps/landing/api/paddle-checkout-config.ts apps/landing/api/paddle-checkout-config.test.ts
git commit -m "feat(landing): take checkout plan/cadence from body, identity from token"
```

---

## Task 2: sync-server — mint an identity-only checkout token

**Files:**

- Modify: `apps/sync-server/src/services/checkout-token.ts`
- Modify: `apps/sync-server/src/routes/auth.ts:497-500,599-622` and import at line 38
- Test: `apps/sync-server/src/routes/auth.test.ts:1317-1347`

- [ ] **Step 1: Update the route tests to the identity-token contract**

Replace the `describe('POST /auth/checkout-token', ...)` block (lines 1317-1347):

```typescript
describe('POST /auth/checkout-token', () => {
  it('mints an account-bound identity token for the authenticated sync account', async () => {
    const res = await app.request('/auth/checkout-token', jsonPost('/auth/checkout-token', {}), env)

    expect(res.status).toBe(200)
    const json = (await res.json()) as { checkoutToken: string; expiresAt: number }
    const payload = readCheckoutTokenPayload(json.checkoutToken)

    expect(payload).toEqual({
      userId: 'user-1',
      exp: json.expiresAt
    })
    expect(json.checkoutToken.split('.')).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm --filter @memry/sync-server test -- auth.test.ts -t "checkout-token"`
Expected: FAIL — payload still contains `plan` and `cadence`, so `toEqual({ userId, exp })` mismatches.

- [ ] **Step 3: Change the token payload to identity-only**

Replace `apps/sync-server/src/services/checkout-token.ts` lines 1-10:

```typescript
interface CheckoutTokenPayload {
  userId: string
  exp: number
}

const encoder = new TextEncoder()
```

(Delete the `import type { SyncPlan } from './entitlements'` line and the `export type CheckoutCadence` line — verify they have no other importers in `src/` first with `grep -rn "CheckoutCadence" apps/sync-server/src`. If another non-test file imports `CheckoutCadence`, keep the type export and only remove the payload fields.)

- [ ] **Step 4: Simplify the `/checkout-token` route to mint an identity token**

In `apps/sync-server/src/routes/auth.ts`:

Change the import (line 38) — drop `CheckoutCadence` if now unused:

```typescript
import { signCheckoutToken } from '../services/checkout-token'
```

Delete `CheckoutTokenSchema` (lines 497-500).

Replace the route (lines 599-622):

```typescript
auth.post('/checkout-token', authMiddleware, async (c) => {
  const userId = c.get('userId')!
  const expiresAt = Math.floor(Date.now() / 1000) + CHECKOUT_TOKEN_TTL_SECONDS
  const checkoutToken = await signCheckoutToken(c.env.PADDLE_CHECKOUT_TOKEN_SECRET, {
    userId,
    exp: expiresAt
  })

  return c.json({ checkoutToken, expiresAt })
})
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `pnpm --filter @memry/sync-server test -- auth.test.ts -t "checkout-token"`
Expected: PASS.

- [ ] **Step 6: Run sync-server typecheck to catch orphaned imports**

Run: `pnpm --filter @memry/sync-server typecheck`
Expected: PASS (no unused `CheckoutCadence` / `signCheckoutToken` errors).

- [ ] **Step 7: Commit**

```bash
git add apps/sync-server/src/services/checkout-token.ts apps/sync-server/src/routes/auth.ts apps/sync-server/src/routes/auth.test.ts
git commit -m "feat(sync-server): mint identity-only checkout token"
```

---

## Task 3: landing-web — the `/checkout` page

**Files:**

- Create: `apps/landing/src/lib/checkout-summary.ts`
- Create: `apps/landing/src/lib/checkout-summary.test.ts`
- Create: `apps/landing/src/pages/Checkout.tsx`
- Modify: `apps/landing/src/App.tsx:18,131`

- [ ] **Step 1: Write the failing test for the pure summary helpers**

Create `apps/landing/src/lib/checkout-summary.test.ts`:

```typescript
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  getCheckoutSummary,
  getSelectableCadences,
  normalizeCadenceForPlan,
  parseCheckoutToken
} from './checkout-summary.ts'

describe('checkout summary', () => {
  it('lists selectable cadences per plan', () => {
    assert.deepEqual(getSelectableCadences('plus'), ['monthly', 'annual'])
    assert.deepEqual(getSelectableCadences('pro'), ['monthly', 'annual'])
    assert.deepEqual(getSelectableCadences('believer'), ['lifetime'])
  })

  it('forces believer to lifetime and recurring plans away from lifetime', () => {
    assert.equal(normalizeCadenceForPlan('believer', 'monthly'), 'lifetime')
    assert.equal(normalizeCadenceForPlan('plus', 'lifetime'), 'annual')
    assert.equal(normalizeCadenceForPlan('pro', 'monthly'), 'monthly')
  })

  it('builds a summary for a recurring annual plan', () => {
    assert.deepEqual(getCheckoutSummary('pro', 'annual'), {
      planName: 'Pro',
      amount: 96,
      currency: 'USD',
      billingFrequencyLabel: 'Yearly',
      lineItemLabel: 'Pro yearly subscription'
    })
  })

  it('builds a summary for a monthly plan', () => {
    assert.deepEqual(getCheckoutSummary('plus', 'monthly'), {
      planName: 'Plus',
      amount: 5,
      currency: 'USD',
      billingFrequencyLabel: 'Monthly',
      lineItemLabel: 'Plus monthly subscription'
    })
  })

  it('builds a lifetime summary for believer regardless of requested cadence', () => {
    assert.deepEqual(getCheckoutSummary('believer', 'monthly'), {
      planName: 'Believer',
      amount: 500,
      currency: 'USD',
      billingFrequencyLabel: 'One-time',
      lineItemLabel: 'Believer lifetime'
    })
  })

  it('parses the identity token from the URL hash', () => {
    assert.equal(parseCheckoutToken('#token=abc.def'), 'abc.def')
    assert.equal(parseCheckoutToken('#'), null)
    assert.equal(parseCheckoutToken('#token='), null)
    assert.equal(parseCheckoutToken(''), null)
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `node --import tsx --test apps/landing/src/lib/checkout-summary.test.ts`
Expected: FAIL — module `./checkout-summary.ts` does not exist.

- [ ] **Step 3: Implement the helpers**

Create `apps/landing/src/lib/checkout-summary.ts`:

```typescript
import { SYNC_PLAN_TIERS, type CheckoutPlanId } from './constants'
import type { PaddleCheckoutCadence } from './paddle-checkout'

export function getSelectableCadences(plan: CheckoutPlanId): PaddleCheckoutCadence[] {
  return plan === 'believer' ? ['lifetime'] : ['monthly', 'annual']
}

export function normalizeCadenceForPlan(
  plan: CheckoutPlanId,
  cadence: PaddleCheckoutCadence
): PaddleCheckoutCadence {
  if (plan === 'believer') return 'lifetime'
  return cadence === 'lifetime' ? 'annual' : cadence
}

export interface CheckoutSummary {
  planName: string
  amount: number
  currency: 'USD'
  billingFrequencyLabel: 'Monthly' | 'Yearly' | 'One-time'
  lineItemLabel: string
}

export function getCheckoutSummary(
  plan: CheckoutPlanId,
  cadence: PaddleCheckoutCadence
): CheckoutSummary | null {
  const tier = SYNC_PLAN_TIERS.find((t) => t.checkoutPlanId === plan)
  if (!tier) return null

  const normalized = normalizeCadenceForPlan(plan, cadence)
  const amount =
    normalized === 'monthly'
      ? tier.monthlyPrice
      : normalized === 'annual'
        ? tier.annualPrice
        : tier.lifetimePrice
  if (amount == null) return null

  const billingFrequencyLabel =
    normalized === 'monthly' ? 'Monthly' : normalized === 'annual' ? 'Yearly' : 'One-time'
  const lineItemLabel =
    normalized === 'lifetime'
      ? `${tier.name} lifetime`
      : `${tier.name} ${billingFrequencyLabel.toLowerCase()} subscription`

  return { planName: tier.name, amount, currency: 'USD', billingFrequencyLabel, lineItemLabel }
}

export function parseCheckoutToken(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const token = params.get('token')?.trim()
  return token && token.length > 0 ? token : null
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `node --import tsx --test apps/landing/src/lib/checkout-summary.test.ts`
Expected: PASS — `tests 6 pass 6`.

- [ ] **Step 5: Create the `Checkout` page component**

Create `apps/landing/src/pages/Checkout.tsx`:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Container } from '@/components/layout/Container'
import { PageHead } from '@/components/shared/PageHead'
import { Button } from '@/components/ui/button'
import { SYNC_PLAN_TIERS, type CheckoutPlanId } from '@/lib/constants'
import { openPaddleCheckout, type PaddleCheckoutCadence } from '@/lib/paddle-checkout'
import {
  getCheckoutSummary,
  getSelectableCadences,
  normalizeCadenceForPlan,
  parseCheckoutToken
} from '@/lib/checkout-summary'
import { cn } from '@/lib/utils'

const PURCHASABLE_TIERS = SYNC_PLAN_TIERS.filter((tier) => tier.checkoutPlanId)

type CheckoutStatus = 'idle' | 'starting' | 'pending' | 'success' | 'failed' | 'canceled'

export function CheckoutPage() {
  const [token, setToken] = useState<string | null>(null)
  const [plan, setPlan] = useState<CheckoutPlanId>('pro')
  const [cadence, setCadence] = useState<PaddleCheckoutCadence>('annual')
  const [status, setStatus] = useState<CheckoutStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const completedRef = useRef(false)

  useEffect(() => {
    setToken(parseCheckoutToken(window.location.hash))
  }, [])

  const effectiveCadence = normalizeCadenceForPlan(plan, cadence)
  const summary = useMemo(
    () => getCheckoutSummary(plan, effectiveCadence),
    [plan, effectiveCadence]
  )
  const cadenceOptions = getSelectableCadences(plan)

  const selectPlan = (next: CheckoutPlanId) => {
    setPlan(next)
    setCadence((current) => normalizeCadenceForPlan(next, current))
  }

  const proceed = async () => {
    if (!token) return
    setStatus('starting')
    setError(null)
    completedRef.current = false
    try {
      await openPaddleCheckout(plan, effectiveCadence, token, (event) => {
        if (event.name === 'checkout.completed') {
          completedRef.current = true
          setStatus('success')
        } else if (event.name === 'checkout.closed' && !completedRef.current) {
          setStatus('canceled')
        } else if (event.name === 'checkout.payment.failed') {
          setStatus('failed')
        }
      })
      setStatus((current) => (current === 'starting' ? 'pending' : current))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start checkout')
      setStatus('idle')
    }
  }

  return (
    <>
      <PageHead page="pricing" />
      <main className="py-16">
        <Container>
          {!token ? (
            <NoTokenNotice />
          ) : (
            <div className="grid gap-10 md:grid-cols-2">
              <section>
                <p className="text-sm text-muted-foreground">Account · Sync · Checkout</p>
                <h1 className="mt-2 text-2xl font-semibold">Choose a sync plan</h1>

                <h2 className="mt-8 text-sm font-medium uppercase tracking-wide">Plan</h2>
                <div className="mt-3 space-y-2">
                  {PURCHASABLE_TIERS.map((tier) => (
                    <button
                      key={tier.id}
                      type="button"
                      onClick={() => selectPlan(tier.checkoutPlanId!)}
                      className={cn(
                        'flex w-full flex-col rounded-lg border p-4 text-start transition',
                        plan === tier.checkoutPlanId
                          ? 'border-primary ring-1 ring-primary'
                          : 'border-border hover:border-foreground/30'
                      )}
                    >
                      <span className="font-medium">{tier.name}</span>
                      <span className="text-sm text-muted-foreground">{tier.tagline}</span>
                    </button>
                  ))}
                </div>

                {cadenceOptions.length > 1 && (
                  <>
                    <h2 className="mt-8 text-sm font-medium uppercase tracking-wide">
                      Renewal frequency
                    </h2>
                    <div className="mt-3 space-y-2">
                      {cadenceOptions.map((option) => (
                        <button
                          key={option}
                          type="button"
                          onClick={() => setCadence(option)}
                          className={cn(
                            'flex w-full items-center justify-between rounded-lg border p-4 text-start transition',
                            effectiveCadence === option
                              ? 'border-primary ring-1 ring-primary'
                              : 'border-border hover:border-foreground/30'
                          )}
                        >
                          <span className="capitalize">
                            {option === 'annual' ? 'Yearly' : 'Monthly'}
                          </span>
                          {option === 'annual' && (
                            <span className="text-xs font-medium text-emerald-600">SAVE 20%</span>
                          )}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </section>

              <OrderSummary summary={summary} status={status} error={error} onProceed={proceed} />
            </div>
          )}
        </Container>
      </main>
    </>
  )
}

function OrderSummary({
  summary,
  status,
  error,
  onProceed
}: {
  summary: ReturnType<typeof getCheckoutSummary>
  status: CheckoutStatus
  error: string | null
  onProceed: () => void
}) {
  if (!summary) {
    return (
      <aside className="rounded-lg border border-border p-6">
        <p className="text-sm text-muted-foreground">This plan is not available for purchase.</p>
      </aside>
    )
  }

  return (
    <aside className="rounded-lg border border-border p-6">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">Billing frequency</span>
        <span className="font-medium">{summary.billingFrequencyLabel}</span>
      </div>
      <div className="mt-4 flex items-center justify-between text-sm">
        <span>{summary.lineItemLabel}</span>
        <span>${summary.amount.toFixed(2)}</span>
      </div>
      <hr className="my-6 border-border" />
      <div className="flex items-center justify-between">
        <span className="text-lg font-semibold">Total</span>
        <span className="text-lg font-semibold">
          {summary.currency} ${summary.amount.toFixed(2)}
        </span>
      </div>

      {status === 'success' && (
        <p className="mt-4 text-sm text-emerald-600">
          Payment complete. Return to Memry to finish activation.
        </p>
      )}
      {status === 'canceled' && (
        <p className="mt-4 text-sm text-muted-foreground">Checkout canceled.</p>
      )}
      {status === 'failed' && (
        <p className="mt-4 text-sm text-terracotta">Payment failed. Please try again.</p>
      )}
      {error && <p className="mt-4 text-sm text-terracotta">{error}</p>}

      <Button
        type="button"
        className="mt-6 w-full"
        disabled={status === 'starting' || status === 'pending'}
        onClick={onProceed}
      >
        {status === 'starting' || status === 'pending' ? 'Opening…' : 'Proceed to payment'}
      </Button>
    </aside>
  )
}

function NoTokenNotice() {
  return (
    <div className="mx-auto max-w-md rounded-lg border border-border p-8 text-center">
      <h1 className="text-xl font-semibold">Open Memry to upgrade</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        Start checkout from <strong>Settings → Account</strong> in the Memry desktop app so we can
        link the purchase to your account.
      </p>
      <Button asChild className="mt-6">
        <Link to="/download/desktop">Download Memry</Link>
      </Button>
    </div>
  )
}
```

- [ ] **Step 6: Register the route**

In `apps/landing/src/App.tsx`, add the import after line 18 (`import { PricingPage } ...`):

```typescript
import { CheckoutPage } from '@/pages/Checkout'
```

Add the route after line 131 (`<Route path="/pricing" ... />`):

```typescript
          <Route path="/checkout" element={<CheckoutPage />} />
```

- [ ] **Step 7: Typecheck the landing app**

Run: `pnpm --filter @memry/landing typecheck`
Expected: PASS. (If `cn` is not exported from `@/lib/utils`, drop the import and inline class strings — confirm with `grep -n "export" apps/landing/src/lib/utils.ts`. If `text-terracotta`/`text-muted-foreground` are unknown tokens, swap for existing ones used in `Pricing.tsx`.)

- [ ] **Step 8: Commit**

```bash
git add apps/landing/src/lib/checkout-summary.ts apps/landing/src/lib/checkout-summary.test.ts apps/landing/src/pages/Checkout.tsx apps/landing/src/App.tsx
git commit -m "feat(landing): add /checkout plan-selection page"
```

---

## Task 4: desktop — Upgrade opens `/checkout` with an identity token

**Files:**

- Modify: `apps/desktop/src/main/billing/paddle-billing.ts:14,44-61,143-154`
- Modify: `apps/desktop/src/preload/api/sync-identity.ts:47-48`
- Modify: `apps/desktop/src/preload/index.d.ts:1486-1489`
- Modify: `apps/desktop/src/main/ipc/account-handlers.ts:69-72`
- Modify: `apps/desktop/src/renderer/src/pages/settings/account-section.tsx:194`
- Modify: `apps/desktop/src/preload/api/preload-api.test.ts:667`
- Modify: `apps/desktop/src/main/index.ts:522-533` (+ orphan cleanup)

This task changes a renderer↔main IPC signature. **REQUIRED SUB-SKILL:** follow the Memry `ipc-contract-change` skill, and run `pnpm ipc:generate` then `pnpm ipc:check` after editing the preload/handler.

- [ ] **Step 1: Make `startBillingCheckout` take no arguments and open `/checkout`**

In `apps/desktop/src/main/billing/paddle-billing.ts`, change the URL constant (line 14):

```typescript
const CHECKOUT_PAGE_URL = 'https://memrynote.com/checkout'
```

Replace `startBillingCheckout` (lines 44-61):

```typescript
export async function startBillingCheckout(): Promise<
  BillingActionResult & { checkoutUrl?: string }
> {
  const token = await getValidAccessToken()
  if (!token) return { success: false, error: 'Sign in to start checkout' }

  const response = await postToServer<{ checkoutToken: string }>('/auth/checkout-token', {}, token)
  const checkoutUrl = buildCheckoutPageUrl(response.checkoutToken)
  await shell.openExternal(checkoutUrl)

  return { success: true, checkoutUrl }
}
```

Replace `buildLandingCheckoutUrl` (lines 143-154) with:

```typescript
function buildCheckoutPageUrl(checkoutToken: string): string {
  const params = new URLSearchParams({ token: checkoutToken })
  return `${CHECKOUT_PAGE_URL}#${params.toString()}`
}
```

(`BillingPlanId` / `BillingCadence` type exports stay — they are still used by `reconcileBillingAndSync` callers and the deep-link parser. Only `startBillingCheckout`'s own use of them is removed.)

- [ ] **Step 2: Update the preload runtime wrapper**

In `apps/desktop/src/preload/api/sync-identity.ts`, replace lines 47-48:

```typescript
  startCheckout: () => invoke(AccountChannels.invoke.START_CHECKOUT),
```

- [ ] **Step 3: Update the preload type declaration**

In `apps/desktop/src/preload/index.d.ts`, replace lines 1486-1489:

```typescript
startCheckout: () => Promise<BillingActionResult & { checkoutUrl?: string }>
```

- [ ] **Step 4: Update the main IPC handler**

In `apps/desktop/src/main/ipc/account-handlers.ts`, replace lines 69-72:

```typescript
ipcMain.handle(AccountChannels.invoke.START_CHECKOUT, async () => {
  log.info('account:startCheckout requested')
  return startBillingCheckout()
})
```

- [ ] **Step 5: Update the renderer call site**

In `apps/desktop/src/renderer/src/pages/settings/account-section.tsx`, replace line 194:

```typescript
const result = await window.api.account.startCheckout()
```

- [ ] **Step 6: Update the preload API test**

In `apps/desktop/src/preload/api/preload-api.test.ts`, replace line 667:

```typescript
      () => accountApi.startCheckout(),
```

- [ ] **Step 7: Point the `memry://billing/start` deep link at the checkout page**

In `apps/desktop/src/main/index.ts`, replace the `/start` branch (lines 523-527):

```typescript
      if (parsed.pathname === '/start') {
        openAccountSettings(mainWindow)
        void startBillingCheckout()
      } else if (parsed.pathname === '/complete') {
```

Then check whether `parseBillingPlan` / `parseBillingCadence` are now orphaned:
Run: `grep -n "parseBillingPlan\|parseBillingCadence" apps/desktop/src/main/index.ts`
If their only remaining reference is their own definition (around lines 500-508), delete both functions and the now-unused `BillingPlanId` / `BillingCadence` imports they used. If anything else references them, leave them.

- [ ] **Step 8: Regenerate and validate the IPC contract**

Run: `pnpm ipc:generate && pnpm ipc:check`
Expected: both succeed; the generated invoke map reflects `START_CHECKOUT` taking no input.

- [ ] **Step 9: Typecheck desktop (node + web) and run the preload test**

Run: `pnpm --filter @memry/desktop typecheck`
Run: `pnpm --filter @memry/desktop test:main -- preload-api.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src/main/billing/paddle-billing.ts apps/desktop/src/preload/api/sync-identity.ts apps/desktop/src/preload/index.d.ts apps/desktop/src/main/ipc/account-handlers.ts apps/desktop/src/renderer/src/pages/settings/account-section.tsx apps/desktop/src/preload/api/preload-api.test.ts apps/desktop/src/main/index.ts
git commit -m "feat(desktop): upgrade button opens /checkout with identity token"
```

---

## Task 5: landing — remove the dead token auto-fire path from Pricing.tsx

**Files:**

- Modify: `apps/landing/src/pages/Pricing.tsx:25-34,65,78-116`

The desktop flow no longer sends a checkout token to `/pricing`, so the hash auto-fire branch is dead. Keep the `?checkout=success` banner and the website-visitor `memry://billing/start` bounce.

- [ ] **Step 1: Remove the auto-fire branch and `consumedCheckoutIntent` ref**

In `apps/landing/src/pages/Pricing.tsx`, replace the `useEffect` (lines 67-116) with the success-only handler:

```typescript
useEffect(() => {
  const params = new URLSearchParams(window.location.search)
  if (params.get('checkout') === 'success') {
    setCheckout({
      pendingKey: null,
      error: null,
      notice: { type: 'success', transactionId: params.get('transactionId') }
    })
  }
}, [])
```

Delete the `consumedCheckoutIntent` ref declaration (line 65).

- [ ] **Step 2: Remove now-unused imports**

In the `@/lib/paddle-checkout` import (lines 25-31), drop `openPaddleCheckout` and `parseCheckoutHash` (keep `buildMemryBillingCompleteUrl`, `buildMemryBillingStartUrl`, `type PaddleCheckoutCadence` — verify each is still referenced with `grep -n`). Drop `useRef` from the React import (line 1) if no other ref remains (`grep -n "useRef" apps/landing/src/pages/Pricing.tsx`).

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @memry/landing typecheck`
Expected: PASS — no unused-symbol errors.

- [ ] **Step 4: Commit**

```bash
git add apps/landing/src/pages/Pricing.tsx
git commit -m "refactor(landing): drop dead checkout-token auto-fire from pricing page"
```

---

## Task 6: Full verification + docs

- [ ] **Step 1: Run all affected test suites**

```bash
node --import tsx --test apps/landing/api/paddle-checkout-config.test.ts apps/landing/src/lib/checkout-summary.test.ts
pnpm test:sync-server
pnpm test:desktop
```

Expected: all PASS.

- [ ] **Step 2: Lint + typecheck the repo**

```bash
pnpm lint
pnpm typecheck
git diff --check
```

Expected: clean.

- [ ] **Step 3: Docs impact gate (desktop + sync-server + landing changed)**

```bash
base_commit=$(git merge-base origin/main HEAD)
pnpm docs:impact --base "$base_commit" --strict
```

If it reports `missing-docs`, update `apps/docs/src/**` (or run `pnpm docs:ai-update --base "$base_commit"`), then re-run `pnpm docs:impact --base "$base_commit" --strict` and `pnpm docs:build`.

- [ ] **Step 4: Manual end-to-end smoke (electron-coupled glue not unit-tested)**

`pnpm dev`, sign in as a free user, Settings → Account → Upgrade. Confirm: browser opens `memrynote.com/checkout#token=…`; selecting Plus/Pro/Believer and Monthly/Yearly updates the summary total; Believer hides the renewal toggle; Proceed opens the Paddle overlay. (Requires Paddle sandbox env vars configured on the landing deployment.)

- [ ] **Step 5: Final commit if docs changed**

```bash
git add apps/docs
git commit -m "docs: document /checkout plan-selection flow"
```

---

## Self-Review Notes

- **Spec coverage:** identity token (Task 2), plan/cadence-from-body server resolution (Task 1), `/checkout` two-column page with plan+cadence+summary+Proceed (Task 3), desktop no-arg upgrade + deep link (Task 4), Pricing.tsx cleanup (Task 5), security (server-resolved price + token userId — Tasks 1-2), testing + docs gate (Task 6). Believer=lifetime handled in Tasks 1 and 3.
- **Type consistency:** `parseCheckoutToken`/`getCheckoutSummary`/`normalizeCadenceForPlan`/`getSelectableCadences` names match between `checkout-summary.ts`, its test, and `Checkout.tsx`. `signCheckoutToken(secret, {userId, exp})` (sync-server) and `signPaddleCheckoutToken({userId, exp}, secret)` (landing test) both produce identity tokens verified by the shared HMAC secret. `startBillingCheckout()` is no-arg across main, preload wrapper, preload type, handler, renderer, and preload test.
- **Known unknowns to confirm during implementation (grep, don't assume):** `cn` export and Tailwind tokens (`text-terracotta`, `text-muted-foreground`, `border-primary`) in landing; whether `Button` supports `asChild`; whether `CheckoutCadence` has a non-test importer in sync-server before deleting it.
