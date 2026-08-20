import { describe, expect, it } from 'vitest'
import { decideEmbedRequestHeaders, EMBED_REFERER } from './embed-referer'

const EMBED_URL = 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0'

describe('decideEmbedRequestHeaders', () => {
  it('names the app site as embedder when the frame request carries no referrer', () => {
    expect(decideEmbedRequestHeaders(EMBED_URL, { 'User-Agent': 'MemryNote' })).toEqual({
      'User-Agent': 'MemryNote',
      Referer: EMBED_REFERER
    })
  })

  it('uses an https referrer (a file:// or empty one is what YouTube rejects)', () => {
    expect(EMBED_REFERER.startsWith('https://')).toBe(true)
  })

  it('leaves a request that already has a referrer alone, whatever the header casing', () => {
    expect(decideEmbedRequestHeaders(EMBED_URL, { Referer: 'http://localhost:5173/' })).toBeNull()
    expect(decideEmbedRequestHeaders(EMBED_URL, { referer: 'http://localhost:5173/' })).toBeNull()
  })

  it('touches only the embed origin', () => {
    expect(decideEmbedRequestHeaders('https://www.youtube.com/embed/abc', {})).toBeNull()
    expect(decideEmbedRequestHeaders('https://evil.example/embed/abc', {})).toBeNull()
    expect(decideEmbedRequestHeaders('https://api.memrynote.com/sync', {})).toBeNull()
    expect(
      decideEmbedRequestHeaders('https://www.youtube-nocookie.com.evil.example/embed/abc', {})
    ).toBeNull()
  })

  it('ignores unparseable urls', () => {
    expect(decideEmbedRequestHeaders('not a url', {})).toBeNull()
  })
})
