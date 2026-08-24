import { describe, expect, it } from 'vitest'
import { rewriteWikiLinksForRename } from './rewrite-wiki-links'

const noOther = () => false

describe('rewriteWikiLinksForRename', () => {
  it('rewrites a plain link and leaves other links alone', () => {
    expect(
      rewriteWikiLinksForRename(
        'See [[Old Title]] and [[Other Note]].',
        'Old Title',
        'New Title',
        noOther
      )
    ).toBe('See [[New Title]] and [[Other Note]].')
  })

  it('returns null when nothing matches', () => {
    expect(
      rewriteWikiLinksForRename('See [[Other Note]].', 'Old Title', 'New Title', noOther)
    ).toBeNull()
    expect(rewriteWikiLinksForRename('no links here', 'Old Title', 'New Title', noOther)).toBeNull()
    expect(rewriteWikiLinksForRename('', 'Old Title', 'New Title', noOther)).toBeNull()
  })

  it('returns null when old and new titles are identical', () => {
    expect(rewriteWikiLinksForRename('[[Same]]', 'Same', 'Same', noOther)).toBeNull()
  })

  it('matches titles case-insensitively, same as resolveNoteByTitle', () => {
    expect(
      rewriteWikiLinksForRename('[[old title]] and [[OLD TITLE]]', 'Old Title', 'New', noOther)
    ).toBe('[[New]] and [[New]]')
  })

  it('rewrites a case-only rename', () => {
    expect(rewriteWikiLinksForRename('[[old title]]', 'old title', 'Old Title', noOther)).toBe(
      '[[Old Title]]'
    )
  })

  it('keeps the alias untouched', () => {
    expect(rewriteWikiLinksForRename('[[Old|my label]]', 'Old', 'New', noOther)).toBe(
      '[[New|my label]]'
    )
  })

  it('keeps the heading half, nested segments included', () => {
    expect(rewriteWikiLinksForRename('[[Old#Heading]]', 'Old', 'New', noOther)).toBe(
      '[[New#Heading]]'
    )
    expect(rewriteWikiLinksForRename('[[Old#H1#H2]]', 'Old', 'New', noOther)).toBe('[[New#H1#H2]]')
    expect(rewriteWikiLinksForRename('[[Old#Heading|label]]', 'Old', 'New', noOther)).toBe(
      '[[New#Heading|label]]'
    )
  })

  it('never touches a same-note heading link', () => {
    expect(rewriteWikiLinksForRename('[[#Heading]]', '#Heading', 'New', noOther)).toBeNull()
  })

  it('rewrites a title containing # when no other note claims the split half', () => {
    expect(rewriteWikiLinksForRename('[[Sprint #4]]', 'Sprint #4', 'Sprint Four', noOther)).toBe(
      '[[Sprint Four]]'
    )
  })

  it('leaves a title containing # alone when split resolution wins', () => {
    // A note titled `Sprint` exists, so `[[Sprint #4]]` always resolved to it,
    // never to the note named `Sprint #4` — the link is not ours to rewrite.
    const sprintExists = (title: string) => title === 'Sprint'
    expect(
      rewriteWikiLinksForRename('[[Sprint #4]]', 'Sprint #4', 'Sprint Four', sprintExists)
    ).toBeNull()
  })

  it('rewrites the note half of a heading link even when the raw string matches another rename', () => {
    // `[[Old#Notes]]` splits first: the note half is what carries the title.
    expect(rewriteWikiLinksForRename('[[Old#Notes]] and [[Old]]', 'Old', 'New', noOther)).toBe(
      '[[New#Notes]] and [[New]]'
    )
  })

  it('trims the target before matching', () => {
    expect(rewriteWikiLinksForRename('[[ Old ]]', 'Old', 'New', noOther)).toBe('[[New]]')
  })
})
