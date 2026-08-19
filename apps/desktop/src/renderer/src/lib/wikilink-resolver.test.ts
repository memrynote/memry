import { describe, it, expect, beforeEach, vi } from 'vitest'
import { notesService } from '@/services/notes-service'
import { resolveWikiLink, hasFileExtension } from './wikilink-resolver'

vi.mock('@/services/notes-service', () => ({
  notesService: {
    resolveByTitle: vi.fn()
  }
}))

describe('wikilink-resolver', () => {
  const resolveByTitle = vi.mocked(notesService.resolveByTitle)

  beforeEach(() => {
    resolveByTitle.mockReset()
  })

  describe('resolveWikiLink', () => {
    it('returns not-found for empty targets', async () => {
      resolveByTitle.mockResolvedValue(null)

      const result = await resolveWikiLink('   ')

      expect(resolveByTitle).not.toHaveBeenCalled()
      expect(result).toEqual({
        type: 'not-found',
        id: '',
        title: '   ',
        fileType: 'markdown',
        icon: 'file-text',
        heading: null
      })
    })

    it('creates new note when no match and no extension', async () => {
      resolveByTitle.mockResolvedValue(null)

      const result = await resolveWikiLink('  New Note  ')

      expect(resolveByTitle).toHaveBeenCalledWith('New Note')
      expect(result).toEqual({
        type: 'create',
        id: '',
        title: 'New Note',
        fileType: 'markdown',
        icon: 'file-text',
        heading: null
      })
    })

    it('returns note when markdown match is found', async () => {
      resolveByTitle.mockResolvedValue({
        id: 'note-1',
        path: 'Daily Note.md',
        title: 'Daily Note',
        fileType: 'markdown'
      })

      const result = await resolveWikiLink('Daily Note')

      expect(result).toEqual({
        type: 'note',
        id: 'note-1',
        title: 'Daily Note',
        fileType: 'markdown',
        icon: 'file-text',
        heading: null
      })
    })

    it('returns file when non-markdown match is found', async () => {
      resolveByTitle.mockResolvedValue({
        id: 'file-1',
        path: 'media/Cover Image.png',
        title: 'Cover Image',
        fileType: 'image'
      })

      const result = await resolveWikiLink('Cover Image')

      expect(result).toEqual({
        type: 'file',
        id: 'file-1',
        title: 'Cover Image',
        fileType: 'image',
        icon: 'file-image',
        heading: null
      })
    })

    it.each([
      ['photo.png', 'image', 'file-image'],
      ['song.mp3', 'audio', 'file-audio'],
      ['movie.mp4', 'video', 'file-video'],
      ['spec.pdf', 'pdf', 'file-pdf']
    ])('returns not-found for missing %s file', async (target, fileType, icon) => {
      resolveByTitle.mockResolvedValue(null)

      const result = await resolveWikiLink(target)

      expect(resolveByTitle).toHaveBeenCalledWith(target)
      expect(result).toEqual({
        type: 'not-found',
        id: '',
        title: target,
        fileType,
        icon,
        heading: null
      })
    })
  })

  // A15. Every case here used to end in `type: 'create'` with the whole
  // `Note#Heading` string as the title, which wrote a real file into the vault.
  describe('resolveWikiLink with a heading', () => {
    const meeting = {
      id: 'note-1',
      path: 'Meeting.md',
      title: 'Meeting',
      fileType: 'markdown' as const
    }

    it('resolves the note half and reports the heading', async () => {
      resolveByTitle.mockImplementation(async (title) => (title === 'Meeting' ? meeting : null))

      const result = await resolveWikiLink('Meeting#Decisions')

      expect(result).toEqual({
        type: 'note',
        id: 'note-1',
        title: 'Meeting',
        fileType: 'markdown',
        icon: 'file-text',
        heading: 'Decisions'
      })
    })

    it('looks the note half up BEFORE the raw string', async () => {
      // Both exist: the junk note this bug created, and the real note. The
      // real one has to win, or the fix does nothing for the people it hurt.
      resolveByTitle.mockImplementation(async (title) =>
        title === 'Meeting'
          ? meeting
          : {
              id: 'junk-1',
              path: 'Meeting#Decisions.md',
              title: 'Meeting#Decisions',
              fileType: 'markdown' as const
            }
      )

      const result = await resolveWikiLink('Meeting#Decisions')

      expect(result.id).toBe('note-1')
      expect(result.heading).toBe('Decisions')
    })

    it('falls back to the raw title when the note half misses', async () => {
      // `#` is legal in a filename, so `Sprint #4` may be a note somebody has.
      resolveByTitle.mockImplementation(async (title) =>
        title === 'Sprint #4'
          ? {
              id: 'note-2',
              path: 'Sprint #4.md',
              title: 'Sprint #4',
              fileType: 'markdown' as const
            }
          : null
      )

      const result = await resolveWikiLink('Sprint #4')

      expect(result).toEqual({
        type: 'note',
        id: 'note-2',
        title: 'Sprint #4',
        fileType: 'markdown',
        icon: 'file-text',
        // The `#` was part of the name, so it names no heading to scroll to.
        heading: null
      })
    })

    it('takes the last segment of a nested heading path', async () => {
      resolveByTitle.mockImplementation(async (title) => (title === 'Meeting' ? meeting : null))

      const result = await resolveWikiLink('Meeting#Q3#Decisions')

      expect(result.heading).toBe('Decisions')
    })

    it('opens the note at the top for a block reference, and creates nothing', async () => {
      resolveByTitle.mockImplementation(async (title) => (title === 'Meeting' ? meeting : null))

      const result = await resolveWikiLink('Meeting#^abc123')

      expect(result.type).toBe('note')
      expect(result.id).toBe('note-1')
      expect(result.heading).toBeNull()
    })

    it('creates the NOTE half when nothing matches, never the raw target', async () => {
      resolveByTitle.mockResolvedValue(null)

      const result = await resolveWikiLink('Meeting#Decisions')

      expect(result).toEqual({
        type: 'create',
        id: '',
        title: 'Meeting',
        fileType: 'markdown',
        icon: 'file-text',
        heading: 'Decisions'
      })
    })

    it('does not look up a same-note link', async () => {
      resolveByTitle.mockResolvedValue(null)

      const result = await resolveWikiLink('#Decisions')

      expect(resolveByTitle).not.toHaveBeenCalled()
      expect(result.type).toBe('not-found')
      expect(result.heading).toBe('Decisions')
    })
  })

  describe('hasFileExtension', () => {
    it('returns true for supported file extensions', () => {
      expect(hasFileExtension('photo.PNG')).toBe(true)
      expect(hasFileExtension('song.mp3')).toBe(true)
    })

    it('returns false when no supported extension exists', () => {
      expect(hasFileExtension('Meeting Notes')).toBe(false)
      expect(hasFileExtension('archive.tar.gz')).toBe(false)
    })
  })
})
