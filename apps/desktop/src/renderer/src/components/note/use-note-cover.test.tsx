/**
 * `useNoteCover` is the only writer of the `cover` frontmatter key.
 *
 * What it hands `notesService.update` is what lands in the vault file, so the
 * tests watch the exact payload: the ref verbatim on set, and `null` — not
 * `undefined`, which a spread merge would swallow — on every key it clears.
 */

import { renderHook, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

vi.mock('@/services/notes-service', () => ({
  notesService: { update: mocks.update }
}))

import { useNoteCover } from './use-note-cover'

const NOTE_ID = 'nte_9f2c1a'
const COVER_REF = `../attachments/${NOTE_ID}/abc123-photo.jpg`
const IMAGE_COVER = { kind: 'image', ref: COVER_REF } as const
/** Set and remove both clear the framing and attribution of the outgoing photo. */
const CLEARED = { coverFocus: null, coverCredit: null, coverCreditUrl: null }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.update.mockResolvedValue({ success: true })
})

function renderUseNoteCover(noteId: string | null = NOTE_ID) {
  const onSaved = vi.fn()
  const { result } = renderHook(() => useNoteCover(noteId, onSaved))
  return { result, onSaved }
}

describe('useNoteCover', () => {
  it('writes the ref verbatim and refreshes the note', async () => {
    const { result, onSaved } = renderUseNoteCover()

    await act(() => result.current.setCover(IMAGE_COVER))

    expect(mocks.update).toHaveBeenCalledWith({
      id: NOTE_ID,
      frontmatter: { cover: COVER_REF, ...CLEARED }
    })
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('writes a wash as its wash:<id> ref', async () => {
    const { result } = renderUseNoteCover()

    await act(() => result.current.setCover({ kind: 'wash', id: 'sage' }))

    expect(mocks.update).toHaveBeenCalledWith({
      id: NOTE_ID,
      frontmatter: { cover: 'wash:sage', ...CLEARED }
    })
  })

  it('clamps the focus before it reaches the vault', async () => {
    const { result } = renderUseNoteCover()

    await act(() => result.current.setCoverFocus(140.6))

    expect(mocks.update).toHaveBeenCalledWith({ id: NOTE_ID, frontmatter: { coverFocus: 100 } })
  })

  it('removes with the null delete sentinel rather than undefined', async () => {
    const { result, onSaved } = renderUseNoteCover()

    await act(() => result.current.removeCover())

    expect(mocks.update).toHaveBeenCalledWith({
      id: NOTE_ID,
      frontmatter: { cover: null, ...CLEARED }
    })
    const [payload] = mocks.update.mock.calls[0] as [{ frontmatter: Record<string, unknown> }]
    expect('cover' in payload.frontmatter).toBe(true)
    expect(payload.frontmatter.cover).not.toBeUndefined()
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it('reports a failed set through a toast instead of throwing', async () => {
    mocks.update.mockRejectedValue(new Error('disk full'))
    const { result, onSaved } = renderUseNoteCover()

    await act(() => result.current.setCover(IMAGE_COVER))

    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    expect(mocks.toastError.mock.calls[0][0]).toBe('disk full')
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('reports a failed remove through a toast instead of throwing', async () => {
    mocks.update.mockRejectedValue(new Error('disk full'))
    const { result, onSaved } = renderUseNoteCover()

    await act(() => result.current.removeCover())

    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('does nothing at all without a note id', async () => {
    const { result, onSaved } = renderUseNoteCover(null)

    await act(() => result.current.setCover(IMAGE_COVER))
    await act(() => result.current.setCoverFocus(20))
    await act(() => result.current.removeCover())

    expect(mocks.update).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()
  })
})
