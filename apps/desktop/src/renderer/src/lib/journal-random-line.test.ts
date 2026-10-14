import { describe, expect, it } from 'vitest'
import { noteLines, resolveRandomLines } from './journal-random-line'

const AFFIRMATIONS = '# Affirmations\n\n- I am calm\n- [ ] I am kind\n\n1. I am brave\n'

const notes: Record<string, string> = { Affirmations: AFFIRMATIONS, Empty: '# Only a heading\n' }
const readNote = async (title: string): Promise<string | null> => notes[title] ?? null

describe('noteLines', () => {
  it('drops blanks and headings and strips list markers', () => {
    expect(noteLines(AFFIRMATIONS)).toEqual(['I am calm', 'I am kind', 'I am brave'])
  })
})

describe('resolveRandomLines', () => {
  it('replaces the token with the line the random draw picks', async () => {
    const content = 'Today: {{random-line:Affirmations}}'
    expect(await resolveRandomLines(content, readNote, () => 0)).toBe('Today: I am calm')
    expect(await resolveRandomLines(content, readNote, () => 0.99)).toBe('Today: I am brave')
  })

  it('keeps the token when the note is missing or has no lines', async () => {
    const content = '{{random-line:Nope}} {{random-line:Empty}}'
    expect(await resolveRandomLines(content, readNote)).toBe(content)
  })

  it('leaves content without the token untouched', async () => {
    const content = '# {{date}} {{title}} {{time}}'
    expect(await resolveRandomLines(content, readNote)).toBe(content)
  })
})
