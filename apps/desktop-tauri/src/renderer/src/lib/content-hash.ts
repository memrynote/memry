/**
 * The core's content hash of a text (`memry_core::domain::content_hash`, Electron's
 * `generateContentHash`): djb2 over UTF-16 code units, as 8 lowercase hex digits. A save's reply
 * names the text it kept as a version by this hash (`keptReplacedHash`), and the editor hashes
 * the text it lost to compare (#4137).
 */
export function contentHash(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash, 33) ^ text.charCodeAt(i)
  return (hash >>> 0).toString(16).padStart(8, '0')
}
