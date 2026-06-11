import { describe, it, expect, vi } from 'vitest'
import { listPaddleInvoices, getPaddleInvoicePdfUrl } from './paddle-billing'

// ---------------------------------------------------------------------------
// D1 mock helpers
// ---------------------------------------------------------------------------

function createDb(firstRow: unknown) {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(firstRow)
      })
    })
  } as unknown as D1Database
}

function createEnv(options: {
  firstRow: unknown
  paddleFetch?: typeof fetch
  paddleApiKey?: string
}) {
  return {
    DB: createDb(options.firstRow),
    PADDLE_API_KEY: options.paddleApiKey ?? 'pdl_sandbox_key',
    PADDLE_ENVIRONMENT: 'sandbox' as const,
    fetch: options.paddleFetch
  } as unknown as import('../types').Bindings
}

// ---------------------------------------------------------------------------
// listPaddleInvoices
// ---------------------------------------------------------------------------

describe('listPaddleInvoices', () => {
  it('returns [] when user has no entitlement / no paddle_customer_id', async () => {
    const env = createEnv({ firstRow: null })
    const result = await listPaddleInvoices(env, 'user-1')
    expect(result).toEqual([])
  })

  it('returns [] when entitlement has null paddle_customer_id', async () => {
    const env = createEnv({ firstRow: { paddle_customer_id: null } })
    const result = await listPaddleInvoices(env, 'user-1')
    expect(result).toEqual([])
  })

  it('maps a single transaction to an InvoiceRow', async () => {
    const paddleFetch = vi.fn().mockResolvedValue(
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
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    const env = createEnv({
      firstRow: { paddle_customer_id: 'ctm_1' },
      paddleFetch
    })

    const result = await listPaddleInvoices(env, 'user-1')

    expect(result).toEqual([
      {
        id: 'txn_1',
        status: 'completed',
        billedAt: '2026-06-01T00:00:00Z',
        amount: '4900',
        currency: 'USD'
      }
    ])
    expect(paddleFetch).toHaveBeenCalledWith(
      expect.stringContaining('sandbox-api.paddle.com/transactions'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer pdl_sandbox_key' })
      })
    )
  })

  it('uses 0 as amount fallback when totals are missing', async () => {
    const paddleFetch = vi.fn().mockResolvedValue(
      Response.json({
        data: [
          {
            id: 'txn_2',
            status: 'draft',
            billed_at: null,
            currency_code: 'EUR'
            // no details
          }
        ]
      })
    )
    const env = createEnv({ firstRow: { paddle_customer_id: 'ctm_1' }, paddleFetch })

    const result = await listPaddleInvoices(env, 'user-1')

    expect(result[0]).toMatchObject({ id: 'txn_2', amount: '0' })
  })

  it('throws INTERNAL_ERROR when Paddle returns a non-ok response', async () => {
    const paddleFetch = vi.fn().mockResolvedValue(new Response('bad', { status: 500 }))
    const env = createEnv({ firstRow: { paddle_customer_id: 'ctm_1' }, paddleFetch })

    await expect(listPaddleInvoices(env, 'user-1')).rejects.toMatchObject({ statusCode: 502 })
  })
})

// ---------------------------------------------------------------------------
// getPaddleInvoicePdfUrl
// ---------------------------------------------------------------------------

describe('getPaddleInvoicePdfUrl', () => {
  it('returns the PDF url from Paddle', async () => {
    const paddleFetch = vi
      .fn()
      .mockResolvedValue(Response.json({ data: { url: 'https://paddle.com/invoice/txn_1.pdf' } }))
    const env = createEnv({ firstRow: null, paddleFetch })

    const url = await getPaddleInvoicePdfUrl(env, 'txn_1')

    expect(url).toBe('https://paddle.com/invoice/txn_1.pdf')
    expect(paddleFetch).toHaveBeenCalledWith(
      expect.stringContaining('/transactions/txn_1/invoice'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer pdl_sandbox_key' })
      })
    )
  })

  it('throws when url is missing in Paddle response', async () => {
    const paddleFetch = vi.fn().mockResolvedValue(Response.json({ data: {} }))
    const env = createEnv({ firstRow: null, paddleFetch })

    await expect(getPaddleInvoicePdfUrl(env, 'txn_1')).rejects.toMatchObject({ statusCode: 502 })
  })

  it('throws when Paddle returns non-ok', async () => {
    const paddleFetch = vi.fn().mockResolvedValue(new Response('err', { status: 404 }))
    const env = createEnv({ firstRow: null, paddleFetch })

    await expect(getPaddleInvoicePdfUrl(env, 'txn_1')).rejects.toMatchObject({ statusCode: 502 })
  })
})
