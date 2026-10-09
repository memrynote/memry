/**
 * A tag's identity: which spellings are one tag, on every device (protocol
 * chapter 13 §13.7.8, pinned by the `tag-fold` vectors; the Rust core's
 * `domain/tags.rs` `fold` implements the same rule).
 *
 * Each character folds on its own, with no locale and no context:
 * - `İ` (U+0130) folds to `i`, so Turkish `İş` and `iş` are one tag, and a
 *   combining dot above (U+0307) right after a character that folded to `i` is
 *   dropped, so `i̇ş` (the full lowercase of `İş`, which builds before this rule
 *   stored as definition keys and references) is that tag too;
 * - `ς` (U+03C2, final sigma) folds to `σ`, so `ΟΔΟΣ`, `οδος` and `οδοσ` are one;
 * - every other character takes its Unicode lowercase mapping.
 *
 * `ı` stays `ı` and `I` folds to `i`: `ı` and `i` are distinct Turkish letters,
 * and merging them would merge distinct words. `ß` stays `ß`. For every
 * string, `foldTag(foldTag(s))` and `foldTag(s.toLowerCase())` equal `foldTag(s)`.
 *
 * The fold can change a string's length, so never cut an original spelling at
 * a folded string's length; split on `/` instead.
 *
 * SQLite `COLLATE NOCASE` folds ASCII only, so a query matching tags uses the
 * `tag_fold()` function the desktop registers on its connections
 * (`database/sqlite-functions.ts`), not the collation.
 */
export function foldTag(tag: string): string {
  let out = ''
  let afterI = false
  for (const char of tag) {
    if (afterI && char === '\u0307') continue
    const folded = char === '\u0130' ? 'i' : char === '\u03C2' ? '\u03C3' : char.toLowerCase()
    out += folded
    afterI = folded === 'i'
  }
  return out
}

/**
 * A tag definition's key: the trimmed name, folded. Desktop stores a
 * definition under the name it was first written with (the sync id), so look a
 * definition up by key with `tag_fold(name)`, never by the stored name.
 */
export function tagKey(tag: string): string {
  return foldTag(tag.trim())
}

/**
 * The `/…` part of `tag` below `parent`, cut by `/` segments in `tag`'s own
 * spelling: `Work/A/b` below `work` is `/A/b`. The caller has checked that
 * `tag` is under `parent`.
 */
export function suffixBelow(tag: string, parent: string): string {
  const depth = parent.trim().split('/').length
  return `/${tag.split('/').slice(depth).join('/')}`
}
