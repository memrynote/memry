/**
 * What a canvas frame can be bound to: the vault's tags and every select,
 * multi-select and status property with its option values. Loaded each time a
 * picker opens, so a tag or option created since the last opening is there.
 *
 * @module pages/canvas/use-frame-binding-choices
 */

import { useEffect, useState } from 'react'
import { createLogger } from '@/lib/logger'
import { notesService } from '@/services/notes-service'
import { tagsService } from '@/services/tags-service'
import {
  definitionOptionValues,
  isBindablePropertyType,
  type BindablePropertyType
} from './canvas-frame-binding'

const log = createLogger('SpatialCanvas')

export interface BindableProperty {
  name: string
  type: BindablePropertyType
  values: string[]
}

export interface FrameBindingChoices {
  tags: string[]
  properties: BindableProperty[]
  loading: boolean
}

export function useFrameBindingChoices(open: boolean): FrameBindingChoices {
  const [loaded, setLoaded] = useState<Omit<FrameBindingChoices, 'loading'> | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      const [tags, definitions] = await Promise.all([
        tagsService
          .getAllWithCounts()
          .then((result) => result.tags.map((tag) => tag.name))
          .catch((err: unknown) => {
            log.error('Failed to load tags for frame binding', err)
            return [] as string[]
          }),
        notesService.getPropertyDefinitions().catch((err: unknown) => {
          log.error('Failed to load property definitions for frame binding', err)
          return []
        })
      ])
      if (cancelled) return
      const properties: BindableProperty[] = []
      for (const definition of definitions) {
        if (!isBindablePropertyType(definition.type)) continue
        const values = definitionOptionValues(definition.type, definition.options)
        if (values.length > 0) {
          properties.push({ name: definition.name, type: definition.type, values })
        }
      }
      setLoaded({ tags, properties })
    })()
    return () => {
      cancelled = true
      // The next opening starts from a fresh read, never a stale list.
      setLoaded(null)
    }
  }, [open])

  return loaded ? { ...loaded, loading: false } : { tags: [], properties: [], loading: open }
}
