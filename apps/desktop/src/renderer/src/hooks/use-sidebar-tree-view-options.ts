import { useCallback, useEffect, useState } from 'react'
import { getI18n } from 'react-i18next'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'

const log = createLogger('SidebarTreeViewOptions')

/** Mirrors SIDEBAR_NOTES_FIRST_SETTINGS_KEY in the main process. */
export const SIDEBAR_NOTES_FIRST_SETTINGS_KEY = 'sidebar.notesFirst'
/** Mirrors SIDEBAR_SHOW_FILES_SETTINGS_KEY in the main process. */
export const SIDEBAR_SHOW_FILES_SETTINGS_KEY = 'sidebar.showFiles'

type SaveResult = { success: boolean; error?: string }

interface SyncedFlagSource {
  key: string
  /** The tree every build before this toggle drew. */
  fallback: boolean
  load: () => Promise<boolean> | undefined
  save: (next: boolean) => Promise<SaveResult>
}

interface SyncedFlag {
  value: boolean
  setValue: (next: boolean) => void
  error: string | null
}

/**
 * One synced sidebar boolean. Same lifecycle as `useSidebarNavCollapsed`:
 * starts at the default so the first paint is yesterday's tree, loads the
 * stored value, follows changes from other windows and devices, and writes
 * optimistically with a rollback on failure.
 */
function useSyncedSidebarFlag({ key, fallback, load, save }: SyncedFlagSource): SyncedFlag {
  const [value, setValueState] = useState<boolean>(fallback)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    const run = async (): Promise<void> => {
      try {
        const stored = await load()
        if (mounted && typeof stored === 'boolean') setValueState(stored)
      } catch (err) {
        log.error(`Failed to load ${key}`, err)
      }
    }
    void run()
    return () => {
      mounted = false
    }
  }, [key, load])

  useEffect(() => {
    // Guarded: a host without the settings channel must keep the default tree,
    // not tear the sidebar down.
    try {
      const unsubscribe = window.api?.onSettingsChanged?.((event) => {
        if (event.key !== key) return
        // Typed, not truthy: `false` is a real value for both flags.
        if (typeof event.value === 'boolean') setValueState(event.value)
      })
      return typeof unsubscribe === 'function' ? unsubscribe : undefined
    } catch (err) {
      log.error(`Failed to subscribe to ${key} changes`, err)
      return undefined
    }
  }, [key])

  const setValue = useCallback(
    (next: boolean): void => {
      const previous = value
      setValueState(next)
      setError(null)

      const failureMessage = getI18n().getFixedT(null, 'notes')('tree.viewOptions.saveFailed')

      void (async () => {
        try {
          const result = await save(next)
          if (!result.success) {
            setValueState(previous)
            setError(result.error ?? failureMessage)
          }
        } catch (err) {
          setValueState(previous)
          setError(extractErrorMessage(err, failureMessage))
        }
      })()
    },
    [value, save]
  )

  return { value, setValue, error }
}

const loadNotesFirst = (): Promise<boolean> | undefined =>
  window.api?.settings?.getSidebarNotesFirst?.()
const saveNotesFirst = (next: boolean): Promise<SaveResult> =>
  window.api.settings.setSidebarNotesFirst(next)
const loadShowFiles = (): Promise<boolean> | undefined =>
  window.api?.settings?.getSidebarShowFiles?.()
const saveShowFiles = (next: boolean): Promise<SaveResult> =>
  window.api.settings.setSidebarShowFiles(next)

export interface SidebarTreeViewOptions {
  /** A folder's notes render before its subfolders, at every level. */
  notesFirst: boolean
  setNotesFirst: (next: boolean) => void
  /** Non-markdown vault files (PDF, images, audio, video) render in the tree. */
  showFiles: boolean
  setShowFiles: (next: boolean) => void
  error: string | null
}

/**
 * The Collections tree's view options, persisted per vault and synced.
 * Defaults are the tree every earlier build drew: folders first, files shown.
 */
export function useSidebarTreeViewOptions(): SidebarTreeViewOptions {
  const notesFirst = useSyncedSidebarFlag({
    key: SIDEBAR_NOTES_FIRST_SETTINGS_KEY,
    fallback: false,
    load: loadNotesFirst,
    save: saveNotesFirst
  })
  const showFiles = useSyncedSidebarFlag({
    key: SIDEBAR_SHOW_FILES_SETTINGS_KEY,
    fallback: true,
    load: loadShowFiles,
    save: saveShowFiles
  })

  return {
    notesFirst: notesFirst.value,
    setNotesFirst: notesFirst.setValue,
    showFiles: showFiles.value,
    setShowFiles: showFiles.setValue,
    error: notesFirst.error ?? showFiles.error
  }
}
