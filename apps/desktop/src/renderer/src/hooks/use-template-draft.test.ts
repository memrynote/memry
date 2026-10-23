import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useTemplateDraft } from './use-template-draft'

const createTemplate = vi.fn()
const updateTemplate = vi.fn()
const toastError = vi.fn()

vi.mock('@/hooks/use-templates', () => ({
  useTemplates: () => ({ createTemplate, updateTemplate })
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: (...args: unknown[]) => toastError(...args) }
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() })
}))

const emptyFields = {
  name: '',
  icon: null,
  tags: [] as string[],
  properties: [],
  content: ''
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  createTemplate.mockResolvedValue({ id: 'tpl-1', name: 'X' })
  updateTemplate.mockResolvedValue({ id: 'tpl-1', name: 'X' })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useTemplateDraft', () => {
  it('starts as a clean draft with no id', () => {
    const { result } = renderHook(() => useTemplateDraft({ initial: emptyFields }))

    expect(result.current.state).toBe('draft')
    expect(result.current.isDirty).toBe(false)
    expect(result.current.canSave).toBe(false)
  })

  it('becomes dirty and saveable once a name is typed', () => {
    const { result } = renderHook(() => useTemplateDraft({ initial: emptyFields }))

    act(() => result.current.setFields({ name: 'Meeting' }))

    expect(result.current.isDirty).toBe(true)
    expect(result.current.canSave).toBe(true)
  })

  it('never auto-saves while in draft', () => {
    const { result } = renderHook(() => useTemplateDraft({ initial: emptyFields }))

    act(() => result.current.setFields({ name: 'Meeting' }))
    act(() => vi.advanceTimersByTime(5000))

    expect(createTemplate).not.toHaveBeenCalled()
  })

  it('save() on a draft creates and adopts the new id', async () => {
    const onCreated = vi.fn()
    const { result } = renderHook(() => useTemplateDraft({ initial: emptyFields, onCreated }))

    act(() => result.current.setFields({ name: '  Meeting  ' }))
    await act(async () => {
      await result.current.save()
    })

    expect(createTemplate).toHaveBeenCalledWith(expect.objectContaining({ name: 'Meeting' }))
    expect(onCreated).toHaveBeenCalledWith({ id: 'tpl-1', name: 'X' })
    expect(result.current.templateId).toBe('tpl-1')
    expect(result.current.state).toBe('saved')
    expect(result.current.isDirty).toBe(false)
  })

  it('auto-saves an existing template after the debounce', async () => {
    const { result } = renderHook(() =>
      useTemplateDraft({
        templateId: 'tpl-1',
        initial: { ...emptyFields, name: 'Meeting' }
      })
    )

    expect(result.current.state).toBe('saved')
    act(() => result.current.setFields({ content: 'hello' }))
    expect(result.current.state).toBe('dirty')

    await act(async () => {
      vi.advanceTimersByTime(800)
    })

    await waitFor(() => expect(updateTemplate).toHaveBeenCalledTimes(1))
    expect(updateTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tpl-1', content: 'hello' })
    )
  })

  it('coalesces rapid edits into one write', async () => {
    const { result } = renderHook(() =>
      useTemplateDraft({
        templateId: 'tpl-1',
        initial: { ...emptyFields, name: 'Meeting' }
      })
    )

    act(() => result.current.setFields({ content: 'a' }))
    act(() => vi.advanceTimersByTime(400))
    act(() => result.current.setFields({ content: 'ab' }))
    await act(async () => {
      vi.advanceTimersByTime(800)
    })

    await waitFor(() => expect(updateTemplate).toHaveBeenCalledTimes(1))
    expect(updateTemplate).toHaveBeenCalledWith(expect.objectContaining({ content: 'ab' }))
  })

  it('skips the write when the payload is unchanged', async () => {
    const { result } = renderHook(() =>
      useTemplateDraft({
        templateId: 'tpl-1',
        initial: { ...emptyFields, name: 'Meeting' }
      })
    )

    act(() => result.current.setFields({ content: 'a' }))
    act(() => result.current.setFields({ content: '' }))
    await act(async () => {
      vi.advanceTimersByTime(800)
    })

    expect(updateTemplate).not.toHaveBeenCalled()
    expect(result.current.isDirty).toBe(false)
  })

  it('keeps the tab dirty when a save fails', async () => {
    updateTemplate.mockResolvedValue(null)
    const { result } = renderHook(() =>
      useTemplateDraft({
        templateId: 'tpl-1',
        initial: { ...emptyFields, name: 'Meeting' }
      })
    )

    act(() => result.current.setFields({ content: 'hello' }))
    let saved: boolean | undefined
    await act(async () => {
      saved = await result.current.save()
    })

    expect(saved).toBe(false)
    expect(result.current.isDirty).toBe(true)
    expect(toastError).toHaveBeenCalled()
  })

  it('reports each successful update through onSaved', async () => {
    const onSaved = vi.fn()
    const { result } = renderHook(() =>
      useTemplateDraft({
        templateId: 'tpl-1',
        initial: { ...emptyFields, name: 'Meeting' },
        onSaved
      })
    )

    act(() => result.current.setFields({ content: 'hello' }))
    await act(async () => {
      await result.current.save()
    })

    expect(onSaved).toHaveBeenCalledWith({ id: 'tpl-1', name: 'X' })
  })

  it('runs writes one at a time', async () => {
    let release: (value: unknown) => void = () => {}
    updateTemplate.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
    const { result } = renderHook(() =>
      useTemplateDraft({
        templateId: 'tpl-1',
        initial: { ...emptyFields, name: 'Meeting' }
      })
    )

    act(() => result.current.setFields({ content: 'a' }))
    let first: Promise<boolean> = Promise.resolve(false)
    await act(async () => {
      first = result.current.save()
    })
    expect(updateTemplate).toHaveBeenCalledWith(expect.objectContaining({ content: 'a' }))
    act(() => result.current.setFields({ content: 'ab' }))
    let second: Promise<boolean> = Promise.resolve(false)
    act(() => {
      second = result.current.save()
    })
    await act(async () => {})

    expect(updateTemplate).toHaveBeenCalledTimes(1)

    await act(async () => {
      release({ id: 'tpl-1', name: 'X' })
      await first
      await second
    })

    expect(updateTemplate).toHaveBeenCalledTimes(2)
    expect(updateTemplate).toHaveBeenLastCalledWith(expect.objectContaining({ content: 'ab' }))
  })

  describe('unmount', () => {
    const existing = { templateId: 'tpl-flush', initial: { ...emptyFields, name: 'Meeting' } }

    it('flushes edits still inside the debounce instead of dropping them', async () => {
      const { result, unmount } = renderHook(() => useTemplateDraft(existing))

      act(() => result.current.setFields({ content: 'typed' }))
      unmount()
      await act(async () => {})

      expect(updateTemplate).toHaveBeenCalledTimes(1)
      expect(updateTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'tpl-flush', content: 'typed' })
      )
    })

    it('writes nothing when there is nothing pending', async () => {
      const { unmount } = renderHook(() => useTemplateDraft(existing))

      unmount()
      await act(async () => {})

      expect(updateTemplate).not.toHaveBeenCalled()
    })

    it('never writes an uncreated draft', async () => {
      const { result, unmount } = renderHook(() => useTemplateDraft({ initial: emptyFields }))

      act(() => result.current.setFields({ name: 'Meeting' }))
      unmount()
      await act(async () => {})

      expect(createTemplate).not.toHaveBeenCalled()
    })

    it('skips the flush after discard', async () => {
      const { result, unmount } = renderHook(() => useTemplateDraft(existing))

      act(() => result.current.setFields({ content: 'typed' }))
      act(() => result.current.discard())
      unmount()
      await act(async () => {})

      expect(updateTemplate).not.toHaveBeenCalled()
    })

    it('flushes again for the editor teardown edit that lands after unmount', async () => {
      const { result, unmount } = renderHook(() => useTemplateDraft(existing))
      const { setFields } = result.current

      act(() => setFields({ content: 'typ' }))
      unmount()
      setFields({ content: 'typed' })
      await act(async () => {})

      expect(updateTemplate).toHaveBeenLastCalledWith(expect.objectContaining({ content: 'typed' }))
    })

    it('restores edits whose flush failed, and retries them', async () => {
      updateTemplate.mockResolvedValueOnce(null)
      const first = renderHook(() => useTemplateDraft(existing))

      act(() => first.result.current.setFields({ content: 'typed' }))
      first.unmount()
      await act(async () => {})
      expect(toastError).toHaveBeenCalled()

      const second = renderHook(() => useTemplateDraft(existing))
      expect(second.result.current.fields.content).toBe('typed')
      expect(second.result.current.mountedFields.content).toBe('typed')
      expect(second.result.current.isDirty).toBe(true)

      await act(async () => {
        vi.advanceTimersByTime(800)
      })
      await waitFor(() => expect(updateTemplate).toHaveBeenCalledTimes(2))
      expect(updateTemplate).toHaveBeenLastCalledWith(expect.objectContaining({ content: 'typed' }))
      second.unmount()
    })

    it('restores edits when the tab comes back before the flush lands', async () => {
      let release: (value: unknown) => void = () => {}
      updateTemplate.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
      const first = renderHook(() => useTemplateDraft(existing))

      act(() => first.result.current.setFields({ content: 'typed' }))
      first.unmount()
      await act(async () => {})

      const second = renderHook(() => useTemplateDraft(existing))
      expect(second.result.current.fields.content).toBe('typed')

      await act(async () => {
        release({ id: 'tpl-flush', name: 'X' })
      })
      second.unmount()
    })

    it('forgets flushed edits once they are written', async () => {
      const first = renderHook(() => useTemplateDraft(existing))

      act(() => first.result.current.setFields({ content: 'typed' }))
      first.unmount()
      await act(async () => {})

      const second = renderHook(() => useTemplateDraft(existing))
      expect(second.result.current.fields.content).toBe('')
      second.unmount()
    })
  })

  it('refuses to save a blank name', async () => {
    const { result } = renderHook(() => useTemplateDraft({ initial: emptyFields }))

    let saved: boolean | undefined
    await act(async () => {
      saved = await result.current.save()
    })

    expect(saved).toBe(false)
    expect(createTemplate).not.toHaveBeenCalled()
  })
})
