import { describe, expect, it } from 'vitest'
import { rewriteWikiLinksToNote } from './rewrite-wiki-links'

const noOther = () => false

/** A rename inside `Notes/`: title and path stem change together. */
function rename(
  body: string,
  from: string,
  to: string,
  other: (title: string) => boolean
): string | null {
  return rewriteWikiLinksToNote(
    body,
    { title: from, pathStem: `Notes/${from}` },
    { title: to, pathStem: `Notes/${to}` },
    other
  )
}

describe('rewriteWikiLinksToNote', () => {
  it('rewrites a plain link and leaves other links alone', () => {
    expect(rename('See [[Old Title]] and [[Other Note]].', 'Old Title', 'New Title', noOther)).toBe(
      'See [[New Title]] and [[Other Note]].'
    )
  })

  it('returns null when nothing matches', () => {
    expect(rename('See [[Other Note]].', 'Old Title', 'New Title', noOther)).toBeNull()
    expect(rename('no links here', 'Old Title', 'New Title', noOther)).toBeNull()
    expect(rename('', 'Old Title', 'New Title', noOther)).toBeNull()
  })

  it('returns null when old and new titles are identical', () => {
    expect(rename('[[Same]]', 'Same', 'Same', noOther)).toBeNull()
  })

  it('matches titles case-insensitively, same as resolveNoteByTitle', () => {
    expect(rename('[[old title]] and [[OLD TITLE]]', 'Old Title', 'New', noOther)).toBe(
      '[[New]] and [[New]]'
    )
  })

  it('rewrites a case-only rename', () => {
    expect(rename('[[old title]]', 'old title', 'Old Title', noOther)).toBe('[[Old Title]]')
  })

  it('keeps the alias untouched', () => {
    expect(rename('[[Old|my label]]', 'Old', 'New', noOther)).toBe('[[New|my label]]')
  })

  it('keeps the heading half, nested segments included', () => {
    expect(rename('[[Old#Heading]]', 'Old', 'New', noOther)).toBe('[[New#Heading]]')
    expect(rename('[[Old#H1#H2]]', 'Old', 'New', noOther)).toBe('[[New#H1#H2]]')
    expect(rename('[[Old#Heading|label]]', 'Old', 'New', noOther)).toBe('[[New#Heading|label]]')
  })

  it('never touches a same-note heading link', () => {
    expect(rename('[[#Heading]]', '#Heading', 'New', noOther)).toBeNull()
  })

  it('rewrites a title containing # when no other note claims the split half', () => {
    expect(rename('[[Sprint #4]]', 'Sprint #4', 'Sprint Four', noOther)).toBe('[[Sprint Four]]')
  })

  it('leaves a title containing # alone when split resolution wins', () => {
    // A note titled `Sprint` exists, so `[[Sprint #4]]` always resolved to it,
    // never to the note named `Sprint #4` — the link is not ours to rewrite.
    const sprintExists = (title: string) => title === 'Sprint'
    expect(rename('[[Sprint #4]]', 'Sprint #4', 'Sprint Four', sprintExists)).toBeNull()
  })

  it('rewrites the note half of a heading link even when the raw string matches another rename', () => {
    // `[[Old#Notes]]` splits first: the note half is what carries the title.
    expect(rename('[[Old#Notes]] and [[Old]]', 'Old', 'New', noOther)).toBe(
      '[[New#Notes]] and [[New]]'
    )
  })

  it('trims the target before matching', () => {
    expect(rename('[[ Old ]]', 'Old', 'New', noOther)).toBe('[[New]]')
  })

  it('rewrites path-form links on rename, keeping a leading slash, heading and alias', () => {
    expect(
      rename('[[Notes/Old]] [[/notes/old#H|label]] [[Other/Old]] [[Old]]', 'Old', 'New', noOther)
    ).toBe('[[Notes/New]] [[/Notes/New#H|label]] [[Other/Old]] [[New]]')
  })

  it('rewrites only path-form links when a note moves folders', () => {
    const move = (body: string): string | null =>
      rewriteWikiLinksToNote(
        body,
        { title: 'Plan', pathStem: 'A/Plan' },
        { title: 'Plan', pathStem: 'B/C/Plan' },
        noOther
      )
    expect(move('[[A/Plan#Goals|g]] and [[Plan]] and [[A/Planner]]')).toBe(
      '[[B/C/Plan#Goals|g]] and [[Plan]] and [[A/Planner]]'
    )
    expect(move('[[Plan]] only')).toBeNull()
  })
})
