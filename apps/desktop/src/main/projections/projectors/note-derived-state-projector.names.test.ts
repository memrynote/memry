import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotesChannels } from '@memry/contracts/ipc-channels'
import { createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { getOutgoingLinks } from '@main/database/queries/notes'
import type { MarkdownNoteProjection } from '../types'

const getIndexDatabase = vi.hoisted(() => vi.fn())
const broadcastToAllWindows = vi.hoisted(() => vi.fn())

vi.mock('../../database', () => ({ getIndexDatabase }))
vi.mock('../../lib/window-broadcast', () => ({ broadcastToAllWindows }))

import { createNoteDerivedStateProjector } from './note-derived-state-projector'

describe('note names drive wiki-link resolution', () => {
  let indexDb: TestDatabaseResult
  const projector = createNoteDerivedStateProjector(() => null)

  beforeEach(() => {
    indexDb = createTestIndexDb()
    getIndexDatabase.mockReturnValue(indexDb.db)
  })

  afterEach(() => {
    indexDb.close()
    vi.clearAllMocks()
  })

  async function upsert(
    noteId: string,
    title: string,
    options: { aliases?: string[] | null; links?: string[]; path?: string } = {}
  ): Promise<void> {
    const note: MarkdownNoteProjection = {
      kind: 'markdown',
      noteId,
      path: options.path ?? `${title}.md`,
      title,
      fileType: 'markdown',
      localOnly: false,
      contentHash: `hash-${noteId}`,
      wordCount: 1,
      characterCount: 1,
      snippet: '',
      date: null,
      emoji: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-02T00:00:00.000Z',
      parsedContent: '',
      tags: [],
      headerTags: [],
      properties: {},
      aliases: options.aliases === undefined ? [] : options.aliases,
      wikiLinks: options.links ?? []
    }
    await projector.project({ type: 'note.upserted', note })
  }

  function targetOf(sourceId: string, title: string): string | null | undefined {
    return getOutgoingLinks(indexDb.db, sourceId).find((link) => link.targetTitle === title)
      ?.targetId
  }

  it('resolves a link written before the alias, and drops it when the alias goes', async () => {
    await upsert('n-src', 'Source', { links: ['K.'] })
    await upsert('n-kaan', 'Kaan')
    expect(targetOf('n-src', 'K.')).toBeNull()

    await upsert('n-kaan', 'Kaan', { aliases: ['K.'] })
    expect(targetOf('n-src', 'K.')).toBe('n-kaan')
    expect(broadcastToAllWindows).toHaveBeenCalledWith(NotesChannels.events.LINKS_CHANGED, {
      sourceIds: ['n-src'],
      targetIds: ['n-kaan']
    })

    await upsert('n-kaan', 'Kaan', { aliases: [] })
    expect(targetOf('n-src', 'K.')).toBeNull()
  })

  it('keeps indexed aliases when the frontmatter was not read', async () => {
    await upsert('n-src', 'Source', { links: ['K.'] })
    await upsert('n-kaan', 'Kaan', { aliases: ['K.'] })
    await upsert('n-kaan', 'Kaan', { aliases: null })
    expect(targetOf('n-src', 'K.')).toBe('n-kaan')
  })

  it('hands a link from an alias holder to a note created with that title', async () => {
    await upsert('n-src', 'Source', { links: ['Plan'] })
    await upsert('n-roadmap', 'Roadmap', { aliases: ['Plan'] })
    expect(targetOf('n-src', 'Plan')).toBe('n-roadmap')

    await upsert('n-plan', 'Plan')
    expect(targetOf('n-src', 'Plan')).toBe('n-plan')
  })

  it('gives a shared alias to the lowest id, and to the other holder after a delete', async () => {
    await upsert('n-src', 'Source', { links: ['team'] })
    await upsert('n-b', 'Shared B', { aliases: ['Team'] })
    await upsert('n-a', 'Shared A', { aliases: ['TEAM'] })
    expect(targetOf('n-src', 'team')).toBe('n-a')

    await projector.project({ type: 'note.deleted', noteId: 'n-a' })
    expect(targetOf('n-src', 'team')).toBe('n-b')

    await projector.project({ type: 'note.deleted', noteId: 'n-b' })
    expect(targetOf('n-src', 'team')).toBeNull()
  })

  it('moves title links with a rename and leaves alias links on the note', async () => {
    await upsert('n-src', 'Source', { links: ['Old', 'New', 'K.'] })
    await upsert('n-note', 'Old', { aliases: ['K.'], path: 'note.md' })
    expect(['Old', 'New', 'K.'].map((title) => targetOf('n-src', title))).toEqual([
      'n-note',
      null,
      'n-note'
    ])

    await upsert('n-note', 'New', { aliases: ['K.'], path: 'note.md' })
    expect(['Old', 'New', 'K.'].map((title) => targetOf('n-src', title))).toEqual([
      null,
      'n-note',
      'n-note'
    ])
  })

  it('answers path links at a note created or moved to that path', async () => {
    await upsert('n-src', 'Source', { links: ['new/idea', '/New/Idea.md', 'Other/Idea'] })
    await upsert('n-idea', 'Idea', { path: 'New/Idea.md' })
    expect(
      ['new/idea', '/New/Idea.md', 'Other/Idea'].map((title) => targetOf('n-src', title))
    ).toEqual(['n-idea', 'n-idea', null])

    await upsert('n-idea', 'Idea', { path: 'Other/Idea.md' })
    expect(
      ['new/idea', '/New/Idea.md', 'Other/Idea'].map((title) => targetOf('n-src', title))
    ).toEqual([null, null, 'n-idea'])
  })
})
