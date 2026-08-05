import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { getIndexablePaths } from './crawl-files.ts'
import {
  buildIndexNowKeyFile,
  buildIndexNowPayload,
  INDEXNOW_KEY,
  INDEXNOW_KEY_LOCATION
} from './indexnow.ts'
import { BASE_URL } from './seo.ts'

describe('indexnow', () => {
  it('uses a key the protocol accepts', () => {
    assert.match(INDEXNOW_KEY, /^[a-zA-Z0-9-]{8,128}$/)
  })

  it('serves the key file as the bare key, with no trailing newline', () => {
    assert.equal(buildIndexNowKeyFile(), INDEXNOW_KEY)
    assert.equal(INDEXNOW_KEY_LOCATION, `${BASE_URL}/${INDEXNOW_KEY}.txt`)
  })

  it('submits every indexable page as an absolute URL on the verified host', () => {
    const payload = buildIndexNowPayload()

    assert.equal(payload.host, 'memrynote.com')
    assert.equal(payload.key, INDEXNOW_KEY)
    assert.equal(payload.keyLocation, INDEXNOW_KEY_LOCATION)
    assert.equal(payload.urlList.length, getIndexablePaths().length)

    // A URL outside the declared host makes IndexNow reject the whole batch (422).
    for (const url of payload.urlList) {
      assert.ok(url.startsWith(`${BASE_URL}/`), `${url} is not on ${BASE_URL}`)
    }

    assert.ok(payload.urlList.includes(`${BASE_URL}/`))
  })

  it('narrows the batch to the paths it is given', () => {
    const payload = buildIndexNowPayload(['/changelog', '/download/desktop'])

    assert.deepEqual(payload.urlList, [`${BASE_URL}/changelog`, `${BASE_URL}/download/desktop`])
  })
})
