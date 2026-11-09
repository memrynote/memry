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

/** The vault root's own attachments folder, which the watcher never reads either. */
const ATTACHMENTS_DIR = 'attachments'

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
 * Whether the vault-relative `path` is one the watcher does not read, as main's `WatchFilter`
 * decides it: a hidden name, the root attachments folder, a folder or file named like a
 * pattern, or a pattern with a separator that names part of the path.
 */
export function isExcludedPath(path: string, excludePatterns: readonly string[]): boolean {
  const names = path.split('/')
  for (const [index, name] of names.entries()) {
    if (name.startsWith('.')) return true
    if (index === 0 && name === ATTACHMENTS_DIR) return true
    if (excludePatterns.includes(name)) return true
  }
  const framed = `/${path}/`
  return excludePatterns.some((pattern) => pattern.includes('/') && framed.includes(`/${pattern}/`))
}

/** Whether the note at `path` is excluded, so no write of the app reaches it. */
export function useIsNoteExcluded(path: string | null | undefined): boolean {
  const current = useSyncExternalStore(subscribe, () => patterns)
  return !!path && isExcludedPath(path, current)
}
