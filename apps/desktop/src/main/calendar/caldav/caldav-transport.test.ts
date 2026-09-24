import { describe, expect, it, vi } from 'vitest'
import { digestAuthorization, parseDigestChallenge } from './caldav-digest'
import { createCaldavTransport, createCredentialScope } from './caldav-transport'

const CREDENTIALS = { username: 'me@icloud.com', password: 'abcd-efgh-ijkl-mnop' }

describe('credential scope (#1399)', () => {
  it('covers iCloud partition hosts and nothing outside icloud.com', () => {
    const inScope = createCredentialScope('https://caldav.icloud.com/')
    expect(inScope(new URL('https://caldav.icloud.com/123/principal/'))).toBe(true)
    expect(inScope(new URL('https://p67-caldav.icloud.com/123/calendars/'))).toBe(true)
    expect(inScope(new URL('https://icloud.com.evil.net/'))).toBe(false)
    expect(inScope(new URL('https://evil.net/'))).toBe(false)
    expect(inScope(new URL('http://p67-caldav.icloud.com/'))).toBe(false)
  })

  it('never widens to a parent domain under a shared suffix', () => {
    const synology = createCredentialScope('https://myname.synology.me:5001/')
    expect(synology(new URL('https://myname.synology.me:5001/caldav/'))).toBe(true)
    expect(synology(new URL('https://attacker.synology.me/'))).toBe(false)
    expect(synology(new URL('https://synology.me/'))).toBe(false)
    const duckdns = createCredentialScope('https://dav.family.duckdns.org/')
    expect(duckdns(new URL('https://other.duckdns.org/'))).toBe(false)
    expect(duckdns(new URL('https://family.duckdns.org/'))).toBe(false)
    const fastmail = createCredentialScope('https://caldav.fastmail.com/')
    expect(fastmail(new URL('https://d123.caldav.fastmail.com/'))).toBe(true)
  })

  it('keeps plain HTTP to the exact origin the user typed (a LAN server)', () => {
    const inScope = createCredentialScope('http://192.168.1.5:5232/')
    expect(inScope(new URL('http://192.168.1.5:5232/me/'))).toBe(true)
    expect(inScope(new URL('http://192.168.1.5:8080/'))).toBe(false)
    expect(inScope(new URL('https://192.168.1.6:5232/'))).toBe(false)
  })
})

describe('CalDAV transport', () => {
  it('follows a cross-host redirect and re-attaches credentials only inside the scope', async () => {
    const seen: Array<{ url: string; authorization: string | null }> = []
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, authorization: new Headers(init.headers).get('authorization') })
      if (url === 'https://caldav.icloud.com/start') {
        return new Response('', {
          status: 301,
          headers: { location: 'https://p67-caldav.icloud.com/moved' }
        })
      }
      if (url === 'https://p67-caldav.icloud.com/moved') {
        return new Response('', { status: 302, headers: { location: 'https://evil.net/steal' } })
      }
      return new Response('ok', { status: 200 })
    })
    const transport = createCaldavTransport({
      serverUrl: 'https://caldav.icloud.com/',
      credentials: CREDENTIALS,
      fetchImpl
    })

    const response = await transport.fetch('https://caldav.icloud.com/start', {
      method: 'PROPFIND'
    })

    expect(response.status).toBe(200)
    expect(seen.map((entry) => entry.url)).toEqual([
      'https://caldav.icloud.com/start',
      'https://p67-caldav.icloud.com/moved',
      'https://evil.net/steal'
    ])
    expect(seen[0].authorization).toMatch(/^Basic /)
    expect(seen[1].authorization).toMatch(/^Basic /)
    expect(seen[2].authorization).toBeNull()
  })

  it('hands a redirect back untouched when the caller asks for manual redirects', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('', { status: 301, headers: { location: 'https://elsewhere.example/' } })
    )
    const transport = createCaldavTransport({
      serverUrl: 'https://dav.example.com/',
      credentials: CREDENTIALS,
      fetchImpl
    })
    const response = await transport.fetch('https://dav.example.com/.well-known/caldav', {
      method: 'PROPFIND',
      redirect: 'manual'
    })
    expect(response.status).toBe(301)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('answers a Digest challenge and keeps using it', async () => {
    const authorizations: Array<string | null> = []
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const authorization = new Headers(init.headers).get('authorization')
      authorizations.push(authorization)
      if (!authorization?.startsWith('Digest ')) {
        return new Response('', {
          status: 401,
          headers: {
            'www-authenticate': 'Digest realm="dav", nonce="n1", qop="auth", algorithm=MD5'
          }
        })
      }
      return new Response('ok', { status: 200 })
    })
    const transport = createCaldavTransport({
      serverUrl: 'https://dav.example.com/',
      credentials: CREDENTIALS,
      fetchImpl
    })

    expect((await transport.fetch('https://dav.example.com/a', { method: 'GET' })).status).toBe(200)
    expect((await transport.fetch('https://dav.example.com/b', { method: 'GET' })).status).toBe(200)
    expect(authorizations[0]).toMatch(/^Basic /)
    expect(authorizations[1]).toMatch(/^Digest /)
    expect(authorizations[1]).toContain('nc=00000001')
    expect(authorizations[2]).toContain('nc=00000002')
    expect(transport.usesDigest()).toBe(true)
  })

  it('records the status a failed request ended with', async () => {
    const transport = createCaldavTransport({
      serverUrl: 'https://dav.example.com/',
      credentials: CREDENTIALS,
      fetchImpl: async () =>
        new Response('', { status: 401, headers: { 'www-authenticate': 'Basic realm="x"' } })
    })
    await transport.fetch('https://dav.example.com/', { method: 'PROPFIND' })
    expect(transport.lastFailure()).toEqual({ status: 401, retryAfter: null })
  })
})

describe('Digest', () => {
  it('computes the RFC 2617 example response', () => {
    const challenge = parseDigestChallenge(
      'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"'
    )
    expect(challenge).not.toBeNull()
    const header = digestAuthorization({
      challenge: challenge!,
      username: 'Mufasa',
      password: 'Circle Of Life',
      method: 'GET',
      uri: '/dir/index.html',
      nonceCount: 1,
      cnonce: '0a4f113b'
    })
    expect(header).toContain('response="6629fae49393a05397450978507c4ef1"')
  })

  it('ignores a challenge that offers no Digest', () => {
    expect(parseDigestChallenge('Basic realm="x"')).toBeNull()
  })
})
