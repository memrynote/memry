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
    expect(onCreated).toHaveBeenCalledWith('tpl-1')
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
