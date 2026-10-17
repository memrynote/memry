import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { detectOS, type DetectedOS } from './download.ts'

const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15'

// Real user agents. The order of checks in detectOS is the behaviour under test: an
// Android UA also says "Linux", an iPhone UA also says "Mac OS X", and iPadOS sends the
// desktop Safari UA, so a reordering would offer a phone the wrong installer.
const VISITORS: readonly { name: string; ua: string; touchPoints: number; os: DetectedOS }[] = [
  {
    name: 'iPhone Safari',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
    touchPoints: 5,
    os: 'ios'
  },
  { name: 'iPad, which sends the desktop Safari UA', ua: MAC_SAFARI, touchPoints: 5, os: 'ios' },
  {
    name: 'Android Chrome',
    ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
    touchPoints: 5,
    os: 'android'
  },
  {
    name: 'a Linux phone that is not Android',
    ua: 'Mozilla/5.0 (Linux; U; Sailfish 3.0; Mobile; rv:45.0) Gecko/45.0 Firefox/45.0 SailfishBrowser/1.0',
    touchPoints: 5,
    os: null
  },
  { name: 'macOS Safari', ua: MAC_SAFARI, touchPoints: 0, os: 'mac' },
  {
    name: 'Windows Chrome',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    touchPoints: 0,
    os: 'windows'
  },
  {
    name: 'Ubuntu Firefox',
    ua: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0',
    touchPoints: 0,
    os: 'linux'
  },
  { name: 'an unrecognised client', ua: 'curl/8.7.1', touchPoints: 0, os: null }
]

const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

afterEach(() => {
  if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator)
})

describe('detectOS', () => {
  for (const visitor of VISITORS) {
    it(`classifies ${visitor.name} as ${visitor.os ?? 'unknown'}`, () => {
      Object.defineProperty(globalThis, 'navigator', {
        value: { userAgent: visitor.ua, maxTouchPoints: visitor.touchPoints },
        configurable: true
      })

      assert.equal(detectOS(), visitor.os)
    })
  }
})
