import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createScenePersister, type ScenePersisterOptions } from './canvas-persistence'

const DEBOUNCE_MS = 800

function makePersister(overrides: Partial<ScenePersisterOptions> = {}) {
  const save = vi.fn<(scene: string) => Promise<void>>().mockResolvedValue(undefined)
  const serialize = vi.fn<() => string | null>().mockReturnValue('scene-1')
  const onError = vi.fn()
  const persister = createScenePersister({
    serialize,
    save,
    debounceMs: DEBOUNCE_MS,
    lastSavedScene: '',
    onError,
    ...overrides
  })
  return { persister, save, serialize, onError }
}

describe('createScenePersister', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('debounces rapid changes into a single save with the latest scene', async () => {
    const { persister, save, serialize } = makePersister()

    persister.notifyChange()
    vi.advanceTimersByTime(DEBOUNCE_MS - 1)
    persister.notifyChange()
    vi.advanceTimersByTime(DEBOUNCE_MS - 1)
    persister.notifyChange()
    expect(save).not.toHaveBeenCalled()
    // Serialization only happens when a save actually runs (onChange fires per
    // pan frame — serializing there would be per-frame work).
    expect(serialize).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith('scene-1')
  })

  it('skips the save when the serialized scene equals the last saved one (pan/zoom-only)', async () => {
    const { persister, save } = makePersister({
      serialize: () => 'unchanged',
      lastSavedScene: 'unchanged'
    })

    persister.notifyChange()
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(save).not.toHaveBeenCalled()
  })

  it('updates the dedupe baseline after a save', async () => {
    const { persister, save } = makePersister({ serialize: () => 'scene-2' })

    persister.notifyChange()
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(save).toHaveBeenCalledTimes(1)

    persister.notifyChange()
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('flush cancels the timer and saves immediately', async () => {
    const { persister, save } = makePersister()

    persister.notifyChange()
    expect(persister.hasPendingChange()).toBe(true)
    await persister.flush()

    expect(save).toHaveBeenCalledTimes(1)
    expect(persister.hasPendingChange()).toBe(false)

    // Timer was cancelled — nothing fires later.
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('flush is a no-op when nothing changed', async () => {
    const { persister, save } = makePersister({
      serialize: () => 'same',
      lastSavedScene: 'same'
    })

    await persister.flush()
    expect(save).not.toHaveBeenCalled()
  })

  it('skips the save when serialize returns null (editor not readable)', async () => {
    const { persister, save } = makePersister({ serialize: () => null })

    persister.notifyChange()
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(save).not.toHaveBeenCalled()
  })

  it('reports save failures and retries on the next flush', async () => {
    const failure = new Error('ipc down')
    const save = vi
      .fn<(scene: string) => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined)
    const { persister, onError } = makePersister({ save })

    persister.notifyChange()
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(onError).toHaveBeenCalledWith(failure)

    // Baseline did not advance, so the retry writes the same scene.
    await persister.flush()
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith('scene-1')
  })

  it('hasPendingChange reflects the debounce window', async () => {
    const { persister } = makePersister()

    expect(persister.hasPendingChange()).toBe(false)
    persister.notifyChange()
    expect(persister.hasPendingChange()).toBe(true)
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(persister.hasPendingChange()).toBe(false)
  })
})
