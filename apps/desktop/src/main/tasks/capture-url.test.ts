import { describe, it, expect, vi } from 'vitest'
import { captureUrlToProject, titleFromUrl, type CaptureUrlDeps } from './capture-url'

const makeDeps = (overrides: Partial<CaptureUrlDeps> = {}): CaptureUrlDeps => ({
  fetchTitle: vi.fn(async () => 'CRDT survey'),
  createNote: vi.fn(async () => ({ id: 'note-1' })),
  linkToProject: vi.fn(),
  ...overrides
})

describe('captureUrlToProject', () => {
  it('creates a note titled from the page and links it to the project', async () => {
    const deps = makeDeps()

    const result = await captureUrlToProject(deps, {
      projectId: 'p1',
      url: 'https://example.com/a'
    })

    expect(result).toEqual({ success: true, noteId: 'note-1' })
    expect(deps.createNote).toHaveBeenCalledWith(expect.objectContaining({ title: 'CRDT survey' }))
    expect(deps.linkToProject).toHaveBeenCalledWith('p1', 'note-1')
  })

  it('falls back to the url when metadata is unavailable', async () => {
    const deps = makeDeps({
      fetchTitle: vi.fn(async () => {
        throw new Error('offline')
      })
    })

    const result = await captureUrlToProject(deps, {
      projectId: 'p1',
      url: 'https://example.com/a'
    })

    expect(result.success).toBe(true)
    expect(deps.createNote).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'example.com/a' })
    )
  })

  it('falls back when the page returns an empty title', async () => {
    const deps = makeDeps({ fetchTitle: vi.fn(async () => '   ') })

    await captureUrlToProject(deps, { projectId: 'p1', url: 'https://example.com' })

    expect(deps.createNote).toHaveBeenCalledWith(expect.objectContaining({ title: 'example.com' }))
  })

  it('does not link anything when the note cannot be created', async () => {
    const deps = makeDeps({ createNote: vi.fn(async () => null) })

    const result = await captureUrlToProject(deps, { projectId: 'p1', url: 'https://x.com' })

    expect(result.success).toBe(false)
    expect(deps.linkToProject).not.toHaveBeenCalled()
  })

  it('writes the url into the note body as a markdown link', async () => {
    const deps = makeDeps()

    await captureUrlToProject(deps, { projectId: 'p1', url: 'https://example.com/a' })

    expect(deps.createNote).toHaveBeenCalledWith(
      expect.objectContaining({ content: '[CRDT survey](https://example.com/a)\n' })
    )
  })
})

describe('titleFromUrl', () => {
  it('drops the scheme and trailing slash', () => {
    expect(titleFromUrl('https://example.com/')).toBe('example.com')
    expect(titleFromUrl('https://example.com/docs/spec')).toBe('example.com/docs/spec')
  })

  it('returns the input when it is not a valid url', () => {
    expect(titleFromUrl('not a url')).toBe('not a url')
  })
})
