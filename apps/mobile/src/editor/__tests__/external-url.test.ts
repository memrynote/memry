import { describe, expect, it } from 'vitest'
import { GuestMsgSchema } from '@memry/contracts/webview-bridge'
import { isAllowedExternalUrl } from '../external-url'

/**
 * The scheme check is the ONLY thing between a note's bytes and
 * `Linking.openURL`, because the WebView refuses every navigation itself
 * (`editor-host.tsx`). A note is whatever any device ever synced, so the
 * rejected cases here are the security property, not a formatting nicety.
 */
describe('external link allowlist', () => {
  it('opens the web and mail schemes desktop opens', () => {
    expect(isAllowedExternalUrl('https://example.com/x')).toBe(true)
    expect(isAllowedExternalUrl('http://example.com/x')).toBe(true)
    expect(isAllowedExternalUrl('mailto:kaan@example.com')).toBe(true)
  })

  it('refuses script, file and third-party app schemes', () => {
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedExternalUrl('obsidian://open?vault=x')).toBe(false)
    expect(isAllowedExternalUrl('data:text/html,<script>')).toBe(false)
  })

  it('refuses anything that is not a URL at all', () => {
    expect(isAllowedExternalUrl('example.com')).toBe(false)
    expect(isAllowedExternalUrl('')).toBe(false)
  })
})

describe('open-external message', () => {
  it('is a legal guest message, so a tapped link reaches the host', () => {
    const parsed = GuestMsgSchema.safeParse({
      type: 'open-external',
      url: 'https://example.com/'
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects an empty URL rather than waking the host for nothing', () => {
    expect(GuestMsgSchema.safeParse({ type: 'open-external', url: '' }).success).toBe(false)
  })
})
