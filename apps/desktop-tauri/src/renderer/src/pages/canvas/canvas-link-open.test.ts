import { describe, it, expect } from 'vitest'
import { resolveCanvasLink } from './canvas-link-open'

const DEV_DOC = 'http://localhost:5173/'
const PROD_DOC = 'file:///Applications/Memry.app/Contents/renderer/index.html'

describe('resolveCanvasLink', () => {
  it.each([
    ['a note', 'memry://note/n1'],
    ['a filed binary', 'memry://file/f1'],
    ['a dated calendar event', 'memry://calendar/event/e1?date=2026-08-17']
  ])('routes %s to the tab system', (_label, href) => {
    expect(resolveCanvasLink(href, PROD_DOC)).toEqual({ kind: 'memry', href })
  })

  it('does not treat an unknown memry host as a vault item', () => {
    expect(resolveCanvasLink('memry://widget/w1', PROD_DOC)).toEqual({
      kind: 'external',
      url: 'memry://widget/w1'
    })
  })

  it('recognises an element link produced by this document in dev', () => {
    expect(resolveCanvasLink('http://localhost:5173/?element=abc', DEV_DOC)).toEqual({
      kind: 'element',
      elementId: 'abc'
    })
  })

  it('recognises an element link produced by this document in a packaged build', () => {
    expect(resolveCanvasLink(`${PROD_DOC}?element=abc`, PROD_DOC)).toEqual({
      kind: 'element',
      elementId: 'abc'
    })
  })

  it('still resolves an element link written by another device, whose path differs', () => {
    // The scene syncs; the absolute path baked into the link does not.
    expect(
      resolveCanvasLink('file:///Users/someone-else/Memry/index.html?element=abc', PROD_DOC)
    ).toEqual({ kind: 'element', elementId: 'abc' })
  })

  it('does not hijack a web URL that merely carries an element query param', () => {
    expect(resolveCanvasLink('https://example.com/page?element=abc', PROD_DOC)).toEqual({
      kind: 'external',
      url: 'https://example.com/page?element=abc'
    })
  })

  it('sends a plain web link to the OS browser', () => {
    expect(resolveCanvasLink('https://example.com', PROD_DOC)).toEqual({
      kind: 'external',
      url: 'https://example.com'
    })
  })

  it('leaves scheme policy to the main-process allowlist rather than a second gate', () => {
    expect(resolveCanvasLink('mailto:kaan@example.com', PROD_DOC)).toEqual({
      kind: 'external',
      url: 'mailto:kaan@example.com'
    })
  })

  it.each([
    ['an empty link', ''],
    ['whitespace', '   '],
    ['a null link', null],
    ['an undefined link', undefined],
    ['a half-typed address', 'exampl']
  ])('ignores %s instead of guessing', (_label, link) => {
    expect(resolveCanvasLink(link, PROD_DOC)).toEqual({ kind: 'ignore' })
  })

  it('trims before deciding, so a padded link still resolves', () => {
    expect(resolveCanvasLink('  memry://note/n1  ', PROD_DOC)).toEqual({
      kind: 'memry',
      href: 'memry://note/n1'
    })
  })

  it('survives an unparseable document href', () => {
    expect(resolveCanvasLink('https://example.com', 'not a url')).toEqual({
      kind: 'external',
      url: 'https://example.com'
    })
  })
})
