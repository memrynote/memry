import { describe, expect, it } from 'vitest'
import type { VaultDb } from '../../db/index'
import { queryWikiCandidates } from '../wiki-links'

interface Note {
  id: string
  title: string
  folderPath?: string
  markdown?: string
  icon?: string
}

function db(notes: Note[]): VaultDb {
  return {
    getAllAsync: async () =>
      notes.map((note) => ({
        id: note.id,
        payload: JSON.stringify({
          title: note.title,
          folderPath: note.folderPath ?? '',
          icon: note.icon ?? null
        })
      })),
    getFirstAsync: async (_sql: string, params: unknown[]) => {
      const note = notes.find((candidate) => candidate.id === params[0])
      return note?.markdown === undefined ? null : { markdown: note.markdown }
    }
  } as unknown as VaultDb
}

const NOTES: Note[] = [
  {
    id: 'n1',
    title: 'Toplantı',
    folderPath: 'Work',
    icon: '📌',
    markdown: '# Kararlar\n\n## **Takip**\n'
  },
  { id: 'n2', title: 'Tokyo trip' },
  { id: 'n3', title: 'Sprint #4' }
]

describe('queryWikiCandidates', () => {
  it('lists the most recent notes for an empty query', async () => {
    const rows = await queryWikiCandidates(db(NOTES), '')
    expect(rows.map((row) => row.title)).toEqual(['Toplantı', 'Tokyo trip', 'Sprint #4'])
    expect(rows.every((row) => row.kind === 'note')).toBe(true)
  })

  it('carries the folder path as the row subtitle', async () => {
    const [first] = await queryWikiCandidates(db(NOTES), 'Toplantı')
    expect(first).toMatchObject({ target: 'Toplantı', subtitle: 'Work', alias: '', icon: '📌' })
  })

  it('drops icon values the WebView cannot draw', async () => {
    const named = await queryWikiCandidates(
      db([{ id: 'a', title: 'A', icon: 'icon:folder-01' }]),
      ''
    )
    const custom = await queryWikiCandidates(db([{ id: 'b', title: 'B', icon: 'custom:zz' }]), '')
    expect([named[0]?.icon, custom[0]?.icon]).toEqual(['', ''])
  })

  it('ranks prefix hits above substring hits', async () => {
    const rows = await queryWikiCandidates(db([{ id: 'a', title: 'My tokyo' }, ...NOTES]), 'tok')
    expect(rows.map((row) => row.title).slice(0, 2)).toEqual(['Tokyo trip', 'My tokyo'])
  })

  it('offers creation only when the typed target names no note', async () => {
    const missing = await queryWikiCandidates(db(NOTES), 'Berlin')
    expect(missing.at(-1)).toMatchObject({ kind: 'create', target: 'Berlin' })

    const exact = await queryWikiCandidates(db(NOTES), 'tokyo trip')
    expect(exact.some((row) => row.kind === 'create')).toBe(false)
  })

  it('switches to headings only once the note half matches a title exactly', async () => {
    const partial = await queryWikiCandidates(db(NOTES), 'Topl#')
    expect(partial.every((row) => row.kind !== 'heading')).toBe(true)

    const headings = await queryWikiCandidates(db(NOTES), 'Toplantı#')
    expect(headings).toEqual([
      {
        kind: 'heading',
        id: 'n1',
        title: 'Kararlar',
        subtitle: '',
        icon: '',
        target: 'Toplantı#Kararlar',
        alias: 'Kararlar',
        headingLevel: 1
      },
      {
        kind: 'heading',
        id: 'n1',
        title: 'Takip',
        subtitle: '',
        icon: '',
        target: 'Toplantı#Takip',
        alias: 'Takip',
        headingLevel: 2
      }
    ])
  })

  it('keeps a note whose own title contains a hash reachable', async () => {
    const rows = await queryWikiCandidates(db(NOTES), 'Sprint #4')
    expect(rows[0]).toMatchObject({ kind: 'note', target: 'Sprint #4' })
  })

  it('filters headings and keeps an unselectable row when none match', async () => {
    const rows = await queryWikiCandidates(db(NOTES), 'Toplantı#zzz')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'empty', target: '' })
  })

  it('collapses to a single alias row after a pipe', async () => {
    const rows = await queryWikiCandidates(db(NOTES), 'Tokyo trip|the trip')
    expect(rows).toEqual([
      {
        kind: 'alias',
        id: 'n2',
        title: 'the trip',
        subtitle: 'Tokyo trip',
        icon: '',
        target: 'Tokyo trip',
        alias: 'the trip'
      }
    ])
  })

  it('offers nothing for a pipe with no label yet', async () => {
    expect(await queryWikiCandidates(db(NOTES), 'Tokyo trip|')).toEqual([])
  })
})
