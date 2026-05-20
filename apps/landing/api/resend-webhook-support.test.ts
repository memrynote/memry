import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { toMarketingEmailEvent } from './resend-webhook-support.ts'

describe('resend webhook PostHog mapping', () => {
  it('maps clicked email webhooks without raw recipient, IP, or query secrets', () => {
    assert.deepEqual(
      toMarketingEmailEvent({
        type: 'email.clicked',
        created_at: '2026-05-20T12:00:00.000Z',
        data: {
          broadcast_id: 'broadcast_123',
          email_id: 'email_123',
          to: ['Private@Example.com'],
          subject: 'MemryNote ships end of June',
          click: {
            ipAddress: '203.0.113.10',
            link: 'https://memrynote.com/?utm_source=waitlist&utm_medium=email&utm_campaign=waitlist_01_launch_plain&utm_content=primary_cta&token=secret#waitlist',
            timestamp: '2026-05-20T12:01:00.000Z',
            userAgent: 'Mozilla/5.0'
          }
        }
      }),
      {
        distinctId:
          'marketing_email:8172a023f8733c1c6377deccd97aefc669393f2a8f077b5bee2d1682d9bc307e',
        event: 'marketing_email_clicked',
        properties: {
          broadcast_id: 'broadcast_123',
          campaign_path: '/',
          click_host: 'memrynote.com',
          email_id: 'email_123',
          resend_event_type: 'email.clicked',
          subject: 'MemryNote ships end of June',
          utm_campaign: 'waitlist_01_launch_plain',
          utm_content: 'primary_cta',
          utm_medium: 'email',
          utm_source: 'waitlist'
        },
        timestamp: '2026-05-20T12:00:00.000Z'
      }
    )
  })
})
