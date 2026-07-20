/**
 * Debounced, deduped persistence for an Excalidraw scene.
 *
 * Excalidraw's onChange fires on every state commit, including pan/zoom, so
 * saves are debounced, and the scene is serialized only when a save actually
 * runs. The serialized output is compared against the last persisted value
 * before writing — serializeAsJSON strips volatile appState (scroll, zoom,
 * selection), so scroll/zoom-only changes serialize identically and are
 * skipped. Pure logic with no Excalidraw imports so it stays unit-testable.
 */

export interface ScenePersisterOptions {
  /**
   * Reads and serializes the current scene. Returns null when the scene is
   * not readable (editor API not ready or already torn down).
   */
  serialize: () => string | null
  /** Persists a serialized scene. */
  save: (scene: string) => Promise<void>
  /** Idle time after the last change before a save runs. */
  debounceMs: number
  /** Baseline for dedupe: the scene as last loaded/persisted. */
  lastSavedScene: string
  /** Called when a save fails. The change stays pending and is retried on the next flush/save. */
  onError?: (error: unknown) => void
}

export interface ScenePersister {
  /** Marks the scene dirty and (re)starts the debounce timer. */
  notifyChange: () => void
  /** Cancels the timer and persists immediately (no-op when nothing changed). */
  flush: () => Promise<void>
  /** True while a debounced save is scheduled. */
  hasPendingChange: () => boolean
}

export function createScenePersister(options: ScenePersisterOptions): ScenePersister {
  const { serialize, save, debounceMs, onError } = options
  let lastSaved = options.lastSavedScene
  let timer: ReturnType<typeof setTimeout> | null = null
  // Serializes saves so a flush during an in-flight debounced save waits for it.
  let chain: Promise<void> = Promise.resolve()

  const persist = async (): Promise<void> => {
    const scene = serialize()
    if (scene === null || scene === lastSaved) {
      return
    }
    await save(scene)
    lastSaved = scene
  }

  const run = (): Promise<void> => {
    chain = chain.then(persist).catch((error) => {
      onError?.(error)
    })
    return chain
  }

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  return {
    notifyChange: (): void => {
      clearTimer()
      timer = setTimeout(() => {
        timer = null
        void run()
      }, debounceMs)
    },
    flush: (): Promise<void> => {
      clearTimer()
      return run()
    },
    hasPendingChange: (): boolean => timer !== null
  }
}
