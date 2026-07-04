import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import {
  createLandingEventData,
  createLandingPageViewData,
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

const UUID_VALUE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type SendCall = { url: string; body: string }

const originalGlobals = ['window', 'navigator', 'fetch'].map(
  (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
)

function restoreGlobals() {
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete (globalThis as Record<string, unknown>)[key]
  }
}

function stubBrowser({ sendBeacon = true } = {}) {
  const beacons: SendCall[] = []
  const fetches: SendCall[] = []
  const storage = new Map<string, string>()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { pathname: '/pricing', search: '?utm_source=waitlist&email=private@example.com' },
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value)
      }
    }
  })
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: sendBeacon
      ? {
          sendBeacon: (url: string, body: string) => {
            beacons.push({ url, body })
            return true
          }
        }
      : {}
  })
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: (url: string, init: { body: string }) => {
      fetches.push({ url, body: init.body })
      return Promise.resolve(new Response(null, { status: 202 }))
    }
  })
  return { beacons, fetches, storage }
}

describe('landing analytics send path', () => {
  afterEach(restoreGlobals)

  it('sends events via sendBeacon with page, target and campaign params only', () => {
    const { beacons } = stubBrowser()

    trackLandingEvent('landing_pricing_cta_click', 'pricing:plus')

    assert.equal(beacons.length, 1)
    assert.ok(beacons[0].url.endsWith('/telemetry/web'))
    const payload = JSON.parse(beacons[0].body)
    assert.match(payload.visitorId, UUID_VALUE)
    assert.deepEqual(payload.events, [
      {
        name: 'landing_pricing_cta_click',
        page: '/pricing',
        target: 'pricing:plus',
        utm_source: 'waitlist'
      }
    ])
  })

  it('strips query and hash from pageview paths', () => {
    const { beacons } = stubBrowser()

    trackLandingPageView('/download/desktop?ref=launch#mac')

    assert.equal(beacons.length, 1)
    const payload = JSON.parse(beacons[0].body)
    assert.equal(payload.events[0].name, 'landing_page_view')
    assert.equal(payload.events[0].page, '/download/desktop')
  })

  it('persists and reuses the anonymous visitor id', () => {
    const { beacons, storage } = stubBrowser()

    trackLandingPageView('/')
    trackLandingEvent('landing_nav_click', 'nav:logo')

    const [first, second] = beacons.map((call) => JSON.parse(call.body))
    assert.equal(first.visitorId, second.visitorId)
    assert.equal(storage.get('memry_landing_visitor_id'), first.visitorId)
  })

  it('falls back to fetch keepalive when sendBeacon is unavailable', () => {
    const { beacons, fetches } = stubBrowser({ sendBeacon: false })

    trackLandingPageView('/')

    assert.equal(beacons.length, 0)
    assert.equal(fetches.length, 1)
    assert.ok(fetches[0].url.endsWith('/telemetry/web'))
  })

  it('does nothing without a window (prerender/SSR)', () => {
    restoreGlobals()

    assert.doesNotThrow(() => {
      trackLandingPageView('/')
      trackLandingEvent('landing_nav_click', 'nav:logo')
    })
  })
})
