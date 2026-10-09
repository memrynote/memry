/**
 * Tag names have two keys, and they differ only for non-ASCII letters.
 *
 * - `foldTag` is a tag's identity: which spellings are one tag on a note, a
 *   journal or a task. ASCII letters are lowercased and every other character
 *   is kept, as SQLite `COLLATE NOCASE` (the tag columns) and the Rust core's
 *   `domain/tags.rs` `fold` do, so every device and every lookup agrees.
 *   `Ünal` and `ünal` are two tags; `İş` folds to `İş`. It never changes a
 *   string's length, so a prefix that folds equal can be cut from the
 *   original spelling at the prefix's length.
 * - `tagKey` is a tag definition's id: the trimmed name lowercased in full.
 *   It is the shipped `tag_definition` sync id and stored name (desktop
 *   `database/queries/tag-definitions.ts`, Rust `domain/tag_admin.rs`
 *   `definition_id`) and the form schema `extends` and relation `target`
 *   hold (protocol §13.7.7.2), so it stays as shipped.
 */
export function foldTag(tag: string): string {
  return tag.replace(/[A-Z]+/g, (upper) => upper.toLowerCase())
}

export function tagKey(tag: string): string {
  return tag.trim().toLowerCase()
}
