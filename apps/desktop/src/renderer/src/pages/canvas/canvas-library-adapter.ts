/**
 * Vault-backed persistence for Excalidraw's library (the shapes panel).
 *
 * Without an adapter the library lives only in the component's memory, and the
 * editor remounts per canvas id — so an imported `.excalidrawlib` survives
 * until the first tab switch and then vanishes. This routes load/save to the
 * canvas library IPC surface, which stores one encrypted row per item.
 *
 * Dependency-injected (no `window.api` import) so the adapter is testable
 * without the preload bridge or the Excalidraw runtime.
 */

import type { LibraryPersistenceAdapter } from '@excalidraw/excalidraw/data/library'
import type { LibraryItems } from '@excalidraw/excalidraw/types'
import type { CanvasLibraryItem } from '@memry/contracts/canvas-api'

export interface VaultLibraryAdapterDeps {
  list: () => Promise<{ libraryItems: CanvasLibraryItem[] }>
  save: (libraryItems: CanvasLibraryItem[]) => Promise<unknown>
  /** Surfaces a failure to the user; a silently dropped save loses their import. */
  onError: (err: unknown, operation: 'load' | 'save') => void
}

export function createVaultLibraryAdapter(
  deps: VaultLibraryAdapterDeps
): LibraryPersistenceAdapter {
  return {
    async load() {
      try {
        const { libraryItems } = await deps.list()
        // The vault stores library items as opaque JSON — only `id` is ours to
        // interpret — so this cast is the one place the loose stored shape is
        // reasserted as Excalidraw's. Anything narrower would strip fields a
        // future Excalidraw version adds.
        return { libraryItems: libraryItems as unknown as LibraryItems }
      } catch (err) {
        // Returning null means "no stored library" rather than "empty
        // library". Excalidraw then leaves what's in memory alone, so a
        // transient IPC failure can't cascade into wiping the panel — and,
        // because Excalidraw calls load() again before each save, it can't
        // cascade into tombstoning every row either.
        deps.onError(err, 'load')
        return null
      }
    },

    async save(libraryData) {
      try {
        // The array is readonly on Excalidraw's side; the IPC bridge structured-
        // clones it anyway, so copy rather than cast.
        await deps.save([...libraryData.libraryItems] as CanvasLibraryItem[])
      } catch (err) {
        deps.onError(err, 'save')
      }
    }
  }
}
