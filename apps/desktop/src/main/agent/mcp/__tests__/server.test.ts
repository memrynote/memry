import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startAgentMcpServer, type AgentMcpServerHandle } from '../server'

describe('Agent MCP HTTP server', () => {
  let handle: AgentMcpServerHandle

  beforeEach(async () => {
    handle = await startAgentMcpServer({ toolRegistrations: [] })
  })

  afterEach(async () => {
    await handle.stop()
  })

  it('binds to 127.0.0.1 on a random port', () => {
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const port = Number(handle.url.split(':').pop())
    expect(Number.isInteger(port)).toBe(true)
    expect(port).toBeGreaterThan(0)
  })

  it('rejects requests with no Authorization header', async () => {
    const r = await fetch(`${handle.url}/mcp`, { method: 'POST', body: '{}' })
    expect(r.status).toBe(401)
  })

  it('rejects requests with a bad bearer token', async () => {
    const r = await fetch(`${handle.url}/mcp`, {
      method: 'POST',
      body: '{}',
      headers: { authorization: 'Bearer wrong-token' }
    })
    expect(r.status).toBe(401)
  })

  it('accepts a request with the right bearer token', async () => {
    const r = await fetch(`${handle.url}/healthz`, {
      headers: { authorization: `Bearer ${handle.token}` }
    })
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body).toEqual({ ok: true })
  })

  it('rotates the bearer token and rejects the previous one', async () => {
    const previous = handle.token
    const next = handle.rotateToken()
    expect(next).not.toBe(previous)
    const r = await fetch(`${handle.url}/healthz`, {
      headers: { authorization: `Bearer ${previous}` }
    })
    expect(r.status).toBe(401)
  })
})
