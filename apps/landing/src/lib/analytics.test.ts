import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createLandingEventData, createLandingPageViewData } from './analytics.ts'

describe('landing analytics event data', () => {
  it('keeps landing event data to page and target only', () => {
    assert.deepEqual(createLandingEventData('pricing:plus', '/pricing'), {
      page: '/pricing',
      target: 'pricing:plus'
    })
  })

  it('strips query strings and hashes from event data', () => {
    assert.deepEqual(
      createLandingEventData(
        'download:https://github.com/memrynote/memry/releases?token=secret',
        '/pricing?checkout=success#plans'
      ),
      {
        page: '/pricing',
        target: 'download:https://github.com/memrynote/memry/releases'
      }
    )
  })

  it('keeps pageview event data to page only', () => {
    assert.deepEqual(createLandingPageViewData('/download/desktop?ref=launch#mac'), {
      page: '/download/desktop'
    })
  })
})
