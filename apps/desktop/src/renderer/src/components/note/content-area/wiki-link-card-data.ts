/**
 * Loads what a link card shows, once per target.
 *
 * A link's row or card is drawn by the inline spec's `render()`, which is
 * synchronous vanilla DOM, so its content arrives afterwards: `render` asks
 * here and fills its own elements when the answer comes (`wiki-link-card.ts`).
 * Answers are cached by target, and a note being created, renamed, deleted or
 * edited anywhere drops the cache and refills every card on screen, so a card
 * never keeps showing a description that has since changed.
 */

import { createLogger } from '@/lib/logger'
import { previewWikiLinkTarget } from '@/lib/wiki-link-preview'
import {
  onNoteCreated,
  onNoteDeleted,
  onNoteRenamed,
  onNoteUpdated
} from '@/services/notes-service'
import { vaultService } from '@/services/vault-service'
import { wikiLinkCardContent, type WikiLinkCardContent } from './wiki-link-card-content'

const logger = createLogger('WikiLinkCard')

const REFRESH_DEBOUNCE_MS = 400

/** Marks the chips that have card elements to fill. */
export const WIKI_LINK_CARD_SELECTOR = '.wiki-link[data-wiki-link-card]'

type Fill = (chip: HTMLElement, content: WikiLinkCardContent | null) => void

const cache = new Map<string, Promise<WikiLinkCardContent | null>>()
let vaultPath: Promise<string | null> | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let subscribed = false

function readVaultPath(): Promise<string | null> {
  vaultPath ??= vaultService
    .getStatus()
    .then((status) => status.path ?? null)
    .catch((err: unknown) => {
      logger.error('Could not read the vault path for a link card', err)
      vaultPath = null
      return null
    })
  return vaultPath
}

export function loadWikiLinkCardContent(target: string): Promise<WikiLinkCardContent | null> {
  const key = target.toLowerCase()
  let pending = cache.get(key)
  if (!pending) {
    pending = (async () => {
      const preview = await previewWikiLinkTarget(target)
      return preview ? wikiLinkCardContent(preview, await readVaultPath()) : null
    })().catch((err: unknown) => {
      logger.error('Could not load a link card', err)
      cache.delete(key)
      return null
    })
    cache.set(key, pending)
  }
  return pending
}

/** Fills one chip's card elements, asking for its note first. */
export async function hydrateWikiLinkCard(chip: HTMLElement, fill: Fill): Promise<void> {
  const target = chip.getAttribute('data-target')?.trim()
  if (!target) return
  subscribeToNoteChanges(fill)
  fill(chip, await loadWikiLinkCardContent(target))
}

function refreshAll(fill: Fill): void {
  cache.clear()
  vaultPath = null
  for (const chip of document.querySelectorAll<HTMLElement>(WIKI_LINK_CARD_SELECTOR)) {
    void hydrateWikiLinkCard(chip, fill)
  }
}

function subscribeToNoteChanges(fill: Fill): void {
  if (subscribed) return
  subscribed = true
  const schedule = (): void => {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => refreshAll(fill), REFRESH_DEBOUNCE_MS)
  }
  // Held for the life of the window: cards exist in every note, and the
  // subscription costs one debounced timer.
  onNoteCreated(schedule)
  onNoteRenamed(schedule)
  onNoteDeleted(schedule)
  onNoteUpdated(schedule)
}
