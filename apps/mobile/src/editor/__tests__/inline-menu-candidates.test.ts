import { describe, expect, it } from 'vitest'
import type { VaultDb } from '../../db/index'
import {
  queryInlineMenuCandidates,
  queryMentionCandidates,
  queryTagCandidates
} from '../wiki-links'

/**
 * Host rows for the `#` and `@` inline menus (#2099).
 *
 * The fake routes on the SQL rather than answering every read the same way:
 * a tag row's colour comes from `tag_definition` and its name from the note
 * payloads, so a stub that cannot tell the two tables apart would pass while
 * the real query read the wrong one.
 */
interface Fixture {
  notes: { id: string; title: string; tags?: string[] }[]
  definitions?: { id: string; color?: string; icon?: string }[]
}

function db(fixture: Fixture): VaultDb {
  return {
    getAllAsync: async (sql: string) => {
      if (sql.includes('tag_definition')) {
        return (fixture.definitions ?? []).map((definition) => ({
          id: definition.id,
          payload: JSON.stringify({ color: definition.color, icon: definition.icon })
        }))
      }
      return fixture.notes.map((note) => ({
        id: note.id,
        payload: JSON.stringify({ title: note.title, folderPath: '', tags: note.tags ?? [] })
      }))
    },
    getFirstAsync: async () => null
  } as unknown as VaultDb
}

const VAULT: Fixture = {
  notes: [
    { id: 'n1', title: 'Roadmap review', tags: ['Roadmap', 'work/q3'] },
    { id: 'n2', title: 'Tokyo trip', tags: ['travel'] }
  ],
  definitions: [{ id: 'Roadmap', color: 'tangerine', icon: '🚀' }]
}

describe('queryTagCandidates', () => {
  it('lists every vault tag for an empty query', async () => {
    const rows = await queryTagCandidates(db(VAULT), '')

    expect(rows.map((row) => row.target)).toEqual(['Roadmap', 'travel', 'work/q3'])
    expect(rows.every((row) => row.kind === 'tag')).toBe(true)
  })

  it('carries the colour and icon the tag definition stores', async () => {
    const [row] = await queryTagCandidates(db(VAULT), 'road')

    expect(row).toMatchObject({ kind: 'tag', target: 'Roadmap', color: 'tangerine', icon: '🚀' })
  })

  it('leaves an uncoloured tag empty rather than inventing a colour', async () => {
    const [row] = await queryTagCandidates(db(VAULT), 'travel')

    expect(row).toMatchObject({ target: 'travel', color: '', icon: '' })
  })

  it('matches case-insensitively and keeps the stored casing', async () => {
    const [row] = await queryTagCandidates(db(VAULT), 'ROADMAP')

    expect(row.target).toBe('Roadmap')
  })

  it('offers a create row for an unknown tag', async () => {
    const rows = await queryTagCandidates(db(VAULT), 'newtag')

    expect(rows).toEqual([
      {
        kind: 'create',
        id: '',
        title: 'newtag',
        subtitle: 'Create tag',
        icon: '',
        target: 'newtag',
        alias: '',
        color: ''
      }
    ])
  })

  it('does not offer to create a tag that already exists in another casing', async () => {
    const rows = await queryTagCandidates(db(VAULT), 'roadmap')

    expect(rows.some((row) => row.kind === 'create')).toBe(false)
  })
})

describe('queryMentionCandidates', () => {
  it('lists notes, most recently touched first, for an empty query', async () => {
    const rows = await queryMentionCandidates(db(VAULT), '')

    expect(rows.map((row) => row.target)).toEqual(['Roadmap review', 'Tokyo trip'])
  })

  it('targets the note title, so accepting one writes a wiki link', async () => {
    const [row] = await queryMentionCandidates(db(VAULT), 'tokyo')

    expect(row).toMatchObject({ kind: 'note', target: 'Tokyo trip', alias: '' })
  })

  it('never offers to create a note — `@` points at what exists', async () => {
    const rows = await queryMentionCandidates(db(VAULT), 'nothing here')

    expect(rows).toEqual([])
  })
})

describe('queryInlineMenuCandidates', () => {
  it('routes each trigger to its own rows', async () => {
    const vault = db(VAULT)

    expect((await queryInlineMenuCandidates(vault, 'road', 'tag'))[0].kind).toBe('tag')
    expect((await queryInlineMenuCandidates(vault, 'tokyo', 'mention'))[0].kind).toBe('note')
    expect((await queryInlineMenuCandidates(vault, 'tokyo', 'wiki'))[0].kind).toBe('note')
  })
})
