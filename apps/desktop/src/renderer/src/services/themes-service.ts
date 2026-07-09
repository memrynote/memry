/**
 * Custom themes service — forwards to window.api.themes (generated RPC).
 *
 * @module services/themes-service
 */

import type {
  ThemeChangedEvent,
  ThemeDeleteResult,
  ThemeMutationResult,
  ThemesClientAPI
} from '@memry/rpc/themes'
import { createWindowApiForwarder } from './window-api-forwarder'

export type { ThemeChangedEvent, ThemeDeleteResult, ThemeMutationResult, ThemesClientAPI }

export const themesService: ThemesClientAPI = createWindowApiForwarder(() => window.api.themes)

export function onThemeCreated(callback: (event: ThemeChangedEvent) => void): () => void {
  return window.api.onThemeCreated(callback)
}

export function onThemeUpdated(callback: (event: ThemeChangedEvent) => void): () => void {
  return window.api.onThemeUpdated(callback)
}

export function onThemeDeleted(callback: (event: ThemeChangedEvent) => void): () => void {
  return window.api.onThemeDeleted(callback)
}
