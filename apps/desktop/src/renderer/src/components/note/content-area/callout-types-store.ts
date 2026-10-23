import { useEffect, useSyncExternalStore } from 'react'
import { setCalloutTypeDefinitions, type CalloutTypeDefinition } from '@memry/editor-schema/blocks'
import { createLogger } from '@/lib/logger'

const log = createLogger('CalloutTypes')

/**
 * The renderer's copy of the user's custom callout types (#3207). Publishing
 * also refreshes the editor-schema registry, so what the markdown parser
 * claims as a callout and what the editor can draw never disagree.
 */
let snapshot: readonly CalloutTypeDefinition[] = []
const listeners = new Set<() => void>()
let started = false

export function publishCalloutTypes(definitions: readonly CalloutTypeDefinition[]): void {
  snapshot = definitions
  setCalloutTypeDefinitions(definitions)
  listeners.forEach((listener) => {
    listener()
  })
}

export function getCalloutTypes(): readonly CalloutTypeDefinition[] {
  return snapshot
}

/** Load once, then follow changes from this window, other windows and sync. Idempotent. */
export function startCalloutTypesSync(): void {
  if (started) return
  started = true
  window.api.settings
    .getCalloutTypes()
    .then(publishCalloutTypes)
    .catch((err: unknown) => {
      log.warn('Failed to load callout types', err)
    })
  window.api.onSettingsChanged((event) => {
    if (event.key === 'editor.calloutTypes') {
      publishCalloutTypes(event.value as CalloutTypeDefinition[])
    }
  })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useCalloutTypes(): readonly CalloutTypeDefinition[] {
  useEffect(startCalloutTypesSync, [])
  return useSyncExternalStore(subscribe, getCalloutTypes)
}
