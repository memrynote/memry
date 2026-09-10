import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createLandingEventData,
  createLandingPageViewData,
  isReplayRecorderException,
  isSafeLinksScannerException,
  readLandingCampaignParams,
  trackLandingEvent,
  trackLandingPageView
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
        '/pricing?checkout=success#plans',
        '?utm_source=waitlist&utm_medium=email&utm_campaign=waitlist_01_launch_plain&utm_content=primary_cta&email=private@example.com'
      ),
      {
        page: '/pricing',
        target: 'download:https://github.com/memrynote/memry/releases',
        utm_source: 'waitlist',
        utm_medium: 'email',
        utm_campaign: 'waitlist_01_launch_plain',
        utm_content: 'primary_cta'
      }
    )
  })

  it('keeps only safe campaign params for attribution', () => {
    assert.deepEqual(
      readLandingCampaignParams(
        '?utm_source=waitlist&utm_medium=email&utm_campaign=waitlist_01&utm_term=launch&token=secret'
      ),
      {
        utm_source: 'waitlist',
        utm_medium: 'email',
        utm_campaign: 'waitlist_01',
        utm_term: 'launch'
      }
    )
  })

  it('keeps pageview event data to page only', () => {
    assert.deepEqual(createLandingPageViewData('/download/desktop?ref=launch#mac'), {
      page: '/download/desktop'
    })
  })
})

describe('landing analytics send path', () => {
  it('does nothing without a window (prerender/SSR)', () => {
    assert.doesNotThrow(() => {
      trackLandingPageView('/')
      trackLandingEvent('landing_nav_click', 'nav:logo')
    })
  })
})

describe('SafeLinks scanner noise', () => {
  const scannerRejection = (id: number): string =>
    `Non-Error promise rejection captured with value: Object Not Found Matching Id:${id}, MethodName:update, ParamCount:4`

  it('drops the Outlook SafeLinks rejection on every Id fingerprint', () => {
    for (const id of [1, 2, 3]) {
      assert.equal(
        isSafeLinksScannerException({
          event: '$exception',
          properties: { $exception_values: [scannerRejection(id)] }
        }),
        true
      )
    }
  })

  it('matches the message wherever posthog-js puts it', () => {
    assert.equal(
      isSafeLinksScannerException({
        event: '$exception',
        properties: { $exception_message: scannerRejection(1) }
      }),
      true
    )
    assert.equal(
      isSafeLinksScannerException({
        event: '$exception',
        properties: { $exception_list: [{ type: null, value: scannerRejection(1) }] }
      }),
      true
    )
  })

  it('keeps genuine exceptions, including other non-Error rejections', () => {
    assert.equal(
      isSafeLinksScannerException({
        event: '$exception',
        properties: { $exception_values: ['TypeError: x is not a function'] }
      }),
      false
    )
    assert.equal(
      isSafeLinksScannerException({
        event: '$exception',
        properties: {
          $exception_values: ['Non-Error promise rejection captured with value: undefined']
        }
      }),
      false
    )
  })

  it('never drops a non-exception event, whatever it contains', () => {
    assert.equal(
      isSafeLinksScannerException({
        event: '$pageview',
        properties: { page: scannerRejection(1) }
      }),
      false
    )
  })

  it('tolerates a null, empty, or property-less event', () => {
    assert.equal(isSafeLinksScannerException(null), false)
    assert.equal(isSafeLinksScannerException(undefined), false)
    assert.equal(isSafeLinksScannerException({ event: '$exception' }), false)
    assert.equal(
      isSafeLinksScannerException({ event: '$exception', properties: { $exception_values: null } }),
      false
    )
  })
})

describe('replay recorder noise', () => {
  const recorderSource = ['/assets/posthog-CRUr1Hn-.js']

  it('drops the Firefox DOM-permission errors thrown inside the posthog chunk', () => {
    for (const value of [
      "SecurityError: Permission to call 'get parentNode' denied.",
      'Permission denied to access property "nodeType"'
    ]) {
      assert.equal(
        isReplayRecorderException({
          event: '$exception',
          properties: { $exception_values: [value], $exception_sources: recorderSource }
        }),
        true
      )
    }
  })

  it('matches any hash of the posthog chunk', () => {
    assert.equal(
      isReplayRecorderException({
        event: '$exception',
        properties: {
          $exception_values: ["SecurityError: Permission to call 'get parentNode' denied."],
          $exception_sources: ['/assets/posthog-Zz00zZ99.js']
        }
      }),
      true
    )
  })

  it('keeps the same message when it comes from app code', () => {
    assert.equal(
      isReplayRecorderException({
        event: '$exception',
        properties: {
          $exception_values: ["SecurityError: Permission to call 'get parentNode' denied."],
          $exception_sources: ['/assets/index-Og-Irb9y.js']
        }
      }),
      false
    )
  })

  it('keeps genuine exceptions from the posthog chunk', () => {
    assert.equal(
      isReplayRecorderException({
        event: '$exception',
        properties: {
          $exception_values: ['TypeError: x is not a function'],
          $exception_sources: recorderSource
        }
      }),
      false
    )
  })

  it('never drops a non-exception event, whatever it contains', () => {
    assert.equal(
      isReplayRecorderException({
        event: '$pageview',
        properties: {
          $exception_values: ["SecurityError: Permission to call 'get parentNode' denied."],
          $exception_sources: recorderSource
        }
      }),
      false
    )
  })

  it('tolerates a null, empty, or property-less event', () => {
    assert.equal(isReplayRecorderException(null), false)
    assert.equal(isReplayRecorderException(undefined), false)
    assert.equal(isReplayRecorderException({ event: '$exception' }), false)
    assert.equal(
      isReplayRecorderException({
        event: '$exception',
        properties: { $exception_values: null, $exception_sources: null }
      }),
      false
    )
  })
})
