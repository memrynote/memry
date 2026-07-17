// packages/contracts/src/redact.ts
//
// Pure, crypto-free redaction shared by desktop main (salted hasher injected) and
// the sync-server (mask-mode, defense-in-depth). No node/electron imports so it is
// safe in Cloudflare Workers, Node, and worker_threads bundles.

export interface RedactOptions {
  /** Active vault root (absolute) collapsed to <vault>/. */
  vaultRoot?: string
  /**
   * Salted one-way hash. When provided (desktop), correlatable placeholders are
   * produced: emails → [email:hash8], ids → hash, content basenames → [name:hash8].ext.
   * When omitted (server / pattern-only), values are masked to fixed placeholders
   * (<email>, <id>, [name].ext) — safe but non-correlatable.
   */
  hash?: (value: string) => string
}

// --- secret shapes (dropped, never hashed) ---
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi
// Matches assignments whose KEY ends in a secret word (secret/password/passwd/token)
// or is an api-key/authorization — including compound keys joined by _/- such as
// `client_secret`, `id_token`, `refresh_token`, `x-api-key`. JS `\b` does not split
// `client_secret` (`_` is a word char), so the leading `[\w-]*` is what lets the key
// prefix be consumed before the secret word. The trailing `\b` keeps this from
// firing on non-secret keys like `sortKey`, `cacheKey`, `tokenCount`. Bare `key` is
// deliberately excluded (too broad).
const AUTH_ASSIGN =
  /\b[\w-]*(?:secret|password|passwd|token|api[_-]?key|apikey|authorization)\b\s*[:=]\s*\S+/gi
const API_KEY = /\b(?:sk|pk|rk|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g
const QUERY_SECRET =
  /([?&](?:token|key|secret|access_token|refresh_token|sig|signature|password|auth)=)[^&\s]+/gi
// base64/hex key material ≥ 40 chars (vault/device keys) — dropped
const LONG_SECRET = /\b[A-Za-z0-9+/=_-]{40,}\b/g

// --- structural shapes ---
const URL_QUERY = /(\bhttps?:\/\/[^\s?#]+)[?#]\S*/gi
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g
// Real IPv6 only: either the full 8-group form (7 colons) or a compressed form
// containing `::`. A bare 2–3-colon run like a `HH:MM:SS` log timestamp must NOT
// match (that was the previous `{2,7}` bug).
const IPV6 =
  /\b(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}\b|(?:[0-9A-Fa-f]{1,4}:){1,7}:(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{0,4}/g
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const HOME_UNIX = /(?:\/Users\/|\/home\/)[^/\s:)'"]+|\/root(?=\/|\b)/g
const HOME_WIN = /[A-Za-z]:\\Users\\[^\\\s:)'"]+/gi
// content files (note/attachment) — hashed. Deliberately EXCLUDES code extensions
// (ts/js/tsx/mjs/…) so stack-frame file names survive as diagnostic signal.
const CONTENT_FILE =
  /([\p{L}\p{N}][\p{L}\p{N} ()._-]*)\.(md|markdown|pdf|txt|rtf|docx?|xlsx?|pptx?|csv|html?|json|png|jpe?g|gif|webp|svg|heic|tiff?|mp[34]|m4a|mov|zip)\b/giu

const mask = (opts: RedactOptions | undefined, kind: 'email' | 'id', raw: string): string => {
  if (!opts?.hash) return kind === 'email' ? '<email>' : '<id>'
  return kind === 'email' ? `[email:${opts.hash(raw).slice(0, 8)}]` : opts.hash(raw).slice(0, 10)
}

export const redactText = (text: string, opts?: RedactOptions): string => {
  if (!text) return text
  let out = text
  // 1. secrets first (drop) — order matters so nothing below hashes a secret.
  //    BEARER runs before AUTH_ASSIGN so `Bearer <token>` is dropped as a unit;
  //    otherwise AUTH_ASSIGN's `\S+` consumes only up to `Bearer` and a plain
  //    (non-JWT, non-sk-, <40-char) token would survive. AUTH_ASSIGN still catches
  //    `Authorization: <value>` forms that have no `Bearer` prefix.
  out = out.replace(JWT, '<redacted>')
  out = out.replace(BEARER, '<redacted>')
  out = out.replace(AUTH_ASSIGN, '<redacted>')
  out = out.replace(API_KEY, '<redacted>')
  out = out.replace(QUERY_SECRET, '$1<redacted>')
  // 2. URL query strip (keep scheme+host+path).
  out = out.replace(URL_QUERY, '$1')
  // 3. paths: vault root first (exact string match, before generic home-path
  //    stripping can mangle it — e.g. /home/u/MyVault would otherwise become
  //    ~/MyVault before the vaultRoot string is ever matched), then home → ~.
  if (opts?.vaultRoot) out = out.split(opts.vaultRoot).join('<vault>')
  out = out.replace(HOME_UNIX, '~').replace(HOME_WIN, '~')
  // 4. emails first — before content basenames so an email whose domain ends in a
  //    content extension (e.g. `kaan@gmail.com.pdf`) is masked as a whole unit; if
  //    CONTENT_FILE ran first it would consume `gmail.com.pdf` and leak the local part.
  out = out.replace(EMAIL, (m) => mask(opts, 'email', m))
  // 5. content basenames → hashed/masked (before generic long-secret so titles hash).
  out = out.replace(CONTENT_FILE, (_m, base: string, ext: string) =>
    opts?.hash ? `[name:${opts.hash(base).slice(0, 8)}].${ext}` : `[name].${ext}`
  )
  // 6. ids, ips.
  out = out.replace(UUID, (m) => mask(opts, 'id', m))
  out = out.replace(IPV4, '<ip>').replace(IPV6, '<ip>')
  // 7. residual long secrets last (key material with no other shape).
  out = out.replace(LONG_SECRET, '<redacted>')
  return out
}

export const redactPathValue = (value: string, opts?: RedactOptions): string =>
  redactText(value, opts)
