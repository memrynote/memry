//! Versions of a note's body (desktop `createSnapshot`, `vault/note-snapshots.ts`), in the
//! `note_snapshots` table of `data.db` (migration 0013).
//!
//! [`keep`] is the one writer. A body that is about to be replaced by something the user
//! did not type in this app (an outside edit of the file, Step 12e; the write-back's
//! replace of bytes it did not write, 12e-3) is kept first, so every replaced body can be
//! restored. A version whose content this note already holds is not kept twice
//! (`snapshotExistsWithHash`). The interval and pruning rules of the version-history
//! feature are Step 14's and are not here.

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;
use crate::domain::content_hash::content_hash;
use crate::domain::journal_rules::is_js_whitespace;
use crate::storage::repositories::instants;

/// `SnapshotReasons.SIGNIFICANT`: a content change the user did not make in the editor.
/// The renderer reads this column as a closed union, so a new reason is a format change.
pub const SIGNIFICANT: &str = "significant";

/// One version to keep.
pub struct Version<'a> {
    pub note_id: &'a str,
    /// What the version restores to: the whole file, frontmatter block and body, as
    /// desktop keeps it (`serializeNote(frontmatter, body)`; its restore writes this
    /// column as the file, `notes-versions.ts`).
    pub content: &'a str,
    /// The body within `content`, which the word count reads (`parseNote(..).content`).
    pub body: &'a str,
    /// The note's title when the version was kept, for the list.
    pub title: &'a str,
    pub reason: &'a str,
}

/// Keeps `version` unless the note already has one with the same content. True when a
/// row was written.
pub fn keep(conn: &Connection, version: Version<'_>, now_ms: i64) -> Result<bool, StorageError> {
    let hash = content_hash(version.content);
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM note_snapshots WHERE note_id = ?1 AND content_hash = ?2)",
            params![version.note_id, hash],
            |row| row.get(0),
        )
        .map_err(failed)?;
    if exists {
        return Ok(false);
    }
    let created_at = instants::to_iso8601(now_ms).ok_or_else(|| StorageError::Failed {
        what: format!("{now_ms} is not a representable instant"),
    })?;
    conn.execute(
        "INSERT INTO note_snapshots
           (id, note_id, content, title, word_count, content_hash, reason, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            crate::domain::inbox::write::mint_id(),
            version.note_id,
            version.content,
            version.title,
            i64::try_from(word_count(version.body)).unwrap_or(i64::MAX),
            hash,
            version.reason,
            created_at,
        ],
    )
    .map_err(failed)?;
    Ok(true)
}

/// `calculateWordCount`: fenced code (```` ```…``` ````, shortest match) and inline code
/// (`` `…` ``, at least one character) removed, then the whitespace-separated words.
pub fn word_count(content: &str) -> usize {
    let without_fences = remove_spans(content, "```", 0);
    let without_code = remove_spans(&without_fences, "`", 1);
    without_code
        .split(is_js_whitespace)
        .filter(|word| !word.is_empty())
        .count()
}

/// Removes every `delimiter … delimiter` span whose inside is at least `min_inside` bytes
/// and, for a one-character delimiter, holds no delimiter (`/`[^`]+`/g`), leftmost first.
fn remove_spans(text: &str, delimiter: &str, min_inside: usize) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find(delimiter) {
        let after = &rest[open + delimiter.len()..];
        match after.find(delimiter) {
            Some(close) if close >= min_inside => {
                out.push_str(&rest[..open]);
                rest = &after[close + delimiter.len()..];
            }
            // An empty inline span: the match fails here and is retried one character on.
            Some(_) => {
                out.push_str(&rest[..open + delimiter.len()]);
                rest = after;
            }
            None => break,
        }
    }
    out.push_str(rest);
    out
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn word_count_matches_calculate_word_count() {
        // Expected values are what `calculateWordCount` answers for the same strings.
        assert_eq!(word_count(""), 0);
        assert_eq!(word_count("  one two\n\nthree  "), 3);
        assert_eq!(word_count("before ```\ncode here\n``` after"), 2);
        assert_eq!(word_count("a `inline code` b"), 2);
        assert_eq!(word_count("a `` b"), 3);
        assert_eq!(word_count("open ``` never closed"), 4);
        assert_eq!(word_count("x ```a``` y ```b``` z"), 3);
    }
}
