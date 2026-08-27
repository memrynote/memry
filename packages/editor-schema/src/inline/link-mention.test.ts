/**
 * The mention token's contract with the markdown file it lives in (#1844).
 *
 * A mention persists as literal text inside a paragraph, so remark-stringify
 * gets a vote on its bytes. Anything markdown-significant left raw in the
 * payload comes back escaped, and the escape was landing inside the URL. These
 * tests pin the alphabet closed and pin the two shapes already sitting in real
 * vaults as recoverable.
 */

import { describe, expect, it } from 'vitest'
import {
  MENTION_TOKEN_REGEX,
  serializeLinkMentionToken,
  parseLinkMentionToken
} from './link-mention'

function roundTrip(url: string): string | null {
  const token = serializeLinkMentionToken(url)
  const match = new RegExp(MENTION_TOKEN_REGEX.source).exec(token)
  if (!match) return null
  return parseLinkMentionToken(match[1])
}

describe('serializeLinkMentionToken', () => {
  it.each([
    ['emphasis underscore', 'https://x.test/foo_bar_baz'],
    ['emphasis asterisk', 'https://x.test/a*b'],
    ['image bang', 'https://x.test/a!b'],
    ['strikethrough tilde', 'https://x.test/a~b'],
    ['apostrophe', "https://x.test/it's"],
    ['parens', 'https://x.test/a(b)c'],
    ['percent', 'https://x.test/100%25'],
    ['query string', 'https://x.test/s?q=a+b&page=2#frag'],
    ['space', 'https://x.test/a b'],
    ['non-ascii', 'https://eksisozluk.com/başlık/şeker'],
    ['every offender at once', "https://x.test/_*!~'()%?a=b&c=d#e"]
  ])('round-trips a URL with %s', (_name, url) => {
    expect(roundTrip(url)).toBe(url)
  })

  it.each([
    'https://x.test/foo_bar',
    'https://x.test/a*b',
    'https://x.test/a!b',
    'https://x.test/a~b',
    "https://x.test/it's",
    'https://x.test/a(b)c',
    'https://eksisozluk.com/başlık'
  ])('emits nothing outside the closed alphabet for %s', (url) => {
    expect(serializeLinkMentionToken(url)).toMatch(/^\(\(mention:[A-Za-z0-9.%-]+\)\)$/)
  })

  it('leaves the bytes of an already-safe token untouched', () => {
    // Byte identity, not a round-trip: write-back byte-compares, so a change
    // here rewrites every note holding a mention in every vault on next open.
    expect(serializeLinkMentionToken('https://eksisozluk.com/entry/184233570?debe=true')).toBe(
      '((mention:https%3A%2F%2Feksisozluk.com%2Fentry%2F184233570%3Fdebe%3Dtrue))'
    )
    expect(serializeLinkMentionToken('https://x.test/a(b)c')).toBe(
      '((mention:https%3A%2F%2Fx.test%2Fa%28b%29c))'
    )
  })
})

describe('MENTION_TOKEN_REGEX', () => {
  it('accepts every payload the strict pattern accepted', () => {
    const legacyStrict = /\(\(mention:([^)\s]+)\)\)/
    for (const url of ['https://x.test/a', 'https://x.test/foo_bar', 'https://x.test/a*b']) {
      // The legacy serializer left `_ * ! ~ '` raw, so build its output by hand.
      const legacyToken = `((mention:${encodeURIComponent(url).replace(/\(/g, '%28').replace(/\)/g, '%29')}))`
      expect(legacyStrict.exec(legacyToken)?.[1]).toBe(
        new RegExp(MENTION_TOKEN_REGEX.source).exec(legacyToken)?.[1]
      )
    }
  })

  it('matches a token a space or an escape has crept into', () => {
    const pattern = new RegExp(MENTION_TOKEN_REGEX.source)
    expect(pattern.exec('((mention:https%3A%2F%2Fx.test ))')?.[1]).toBe('https%3A%2F%2Fx.test ')
    expect(pattern.exec('((mention:https%3A%2F%2Fx.test%2Ffoo\\_bar))')?.[1]).toBe(
      'https%3A%2F%2Fx.test%2Ffoo\\_bar'
    )
  })

  it('stops at the first closing delimiter with two tokens on one line', () => {
    const matches = [
      ...'a ((mention:https%3A%2F%2Fa.test)) b ((mention:https%3A%2F%2Fb.test)) c'.matchAll(
        MENTION_TOKEN_REGEX
      )
    ]
    expect(matches.map((m) => parseLinkMentionToken(m[1]))).toEqual([
      'https://a.test',
      'https://b.test'
    ])
  })
})

describe('parseLinkMentionToken', () => {
  it('reads a legacy token that left markdown characters raw', () => {
    expect(parseLinkMentionToken('https%3A%2F%2Fx.test%2Ffoo_bar')).toBe('https://x.test/foo_bar')
    expect(parseLinkMentionToken("https%3A%2F%2Fx.test%2Fit's")).toBe("https://x.test/it's")
  })

  it('returns null for a malformed percent escape', () => {
    expect(parseLinkMentionToken('%E0%A4%A')).toBeNull()
    expect(parseLinkMentionToken('')).toBeNull()
  })

  it.each([
    ['a trailing space', 'https%3A%2F%2Fthe-actual-website-url '],
    ['a leading space', ' https%3A%2F%2Fthe-actual-website-url'],
    ['a space mid-URL', 'https%3A%2F%2Fthe-actual- website-url']
  ])('heals %s', (_name, payload) => {
    expect(parseLinkMentionToken(payload)).toBe('https://the-actual-website-url')
  })

  it('heals a remark escape left inside the payload', () => {
    expect(parseLinkMentionToken('https%3A%2F%2Fx.test%2Ffoo\\_bar\\*baz')).toBe(
      'https://x.test/foo_bar*baz'
    )
  })

  it('heals a payload carrying both an escape and a stray space', () => {
    expect(parseLinkMentionToken('https%3A%2F%2Fx.test%2Ffoo\\_bar ')).toBe(
      'https://x.test/foo_bar'
    )
  })

  it('refuses to turn prose into a mention', () => {
    // The pattern now admits whitespace, so the repair path is the only thing
    // standing between `((mention: see below))` and a chip.
    expect(parseLinkMentionToken(' see below')).toBeNull()
    expect(parseLinkMentionToken('not a url ')).toBeNull()
    expect(parseLinkMentionToken('  ')).toBeNull()
  })
})
