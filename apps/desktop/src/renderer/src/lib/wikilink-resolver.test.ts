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
        icon: 'file-text'
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
        icon: 'file-text'
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
        icon: 'file-text'
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
        icon: 'file-image'
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
        icon
      })
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
