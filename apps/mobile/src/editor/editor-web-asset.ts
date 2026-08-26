import pako from 'pako'
import { base64ToBytes } from '../lib/base64'
import {
  EDITOR_WEB_CONTRACT_HASH,
  EDITOR_WEB_HTML_BYTES,
  EDITOR_WEB_HTML_GZ_B64
} from './generated/editor-web-asset'

/**
 * The self-contained WebView editor document (T057).
 *
 * Stored gzipped in the generated module — see `scripts/build-editor-web.mjs`
 * for why — and inflated once, lazily, on the first editor open. Cached for
 * the process lifetime: the bytes are identical for every note, and re-running
 * a ~4.5 MB inflate per note open would be a self-inflicted stall.
 */

let cached: string | null = null

export function loadEditorWebHtml(): string {
  if (cached !== null) return cached

  // `atob` does not exist on Hermes; `lib/base64` is the app-wide answer.
  cached = pako.ungzip(base64ToBytes(EDITOR_WEB_HTML_GZ_B64), { to: 'string' })
  return cached
}

export { EDITOR_WEB_CONTRACT_HASH, EDITOR_WEB_HTML_BYTES }
