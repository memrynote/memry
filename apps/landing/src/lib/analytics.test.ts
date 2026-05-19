import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createLandingEventData,
  createLandingPageViewData,
  createLandingPostHogConfig,
  sanitizeCapturedNetworkRequest,
  sanitizePostHogEvent
} from './analytics.ts'

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

  it('enables session replay with privacy-first masking', () => {
    const config = createLandingPostHogConfig()

    assert.equal(config.disable_session_recording, false)
    assert.equal(config.disable_external_dependency_loading, true)
    assert.deepEqual(config.session_recording, {
      blockClass: 'ph-no-capture',
      blockSelector: '[data-private], [data-sensitive], [data-ph-no-capture]',
      maskAllInputs: true,
      maskCapturedNetworkRequestFn: config.session_recording?.maskCapturedNetworkRequestFn,
      maskTextSelector: '*'
    })
  })

  it('strips url query strings and hashes before capture', () => {
    const event = sanitizePostHogEvent({
      event: 'landing_test',
      properties: {
        $current_url: 'https://memrynote.com/pricing?checkout=success#plans',
        $referrer: 'https://example.com/path?utm_source=ad',
        target: 'pricing:plus'
      }
    })

    assert.deepEqual(event.properties, {
      $current_url: 'https://memrynote.com/pricing',
      $referrer: 'https://example.com/path',
      target: 'pricing:plus'
    })
  })

  it('removes network bodies and headers from replay metadata', () => {
    assert.deepEqual(
      sanitizeCapturedNetworkRequest({
        name: 'https://memrynote.com/api/waitlist?email=private@example.com',
        requestBody: '{"email":"private@example.com"}',
        responseBody: '{"id":"contact"}',
        requestHeaders: { authorization: 'secret' },
        responseHeaders: { 'set-cookie': 'secret' }
      }),
      {
        name: 'https://memrynote.com/api/waitlist',
        requestBody: undefined,
        responseBody: undefined,
        requestHeaders: undefined,
        responseHeaders: undefined
      }
    )
  })
})
