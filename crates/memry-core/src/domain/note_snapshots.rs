//! Versions of a note's body (desktop `note-snapshots.ts`, `notes-versions.ts`), in the
//! `note_snapshots` table of `data.db` (migration 0015). Versions never sync.
//!
//! [`keep`] is the one writer, with Electron's rules (`note-snapshots.ts:26-28`):
//! - a version whose content this note already holds is not kept twice
//!   (`snapshotExistsWithHash`); the version that holds it is moved up to the newest instead,
//!   so a text seen again is not the next one pruned (Electron left it where it was, and
//!   pruned the only copy of a text that came back);
//! - an [`Reason::Auto`] or [`Reason::Timer`] version needs 5 minutes since the note's last
//!   one;
//! - every kept version prunes the note to its newest 50, never the one just kept.
//!
//! A version is dated now, or the note's newest date when that is later ([`dated`]): on a
//! clock behind the note's versions, the one just kept is still the newest (a tie goes to the
//! row written last), and the oldest go first (Electron dated it oldest, and its next prune
//! took it).
//!
//! The callers decide when a replaced body is worth a version: bytes the app did not write
//! (an outside edit, a peer's merge the file never held) always are, and the app's own
//! bytes are when the body's word count moved by 10 or more ([`is_significant`]). A restore
//! keeps the text it replaces whatever the note holds ([`keep_always`], Electron's
//! `forceCreate`), so the newest version is the one to go back to.

use rusqlite::{Connection, OptionalExtension, params};

use crate::api::errors::StorageError;
use crate::domain::content_hash::content_hash;
use crate::domain::journal_rules::is_js_whitespace;
use crate::storage::repositories::instants;

/// `MAX_SNAPSHOTS_PER_NOTE`.
pub const MAX_PER_NOTE: i64 = 50;
/// `MIN_SNAPSHOT_INTERVAL_MS`: between two automatic or timer versions of a note.
pub const MIN_INTERVAL_MS: i64 = 5 * 60 * 1000;
/// `SIGNIFICANT_WORD_CHANGE`.
pub const SIGNIFICANT_WORDS: usize = 10;

/// Why a version was kept (`SnapshotReasons`). The renderer reads the column as this closed
/// union, so a new reason is a format change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    /// The user saved one.
    Manual,
    /// An automatic save.
    Auto,
    /// The periodic timer of an editing session.
    Timer,
    /// A content change: one the user did not make in the editor, or one of
    /// [`SIGNIFICANT_WORDS`] words or more.
    Significant,
    /// The note was open as the app quit.
    Close,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Auto => "auto",
            Self::Timer => "timer",
            Self::Significant => "significant",
            Self::Close => "close",
        }
    }
}

/// One version to keep.
pub struct Version<'a> {
    pub note_id: &'a str,
    /// What the version restores to: a whole file, frontmatter block and body. The column
    /// means what it means on desktop (`notes-versions.ts`); the bytes of the frontmatter
    /// block are the writer's own.
    pub content: &'a str,
    /// The body within `content`, which the word count reads (`parseNote(..).content`).
    pub body: &'a str,
    /// The note's title when the version was kept, for the list.
    pub title: &'a str,
    pub reason: Reason,
}

/// A kept version as the list shows it. `reason` is the column as stored: a newer build's
/// reason passes through.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listed {
    pub id: String,
    pub note_id: String,
    pub title: String,
    pub word_count: i64,
    pub reason: String,
    pub created_at: String,
}

/// A kept version with what it restores to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Kept {
    pub listed: Listed,
    pub content: String,
}

/// Keeps `version` unless the note already has one with the same content (which is moved up
/// to the newest instead, 1 ms past it on a clock behind), or it is an automatic or timer version less than
/// [`MIN_INTERVAL_MS`] after the note's last one. True when a row was written.
pub fn keep(conn: &Connection, version: Version<'_>, now_ms: i64) -> Result<bool, StorageError> {
    let hash = content_hash(version.content);
    let held = conn
        .execute(
            "UPDATE note_snapshots SET created_at = MAX(created_at, ?3)
             WHERE note_id = ?1 AND content_hash = ?2",
            params![
                version.note_id,
                hash,
                dated(conn, version.note_id, now_ms, 1)?
            ],
        )
        .map_err(failed)?;
    if held > 0 {
        return Ok(false);
    }
    if matches!(version.reason, Reason::Auto | Reason::Timer)
        && latest_ms(conn, version.note_id)?.is_some_and(|at| now_ms - at < MIN_INTERVAL_MS)
    {
        return Ok(false);
    }
    insert(conn, &version, &hash, now_ms)?;
    Ok(true)
}

/// Keeps `version` even when the note holds one with its content: the text a restore
/// replaces, kept as the newest version (`createSnapshot(.., forceCreate)`).
pub fn keep_always(
    conn: &Connection,
    version: Version<'_>,
    now_ms: i64,
) -> Result<(), StorageError> {
    insert(conn, &version, &content_hash(version.content), now_ms)
}

/// Whether replacing `old_body` with `new_body` moves the word count by
/// [`SIGNIFICANT_WORDS`] or more (`maybeCreateSignificantSnapshot`).
pub fn is_significant(old_body: &str, new_body: &str) -> bool {
    word_count(old_body).abs_diff(word_count(new_body)) >= SIGNIFICANT_WORDS
}

/// The note's versions, newest first (`getVersionHistory`).
pub fn list(conn: &Connection, note_id: &str) -> Result<Vec<Listed>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT id, note_id, title, word_count, reason, created_at FROM note_snapshots
             WHERE note_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![note_id, MAX_PER_NOTE], listed)
        .map_err(failed)?;
    rows.collect::<Result<_, _>>().map_err(failed)
}

/// One version by its id (`getVersion`).
pub fn get(conn: &Connection, id: &str) -> Result<Option<Kept>, StorageError> {
    conn.query_row(
        "SELECT id, note_id, title, word_count, reason, created_at, content FROM note_snapshots
         WHERE id = ?1",
        params![id],
        |row| {
            Ok(Kept {
                listed: listed(row)?,
                content: row.get(6)?,
            })
        },
    )
    .optional()
    .map_err(failed)
}

/// Deletes one version. True when it was there; the note and its other versions stay.
pub fn delete(conn: &Connection, id: &str) -> Result<bool, StorageError> {
    let deleted = conn
        .execute("DELETE FROM note_snapshots WHERE id = ?1", params![id])
        .map_err(failed)?;
    Ok(deleted > 0)
}

fn listed(row: &rusqlite::Row<'_>) -> rusqlite::Result<Listed> {
    Ok(Listed {
        id: row.get(0)?,
        note_id: row.get(1)?,
        title: row.get(2)?,
        word_count: row.get(3)?,
        reason: row.get(4)?,
        created_at: row.get(5)?,
    })
}

/// When the note's newest version was kept; `None` for none, or a time that does not read
/// (which, as `new Date(..)` gives `NaN`, never holds a version back).
fn latest_ms(conn: &Connection, note_id: &str) -> Result<Option<i64>, StorageError> {
    let latest: Option<String> = conn
        .query_row(
            "SELECT created_at FROM note_snapshots WHERE note_id = ?1
             ORDER BY created_at DESC LIMIT 1",
            params![note_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    Ok(latest.as_deref().and_then(instants::to_epoch_ms))
}

/// The date of a version kept now: `now_ms`, or `past` ms after the note's newest version
/// when that is later (a clock behind). A new row takes `past` 0: dates that tie order by the
/// row written last. A row moved up takes 1, as it was written before the newest.
fn dated(conn: &Connection, note_id: &str, now_ms: i64, past: i64) -> Result<String, StorageError> {
    let at = match latest_ms(conn, note_id)? {
        Some(latest) => now_ms.max(latest + past),
        None => now_ms,
    };
    instants::to_iso8601(at).ok_or_else(|| StorageError::Failed {
        what: format!("{at} is not a representable instant"),
    })
}

/// Writes the row, [`dated`], then prunes the note to its newest [`MAX_PER_NOTE`]
/// (`pruneOldSnapshots`): the new row and the newest others.
fn insert(
    conn: &Connection,
    version: &Version<'_>,
    hash: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let id = crate::domain::inbox::write::mint_id();
    conn.execute(
        "INSERT INTO note_snapshots
           (id, note_id, content, title, word_count, content_hash, reason, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            id,
            version.note_id,
            version.content,
            version.title,
            i64::try_from(word_count(version.body)).unwrap_or(i64::MAX),
            hash,
            version.reason.as_str(),
            dated(conn, version.note_id, now_ms, 0)?,
        ],
    )
    .map_err(failed)?;
    conn.execute(
        "DELETE FROM note_snapshots WHERE note_id = ?1 AND id != ?2 AND id NOT IN (
           SELECT id FROM note_snapshots WHERE note_id = ?1 AND id != ?2
           ORDER BY created_at DESC, rowid DESC LIMIT ?3)",
        params![version.note_id, id, MAX_PER_NOTE - 1],
    )
    .map_err(failed)?;
    Ok(())
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
