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
import { BlockNoteEditor } from '@blocknote/core'
import {
  LinkMention,
  MENTION_TOKEN_REGEX,
  linkMentionDisplayHost,
  serializeLinkMentionToken,
  parseLinkMentionToken
} from './link-mention'
import { createMemrySchema } from '../schema'
import { createServerBlockSpecs, createServerInlineSpecs } from '../server'

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
  it('captures a legacy token exactly as the strict pattern did', () => {
    const legacyStrict = /\(\(mention:([^)\s]+)\)\)/
    for (const url of ['https://x.test/a', 'https://x.test/foo_bar', 'https://x.test/a*b']) {
      // The legacy serializer left `_ * ! ~ '` raw, so build its output by hand.
      const legacyToken = `((mention:${encodeURIComponent(url).replace(/\(/g, '%28').replace(/\)/g, '%29')}))`
      expect(legacyStrict.exec(legacyToken)?.[1]).toBe(
        new RegExp(MENTION_TOKEN_REGEX.source).exec(legacyToken)?.[1]
      )
    }
  })

  it('does not let a broken token upstream swallow a working one', () => {
    // A note damaged by this very bug holds literal `((mention:` fragments. A
    // payload class that stops only at `)` runs straight through the fragment
    // and captures it together with the next real token, so widening the
    // pattern would have broken mentions that work today.
    const line = 'x ((mention:foo ((mention:https%3A%2F%2Fx.test)) y'
    const matches = [...line.matchAll(MENTION_TOKEN_REGEX)]

    expect(matches.map((m) => parseLinkMentionToken(m[1]))).toEqual(['https://x.test'])
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
    // standing between `((mention: see below))` and a chip. Stripping the
    // spaces out of prose can hand it something `new URL` accepts —
    // `see http://x.com` becomes `seehttp://x.com` — so the alphabet check has
    // to run as well.
    expect(parseLinkMentionToken(' see below')).toBeNull()
    expect(parseLinkMentionToken('not a url ')).toBeNull()
    expect(parseLinkMentionToken(' see http://x.com')).toBeNull()
    expect(parseLinkMentionToken(' javascript:alert(1)')).toBeNull()
    expect(parseLinkMentionToken('  ')).toBeNull()
  })
})

/**
 * The chip label is the stored host as written (#4685), so without a
 * display-time conversion a Cyrillic look-alike reads as the real site and a
 * bidi override reorders the label (#4751). iOS pins the same values in
 * `NoteInlineLabelTests.linkMentionHostIsDisplaySafe` (apps/ios/MemryTests/NoteParityRenderTests.swift).
 */
describe('linkMentionDisplayHost', () => {
  it.each([
    ['a Cyrillic look-alike as punycode', '\u0430pple.com', 'xn--pple-43d.com'],
    ['a bidi override stripped', 'evil\u202Ecom.example', 'evilcom.example'],
    ['format and control characters stripped', 'a\u200Bb\u2066c\u0085.example', 'abc.example'],
    ['an ASCII host unchanged', 'github.com', 'github.com'],
    ['a stored punycode host unchanged', 'xn--pple-43d.com', 'xn--pple-43d.com'],
    ['a non-host domain with its non-ASCII percent-encoded', 'x.com/ş', 'x.com/%C5%9F']
  ])('shows %s', (_name, domain, label) => {
    expect(linkMentionDisplayHost(domain)).toBe(label)
  })
})

describe('LinkMention chip label', () => {
  function renderChip(domain: string): HTMLElement {
    const editor = BlockNoteEditor.create({
      schema: createMemrySchema({
        blocks: createServerBlockSpecs(),
        inline: { ...createServerInlineSpecs(), linkMention: LinkMention }
      })
    } as never)
    const props = { url: 'https://example.test/', domain, title: '', favicon: '', siteName: '' }
    const rendered = LinkMention.implementation.render(
      { type: 'linkMention', props },
      () => {},
      editor
    )
    if (!(rendered.dom instanceof HTMLElement)) throw new Error('the chip renders an element')
    return rendered.dom
  }

  it('shows the host as ASCII and keeps the stored domain', () => {
    const domain = '\u202E\u0430pple.com'
    const chip = renderChip(domain)
    expect(chip.querySelector('.link-mention-site')?.textContent).toBe('xn--pple-43d.com')
    expect(chip.getAttribute('data-domain')).toBe(domain)
  })
})
