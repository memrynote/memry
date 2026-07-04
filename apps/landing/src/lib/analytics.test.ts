import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createLandingEventData,
  createLandingPageViewData,
  readLandingCampaignParams
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
