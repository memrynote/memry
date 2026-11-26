// Runs the Worker in workerd with a local R2 bucket (wrangler's unstable_dev), no Cloudflare account.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unstable_dev, type Unstable_DevWorker } from 'wrangler'

const READ = 'r'.repeat(40)
const WRITE = 'w'.repeat(40)
const root = resolve(import.meta.dirname, '..')

let worker: Unstable_DevWorker
let state: string

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'turbo-cache-'))
  worker = await unstable_dev(join(root, 'src/index.ts'), {
    config: join(root, 'wrangler.toml'),
    vars: { READ_TOKEN: READ, WRITE_TOKEN: WRITE },
    persistTo: state,
    logLevel: 'error',
    experimental: { disableExperimentalWarning: true }
  })
})

afterAll(async () => {
  await worker?.stop()
  rmSync(state, { recursive: true, force: true })
})

interface ArtifactInit {
  method?: string
  body?: string
  headers?: Record<string, string>
}

const artifact = (hash: string, token: string | null, init: ArtifactInit = {}) =>
  worker.fetch(`/v8/artifacts/${hash}?slug=memry`, {
    method: init.method,
    body: init.body,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers }
  })

const upload = (hash: string, token: string, headers: Record<string, string> = {}) =>
  artifact(hash, token, {
    method: 'PUT',
    body: `artifact ${hash}`,
    headers: {
      'content-type': 'application/octet-stream',
      'x-artifact-tag': `tag-${hash}`,
      ...headers
    }
  })

describe('turbo cache worker', () => {
  it('stores an artifact from the write token and serves it to the read token with its tag', async () => {
    expect((await upload('aaaa1111', WRITE, { 'x-artifact-duration': '1234' })).status).toBe(202)

    const hit = await artifact('aaaa1111', READ)
    expect(hit.status).toBe(200)
    expect(await hit.text()).toBe('artifact aaaa1111')
    expect(hit.headers.get('x-artifact-tag')).toBe('tag-aaaa1111')
    expect(hit.headers.get('x-artifact-duration')).toBe('1234')
    expect((await artifact('aaaa1111', READ, { method: 'HEAD' })).status).toBe(200)
  })

  it('refuses an upload from the read token and keeps the artifact absent', async () => {
    expect((await upload('bbbb2222', READ)).status).toBe(403)
    expect((await artifact('bbbb2222', WRITE)).status).toBe(404)
  })

  it('refuses a read-token upload over an existing artifact and keeps the original', async () => {
    expect((await upload('cccc3333', WRITE)).status).toBe(202)
    const poisoned = await artifact('cccc3333', READ, {
      method: 'PUT',
      body: 'poisoned',
      headers: { 'x-artifact-tag': 'forged' }
    })
    expect(poisoned.status).toBe(403)
    expect(await (await artifact('cccc3333', READ)).text()).toBe('artifact cccc3333')
  })

  it('rejects requests with no token or an unknown token', async () => {
    expect((await artifact('aaaa1111', null)).status).toBe(401)
    expect((await artifact('aaaa1111', 'x'.repeat(40))).status).toBe(401)
    expect((await upload('dddd4444', 'x'.repeat(40))).status).toBe(401)
    const status = await worker.fetch('/v8/artifacts/status')
    expect(status.status).toBe(401)
  })

  it('refuses an unsigned upload', async () => {
    const unsigned = await artifact('eeee5555', WRITE, { method: 'PUT', body: 'x' })
    expect(unsigned.status).toBe(400)
    expect((await artifact('eeee5555', WRITE)).status).toBe(404)
  })

  it('keeps teams apart and rejects a request without a team', async () => {
    expect((await upload('ffff6666', WRITE)).status).toBe(202)
    const other = await worker.fetch('/v8/artifacts/ffff6666?slug=other', {
      headers: { authorization: `Bearer ${READ}` }
    })
    expect(other.status).toBe(404)
    const none = await worker.fetch('/v8/artifacts/ffff6666', {
      headers: { authorization: `Bearer ${READ}` }
    })
    expect(none.status).toBe(400)
  })

  it('refuses an artifact name that is not a plain hash', async () => {
    expect((await upload('..%2Fother%2Faaaa1111', WRITE)).status).toBe(404)
    expect((await upload('not-a-hash.txt', WRITE)).status).toBe(404)
  })

  it('answers the status probe for either token', async () => {
    for (const token of [READ, WRITE]) {
      const res = await worker.fetch('/v8/artifacts/status', {
        headers: { authorization: `Bearer ${token}` }
      })
      expect(await res.json()).toEqual({ status: 'enabled' })
    }
  })
})
