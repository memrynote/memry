import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { startFakeWebDriver } from './lib/fake-webdriver.mjs'
import { createClient, ELEMENT_KEY, WebDriverError } from './lib/webdriver-client.mjs'

let fake
afterEach(async () => fake?.close())

describe('webdriver client', () => {
  it('opens a tauri session and runs scripts', async () => {
    fake = await startFakeWebDriver((method, path) => {
      if (path === '/session') return { sessionId: 's1' }
      if (path === '/session/s1/execute/sync') return 42
      if (path === '/session/s1/element') return { [ELEMENT_KEY]: 'el1' }
      if (path === '/session/s1/screenshot') return Buffer.from('PNG').toString('base64')
      return null
    })
    const client = createClient(fake.url)
    const id = await client.newSession()
    assert.equal(id, 's1')
    assert.deepEqual(fake.requests[0].body, {
      capabilities: { alwaysMatch: { browserName: 'tauri' } }
    })
    assert.equal(await client.execute(id, 'return 42', []), 42)
    assert.equal(await client.findElement(id, 'body'), 'el1')
    assert.equal((await client.screenshot(id)).toString(), 'PNG')
  })

  it('throws an error carrying the W3C error and message', async () => {
    fake = await startFakeWebDriver(() => ({
      status: 404,
      value: { error: 'no such element', message: 'gone' }
    }))
    await assert.rejects(createClient(fake.url).findElement('s1', '#x'), (error) => {
      assert.ok(error instanceof WebDriverError)
      assert.equal(error.error, 'no such element')
      assert.equal(error.detail, 'gone')
      return true
    })
  })

  it('reports an unreachable server as an error', async () => {
    fake = await startFakeWebDriver(() => null)
    const url = fake.url
    await fake.close()
    fake = undefined
    await assert.rejects(createClient(url).status(), /unreachable/)
  })
})
