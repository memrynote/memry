/**
 * The vault's custom icon library, held once for the whole renderer.
 *
 * `NoteIconDisplay` renders in sidebar rows, tabs, tag chips and note titles —
 * surfaces that are mounted by the hundred and, in tests, without a
 * QueryClientProvider. So this is a plain module store read through
 * `useSyncExternalStore` rather than a react-query hook: no provider to thread,
 * one IPC list per session, and an empty library (tests, no vault) simply
 * renders the fallback glyph.
 *
 * The first subscriber triggers the load and wires the `custom-icons:updated`
 * broadcast, which is how a peer's icon appears without a reload.
 */

import { useCallback, useSyncExternalStore } from 'react'
import type { CustomIcon } from '@memry/contracts/custom-icons-api'
import { toMemryFileUrl } from './memry-file-url'
import { createLogger } from './logger'

const log = createLogger('CustomIconsStore')

export interface CustomIconEntry {
  id: string
  name: string
  /** `memry-file://` URL the renderer can put straight into `<img src>`. */
  url: string
  createdAt: string
}

const EMPTY: CustomIconEntry[] = []

let entries: CustomIconEntry[] = EMPTY
let byId: Map<string, CustomIconEntry> = new Map()
const listeners = new Set<() => void>()
let started = false

function publish(next: CustomIcon[]): void {
  entries = next.map((icon) => ({
    id: icon.id,
    name: icon.name,
    url: toMemryFileUrl(icon.path),
    createdAt: icon.createdAt
  }))
  byId = new Map(entries.map((entry) => [entry.id, entry]))
  for (const listener of listeners) listener()
}

async function load(): Promise<void> {
  const api = window.api?.customIcons
  if (!api) return
  try {
    publish(await api.list())
  } catch (error) {
    log.warn('Failed to load custom icons', error)
  }
}

function start(): void {
  if (started) return
  started = true
  void load()
  // App-lifetime subscription: the library is global, so there is no unmount
  // edge at which dropping it would be correct.
  window.api?.onCustomIconsUpdated?.(() => {
    void load()
  })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  start()
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): CustomIconEntry[] {
  return entries
}

/** Re-read the library after a local add/rename/delete. */
export async function refreshCustomIcons(): Promise<void> {
  await load()
}

export function useCustomIcons(): CustomIconEntry[] {
  return useSyncExternalStore(subscribe, getSnapshot)
}

export function useCustomIcon(id: string): CustomIconEntry | undefined {
  return useSyncExternalStore(
    subscribe,
    useCallback(() => byId.get(id), [id])
  )
}
