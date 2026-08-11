import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  computeSceneSignature,
  createScenePersister,
  type SceneSignatureInput,
  type ScenePersisterOptions
} from './canvas-persistence'

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

  describe('signature gate', () => {
    it('skips the full serialize once the signature is known to match disk', async () => {
      let signature = 'sig-1'
      const serialize = vi.fn<() => string | null>(() => `scene-${signature}`)
      const { persister, save } = makePersister({ signature: () => signature, serialize })

      // First fire has no baseline signature yet, so it serializes and saves.
      persister.notifyChange()
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      expect(serialize).toHaveBeenCalledTimes(1)
      expect(save).toHaveBeenCalledTimes(1)

      // Pan/zoom: onChange fires but nothing that reaches the scene moved, so
      // the serialize (multi-MB with inline images) must not run at all.
      persister.notifyChange()
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      persister.notifyChange()
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      expect(serialize).toHaveBeenCalledTimes(1)
      expect(save).toHaveBeenCalledTimes(1)

      // A real edit moves the signature and must reach disk.
      signature = 'sig-2'
      persister.notifyChange()
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      expect(serialize).toHaveBeenCalledTimes(2)
      expect(save).toHaveBeenCalledTimes(2)
      expect(save).toHaveBeenLastCalledWith('scene-sig-2')
    })

    it('advances the signature baseline on a dedupe hit (scene already on disk)', async () => {
      const serialize = vi.fn<() => string | null>(() => 'stored')
      const { persister, save } = makePersister({
        signature: () => 'sig-1',
        serialize,
        lastSavedScene: 'stored'
      })

      persister.notifyChange()
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      expect(serialize).toHaveBeenCalledTimes(1)
      expect(save).not.toHaveBeenCalled()

      // Baseline now matches disk, so further viewport churn is free.
      persister.notifyChange()
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      expect(serialize).toHaveBeenCalledTimes(1)
    })

    it('always serializes when the signature cannot be computed', async () => {
      const serialize = vi.fn<() => string | null>(() => 'scene-1')
      const { persister, save } = makePersister({ signature: () => null, serialize })

      persister.notifyChange()
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      await persister.flush()
      // "Unknown" must never be read as "unchanged": both fires serialize, and
      // the exact string compare stays the only thing that skips a write.
      expect(serialize).toHaveBeenCalledTimes(2)
      expect(save).toHaveBeenCalledTimes(1)
    })

    it('does not swallow the retry of a failed save even though the signature is unchanged', async () => {
      const failure = new Error('ipc down')
      const save = vi
        .fn<(scene: string) => Promise<void>>()
        .mockRejectedValueOnce(failure)
        .mockResolvedValue(undefined)
      const { persister, onError } = makePersister({ save, signature: () => 'sig-1' })

      persister.notifyChange()
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      expect(onError).toHaveBeenCalledWith(failure)

      // The signature baseline only advances once the scene is on disk, so the
      // gate cannot turn a failed save into a permanently skipped one.
      await persister.flush()
      expect(save).toHaveBeenCalledTimes(2)
      expect(save).toHaveBeenLastCalledWith('scene-1')
    })

    it('flushes a pending edit that lands immediately before teardown', async () => {
      let signature = 'sig-1'
      const { persister, save } = makePersister({
        signature: () => signature,
        serialize: () => `scene-${signature}`
      })

      persister.notifyChange()
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      expect(save).toHaveBeenCalledTimes(1)

      // Tab switch / close: the last stroke lands and the flush runs inside the
      // debounce window, well before the gate has seen the new signature.
      signature = 'sig-2'
      persister.notifyChange()
      await persister.flush()
      expect(save).toHaveBeenCalledTimes(2)
      expect(save).toHaveBeenLastCalledWith('scene-sig-2')
    })
  })
})

describe('computeSceneSignature', () => {
  const base: SceneSignatureInput = {
    elements: [
      { id: 'a', version: 3, versionNonce: 11 },
      { id: 'b', version: 7, versionNonce: 22 }
    ],
    files: { 'file-1': {} },
    appStateJson: '{"appState":{"viewBackgroundColor":"#fff"}}'
  }

  it('is stable for an unchanged scene', () => {
    expect(computeSceneSignature(base)).toBe(computeSceneSignature({ ...base }))
  })

  it('changes when an element is mutated (version bump)', () => {
    expect(
      computeSceneSignature({
        ...base,
        elements: [{ id: 'a', version: 4, versionNonce: 99 }, base.elements[1]]
      })
    ).not.toBe(computeSceneSignature(base))
  })

  it('changes when an element is added or removed', () => {
    expect(computeSceneSignature({ ...base, elements: [base.elements[0]] })).not.toBe(
      computeSceneSignature(base)
    )
    expect(
      computeSceneSignature({
        ...base,
        elements: [...base.elements, { id: 'c', version: 1, versionNonce: 33 }]
      })
    ).not.toBe(computeSceneSignature(base))
  })

  it('changes when elements are reordered (z-order is serialized)', () => {
    expect(
      computeSceneSignature({ ...base, elements: [base.elements[1], base.elements[0]] })
    ).not.toBe(computeSceneSignature(base))
  })

  it('changes when a binary file is added or dropped', () => {
    expect(computeSceneSignature({ ...base, files: { 'file-1': {}, 'file-2': {} } })).not.toBe(
      computeSceneSignature(base)
    )
    expect(computeSceneSignature({ ...base, files: {} })).not.toBe(computeSceneSignature(base))
  })

  it('ignores the iteration order of the files map', () => {
    const forward = computeSceneSignature({ ...base, files: { a: {}, b: {} } })
    const reverse = computeSceneSignature({ ...base, files: { b: {}, a: {} } })
    expect(forward).toBe(reverse)
  })

  it('changes when exported appState changes (canvas background, grid)', () => {
    expect(
      computeSceneSignature({
        ...base,
        appStateJson: '{"appState":{"viewBackgroundColor":"#000"}}'
      })
    ).not.toBe(computeSceneSignature(base))
  })

  it('tolerates elements without version counters', () => {
    expect(() => computeSceneSignature({ ...base, elements: [{ id: 'a' }] })).not.toThrow()
  })
})
