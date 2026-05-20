import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { normalizeWaitlistAttribution } from './waitlist.ts'

describe('waitlist attribution', () => {
  it('keeps only safe campaign fields for server-side signup capture', () => {
    assert.deepEqual(
      normalizeWaitlistAttribution({
        utm_source: 'waitlist',
        utm_medium: 'email',
        utm_campaign: 'waitlist_01_launch_plain',
        utm_content: 'primary_cta',
        email: 'private@example.com',
        token: 'secret'
      }),
      {
        utm_source: 'waitlist',
        utm_medium: 'email',
        utm_campaign: 'waitlist_01_launch_plain',
        utm_content: 'primary_cta'
      }
    )
  })
})
