/**
 * Phase 3 — resolve `((uid))` block references and `{{embed: ((uid))}}` embeds.
 *
 * Block-ref mapping decision: Memry markdown has no Roam-style `[[page#^uid]]`
 * block anchors, so we use the SAFE FALLBACK. A reference `((uid))` becomes a
 * wikilink to the page that contains the referenced block, followed by that
 * block's (scrubbed) text in quotes:
 *
 *     ((abc123))            →  [[Some Page]]: "the referenced block text"
 *     {{embed: ((abc123))}} →  [[Some Page]]: "the referenced block text"
 *
 * References to unknown uids degrade to plain text: the surrounding `((`/`))`
 * (or embed wrapper) is stripped and the bare uid is left in place.
 *
 * No `^uid` anchors are emitted anywhere.
 */

import { scrubMarkup } from './convert-blocks.ts'
import type { BlockIndex, BlockRefMode } from './types.ts'

const EMBED_RE = /\{\{embed:\(\(([^)]+)\)\)\}\}/g
const REF_RE = /\(\(([^)]+)\)\)/g

function quote(text: string): string {
  // Scrub markup in the referenced text and collapse to a single line.
  const clean = scrubMarkup(text).replace(/\s+/g, ' ').trim()
  return clean
}

function renderRef(uid: string, index: BlockIndex): string {
  const entry = index.get(uid)
  if (!entry) {
    // Unknown uid → plain text fallback (bare uid, parens stripped).
    return uid
  }
  const text = quote(entry.text)
  if (text === '') return `[[${entry.pageTitle}]]`
  return `[[${entry.pageTitle}]]: "${text}"`
}

/**
 * Resolve embeds first (they wrap a `((uid))`), then standalone block refs.
 * `mode` is currently always `'fallback'`; the parameter documents intent and
 * leaves room for a future anchor mode.
 */
export function resolveRefs(
  markdown: string,
  index: BlockIndex,
  _mode: BlockRefMode = 'fallback'
): string {
  let out = markdown.replace(EMBED_RE, (_m, uid: string) => renderRef(uid, index))
  out = out.replace(REF_RE, (_m, uid: string) => renderRef(uid, index))
  return out
}
