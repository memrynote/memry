import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, describe, it } from 'node:test'

import { startSyncProxy } from './sync-proxy.ts'

let upstream
let upstreamUrl
let proxy
const upstreamHits = []

before(async () => {
  upstream = http.createServer((req, res) => {
    upstreamHits.push(req.url)
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('x'.repeat(1000))
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}`
  proxy = await startSyncProxy(upstreamUrl)
})

after(async () => {
  await proxy.close()
  await new Promise((resolve) => upstream.close(resolve))
})

const get = (path) => fetch(`${proxy.url}${path}`)

describe('sync proxy', () => {
  it('records method and pathname but never the query string', async () => {
    proxy.clearFaults()
    const response = await get('/a/b?token=secret')
    await response.text()

    const [record] = proxy.requests({ pathPrefix: '/a/b' })
    assert.equal(record.path, '/a/b')
    assert.equal(record.status, 200)
    assert.equal(record.severed, false)
    assert.equal(record.overridden, false)
    assert.equal(record.delayedMs, 0)
  })

  it('delays a matching request and records the delay', async () => {
    proxy.injectFault({ match: (_m, path) => path === '/slow', delayMs: 300, maxHits: 1 })
    const started = Date.now()
    await (await get('/slow')).text()
    const elapsed = Date.now() - started

    assert.ok(elapsed >= 280, `took ${elapsed} ms`)
    const [record] = proxy.requests({ pathPrefix: '/slow' })
    assert.equal(record.delayedMs, 300)
    assert.equal(record.status, 200)
    assert.equal(proxy.faultHits(), 1)
  })

  it('answers a matching request with the overriding status without calling upstream', async () => {
    proxy.injectFault({ match: (_m, path) => path === '/limited', status: 429, maxHits: 2 })
    const hitsBefore = upstreamHits.length

    const first = await get('/limited')
    const second = await get('/limited')
    const third = await get('/limited')

    assert.deepEqual([first.status, second.status], [429, 429])
    assert.equal(third.status, 200, 'maxHits ends the rule')
    assert.equal(upstreamHits.length, hitsBefore + 1)
    const records = proxy.requests({ pathPrefix: '/limited' })
    assert.deepEqual(
      records.map((entry) => entry.overridden),
      [true, true, false]
    )
    assert.equal(proxy.countStatus(429, '/limited'), 2)
  })

  it('drops the connection mid-body and records the severed response', async () => {
    proxy.injectFault({ match: (_m, path) => path === '/cut', afterBytes: 10, maxHits: 1 })

    await assert.rejects(async () => (await get('/cut')).text())

    const [record] = proxy.requests({ pathPrefix: '/cut' })
    assert.equal(record.severed, true)
    assert.equal(proxy.faultHits(), 1)
  })

  it('leaves non-matching requests alone', async () => {
    proxy.injectFault({ match: (_m, path) => path === '/never', status: 500, maxHits: 5 })

    const response = await get('/other')

    assert.equal(response.status, 200)
    assert.equal(proxy.faultHits(), 0)
    proxy.clearFaults()
  })
})
