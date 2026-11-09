/**
 * The open vault's exclude patterns, held once for the whole renderer, and whether a note's
 * file is under one (#3530 13m-7b-3b). Main refuses every write the app makes to such a note
 * (`note_excluded`); its editors open it read-only with a notice. A plain module store like the
 * lock store: the first subscriber loads the config and follows `vault:config-changed` and a
 * vault switch.
 */

import { useSyncExternalStore } from 'react'
import { onVaultConfigChanged, onVaultStatusChanged, vaultService } from '@/services/vault-service'
import { createLogger } from './logger'

const log = createLogger('ExcludedNotesStore')

let patterns: readonly string[] = []
const listeners = new Set<() => void>()
let started = false

function publish(next: readonly string[] | undefined): void {
  patterns = next ?? []
  for (const listener of listeners) listener()
}

function load(): void {
  void Promise.resolve()
    .then(() => vaultService.getConfig())
    .then((config) => publish(config.excludePatterns))
    .catch((error: unknown) => log.warn('Failed to load the exclude patterns', error))
}

function start(): void {
  if (started) return
  started = true
  onVaultConfigChanged((config) => publish(config.excludePatterns))
  let lastPath: string | null | undefined
  onVaultStatusChanged((status) => {
    if (status.path === lastPath) return
    lastPath = status.path
    load()
  })
  load()
}

function subscribe(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Whether an exclude pattern covers the vault-relative `path`, as main's `WatchFilter::excludes`
 * decides it: a folder or file named like a pattern, or a pattern with a separator that names
 * part of the path. A hidden name or the root attachments folder is not excluded.
 */
export function isExcludedPath(path: string, excludePatterns: readonly string[]): boolean {
  if (path.split('/').some((name) => excludePatterns.includes(name))) return true
  const framed = `/${path}/`
  return excludePatterns.some((pattern) => pattern.includes('/') && framed.includes(`/${pattern}/`))
}

/** Whether the note at `path` is excluded, so no write of the app reaches it. */
export function useIsNoteExcluded(path: string | null | undefined): boolean {
  const current = useSyncExternalStore(subscribe, () => patterns)
  return !!path && isExcludedPath(path, current)
}
