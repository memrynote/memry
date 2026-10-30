//! Path identity and file state of every vault file (desktop Step 12).
//!
//! The `note_files` table (migration 15) holds one row per note id: the
//! vault-relative path, the kind of file, its size and the content hash of the
//! bytes the index last read. It is device-local and never synced.
//!
//! ## Path format
//!
//! A path is vault-relative, `/`-separated, with no leading or trailing `/`, no
//! empty, `.` or `..` segment, no `\` and no NUL. The prefix range in
//! [`rename_prefix`] and the `UNIQUE` key both rely on it, so a path that breaks
//! the format is refused ([`StorageError::Invalid`]) instead of stored. A caller
//! on Windows converts separators first.
//!
//! The core keeps the bytes it is given. It does not fold case and does not
//! normalize Unicode: `a.md` and `A.md`, or an NFC and an NFD spelling, are
//! different keys here. Case-insensitive and normalization-insensitive file
//! systems (APFS, NTFS) report one file under one spelling, and the vault tier
//! that reads the file system is the owner of keeping those spellings apart.
//!
//! ## Hash
//!
//! `content_hash` is the desktop vault tier's string, opaque here. A stat write
//! replaces it with the value the caller read (`None` clears it), so a row never
//! pairs a new stat with the hash of older bytes.
//!
//! `file_hash` (table `note_file_hashes`, migration 17) is the same kind of
//! string for the bytes on disk now, whether or not the note's document took
//! them, or `None` when the tier does not know them: it is never the hash of
//! bytes that went or were replaced. Rename pairing reads it, and a removal of
//! a row that has one is of a file whose bytes the tier knew. Every stat write
//! and [`set_hash`] replace it too, and [`set_file_hash`] records a read that
//! changed nothing else.

use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::api::errors::StorageError;
use crate::crdt::update_log;

const COLUMNS: &str = "f.note_id, f.path, f.file_type, f.mime_type, f.file_size, f.content_hash,
     f.local_only, f.indexed_at, h.file_hash";

/// The rows with their file hashes, `f` and `h`.
const ROWS: &str = "note_files f LEFT JOIN note_file_hashes h ON h.note_id = f.note_id";

/// One `note_files` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteFile {
    pub note_id: String,
    pub path: String,
    /// `markdown`, `pdf`, `image`, `audio`, `video`, ...: desktop's file kinds.
    pub file_type: String,
    pub mime_type: Option<String>,
    pub file_size: Option<i64>,
    pub content_hash: Option<String>,
    /// The hash of the bytes the tier last read from the file (module doc).
    pub file_hash: Option<String>,
    pub local_only: bool,
    /// The row's stamp, in this device's milliseconds since the epoch. One meaning for every
    /// writer and reader: the row accounts for every change to the file and to the note's
    /// body made at or before it. The file was then the bytes the row names (`content_hash`,
    /// size), so a file modified later has a later mtime and is read again; and the body held
    /// those bytes, so a body entry stamped later puts the note behind its body
    /// ([`behind_bodies`]). A writer that saw only one side keeps the stamp the other side
    /// allows ([`refresh_stat`]).
    pub indexed_at: i64,
}

/// What a stat write sets. `local_only` is not part of it: only
/// [`set_local_only`] changes it, and a new row starts `false`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteFileStat {
    pub note_id: String,
    pub path: String,
    pub file_type: String,
    pub mime_type: Option<String>,
    pub file_size: Option<i64>,
    pub content_hash: Option<String>,
    pub file_hash: Option<String>,
    pub indexed_at: i64,
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

fn is_constraint(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(code, _)
            if code.code == rusqlite::ErrorCode::ConstraintViolation
    )
}

fn invalid(what: String) -> StorageError {
    StorageError::Invalid { what }
}

fn not_found(what: &str) -> StorageError {
    StorageError::NotFound {
        what: what.to_owned(),
    }
}

/// Refuses a path that breaks the format in the module doc.
pub fn check_path(path: &str) -> Result<(), StorageError> {
    let bad = path.is_empty()
        || path.contains(['\\', '\0'])
        || path
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == "..");
    if bad {
        return Err(invalid(format!(
            "note file path is not a vault-relative '/' path: {path:?}"
        )));
    }
    Ok(())
}

fn row_to_file(row: &Row<'_>) -> rusqlite::Result<NoteFile> {
    Ok(NoteFile {
        note_id: row.get(0)?,
        path: row.get(1)?,
        file_type: row.get(2)?,
        mime_type: row.get(3)?,
        file_size: row.get(4)?,
        content_hash: row.get(5)?,
        local_only: row.get::<_, i64>(6)? != 0,
        indexed_at: row.get(7)?,
        file_hash: row.get(8)?,
    })
}

pub fn by_path(conn: &Connection, path: &str) -> Result<Option<NoteFile>, StorageError> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM {ROWS} WHERE f.path = ?1"),
        params![path],
        row_to_file,
    )
    .optional()
    .map_err(failed)
}

pub fn by_id(conn: &Connection, note_id: &str) -> Result<Option<NoteFile>, StorageError> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM {ROWS} WHERE f.note_id = ?1"),
        params![note_id],
        row_to_file,
    )
    .optional()
    .map_err(failed)
}

/// Inserts the row of `stat.note_id` or replaces its path, kind, size, hashes and
/// time, keeping `local_only`. A path another note holds is refused: it is never
/// taken over silently.
pub fn upsert_stat(conn: &mut Connection, stat: &NoteFileStat) -> Result<(), StorageError> {
    check_path(&stat.path)?;
    let tx = conn.transaction().map_err(failed)?;
    tx.execute(
        "INSERT INTO note_files
           (note_id, path, file_type, mime_type, file_size, content_hash, indexed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(note_id) DO UPDATE SET
           path = excluded.path, file_type = excluded.file_type,
           mime_type = excluded.mime_type, file_size = excluded.file_size,
           content_hash = excluded.content_hash, indexed_at = excluded.indexed_at",
        params![
            stat.note_id,
            stat.path,
            stat.file_type,
            stat.mime_type,
            stat.file_size,
            stat.content_hash,
            stat.indexed_at
        ],
    )
    .map_err(|err| {
        if is_constraint(&err) {
            invalid(format!("path {:?} belongs to another note", stat.path))
        } else {
            failed(err)
        }
    })?;
    write_file_hash(&tx, &stat.note_id, stat.file_hash.as_deref())?;
    tx.commit().map_err(failed)
}

fn write_file_hash(
    conn: &Connection,
    note_id: &str,
    file_hash: Option<&str>,
) -> Result<(), StorageError> {
    match file_hash {
        Some(hash) => conn.execute(
            "INSERT INTO note_file_hashes (note_id, file_hash) VALUES (?1, ?2)
             ON CONFLICT(note_id) DO UPDATE SET file_hash = excluded.file_hash",
            params![note_id, hash],
        ),
        None => conn.execute(
            "DELETE FROM note_file_hashes WHERE note_id = ?1",
            params![note_id],
        ),
    }
    .map(|_| ())
    .map_err(failed)
}

/// Records the hash of the bytes the tier just read from the note's file, and nothing else:
/// a read whose text the document did not take says nothing of the body, so neither
/// `content_hash` nor the stamp moves. The row must exist.
pub fn set_file_hash(
    conn: &Connection,
    note_id: &str,
    file_hash: Option<&str>,
) -> Result<(), StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let exists = tx
        .query_row(
            "SELECT 1 FROM note_files WHERE note_id = ?1",
            params![note_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(failed)?
        .is_some();
    if !exists {
        return Err(not_found(note_id));
    }
    write_file_hash(&tx, note_id, file_hash)?;
    tx.commit().map_err(failed)
}

/// [`upsert_stat`] for a file read again and found to be the bytes its row names: the row's
/// stamp moves to `stat.indexed_at` only while no body entry is stamped after it, since the
/// read says nothing of the body ([`NoteFile::indexed_at`]). The row must exist.
pub fn refresh_stat(conn: &Connection, stat: &NoteFileStat) -> Result<(), StorageError> {
    check_path(&stat.path)?;
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let changed = tx
        .execute(
            &format!(
                "UPDATE note_files SET
                   path = ?2, file_type = ?3, mime_type = ?4, file_size = ?5,
                   content_hash = ?6,
                   indexed_at = CASE WHEN {} THEN indexed_at ELSE ?7 END
                 WHERE note_id = ?1",
                body_moved_after_stamp()
            ),
            params![
                stat.note_id,
                stat.path,
                stat.file_type,
                stat.mime_type,
                stat.file_size,
                stat.content_hash,
                stat.indexed_at
            ],
        )
        .map_err(|err| {
            if is_constraint(&err) {
                invalid(format!("path {:?} belongs to another note", stat.path))
            } else {
                failed(err)
            }
        })?;
    if changed == 0 {
        return Err(not_found(&stat.note_id));
    }
    write_file_hash(&tx, &stat.note_id, stat.file_hash.as_deref())?;
    tx.commit().map_err(failed)
}

/// The SQL test, over a `note_files` row, that an entry of the note's body log or snapshot,
/// in either namespace ([`update_log`]), is stamped after the row.
fn body_moved_after_stamp() -> String {
    let local = update_log::LOCAL_NAMESPACE_PREFIX;
    format!(
        "(EXISTS (SELECT 1 FROM yjs_updates u
                   WHERE u.doc_id IN (note_files.note_id, '{local}' || note_files.note_id)
                     AND u.created_at > note_files.indexed_at)
          OR EXISTS (SELECT 1 FROM yjs_snapshots s
                      WHERE s.doc_id IN (note_files.note_id, '{local}' || note_files.note_id)
                        AND s.compacted_at > note_files.indexed_at))"
    )
}

/// Records the hash of the bytes now on disk, which the document holds, as both hashes; `None`
/// clears both (the file went, so the row names no bytes at all).
pub fn set_hash(
    conn: &Connection,
    note_id: &str,
    content_hash: Option<&str>,
) -> Result<(), StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let changed = tx
        .execute(
            "UPDATE note_files SET content_hash = ?2 WHERE note_id = ?1",
            params![note_id, content_hash],
        )
        .map_err(failed)?;
    if changed == 0 {
        return Err(not_found(note_id));
    }
    write_file_hash(&tx, note_id, content_hash)?;
    tx.commit().map_err(failed)
}

/// Moves one note to `new_path`. The path of another note is refused and the
/// row is unchanged.
pub fn rename_path(conn: &Connection, note_id: &str, new_path: &str) -> Result<(), StorageError> {
    check_path(new_path)?;
    match conn.execute(
        "UPDATE note_files SET path = ?2 WHERE note_id = ?1",
        params![note_id, new_path],
    ) {
        Ok(0) => Err(not_found(note_id)),
        Ok(_) => Ok(()),
        Err(err) if is_constraint(&err) => Err(invalid(format!(
            "path {new_path:?} belongs to another note"
        ))),
        Err(err) => Err(failed(err)),
    }
}

/// Moves every row under the folder `old_dir` to the same place under `new_dir`
/// and returns how many moved. All or nothing: a target path that another row
/// holds refuses the whole move and changes no row. A move into itself is
/// refused. Rows first move to a temporary name (a NUL cannot be in a valid
/// path), so a move whose targets overlap its sources never collides with
/// itself.
pub fn rename_prefix(
    conn: &mut Connection,
    old_dir: &str,
    new_dir: &str,
) -> Result<usize, StorageError> {
    let old_dir = old_dir.strip_suffix('/').unwrap_or(old_dir);
    let new_dir = new_dir.strip_suffix('/').unwrap_or(new_dir);
    check_path(old_dir)?;
    check_path(new_dir)?;
    if old_dir == new_dir {
        return Ok(0);
    }
    if new_dir.starts_with(&format!("{old_dir}/")) {
        return Err(invalid(format!("{new_dir:?} is inside {old_dir:?}")));
    }

    let tx = conn.transaction().map_err(failed)?;
    // `'/' + 1 == '0'`: the paths under `old_dir/` are exactly this range, with
    // no LIKE escaping. It holds under the column's default BINARY collation.
    let (low, high) = (format!("{old_dir}/"), format!("{old_dir}0"));
    let rows: Vec<(String, String)> = {
        let mut statement = tx
            .prepare("SELECT note_id, path FROM note_files WHERE path >= ?1 AND path < ?2")
            .map_err(failed)?;
        statement
            .query_map(params![low, high], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(failed)?
            .collect::<Result<_, _>>()
            .map_err(failed)?
    };
    for (note_id, _) in &rows {
        tx.execute(
            "UPDATE note_files SET path = ?2 WHERE note_id = ?1",
            params![note_id, format!("\0{note_id}")],
        )
        .map_err(failed)?;
    }
    for (note_id, path) in &rows {
        let target = format!("{new_dir}{}", &path[old_dir.len()..]);
        tx.execute(
            "UPDATE note_files SET path = ?2 WHERE note_id = ?1",
            params![note_id, target],
        )
        .map_err(|err| {
            if is_constraint(&err) {
                invalid(format!("path {target:?} belongs to another note"))
            } else {
                failed(err)
            }
        })?;
    }
    tx.commit().map_err(failed)?;
    Ok(rows.len())
}

/// Removes the row of a note. `false` when there was none.
pub fn remove(conn: &Connection, note_id: &str) -> Result<bool, StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let removed = tx
        .execute(
            "DELETE FROM note_files WHERE note_id = ?1",
            params![note_id],
        )
        .map(|n| n > 0)
        .map_err(failed)?;
    // The marker and the file hash are file state of the same note: they go with the row.
    crate::domain::owed_file_body::clear(&tx, note_id)?;
    write_file_hash(&tx, note_id, None)?;
    tx.commit().map_err(failed)?;
    Ok(removed)
}

/// Every row whose file may have been lost, by path.
///
/// A synced attachment this device never downloaded has a row with no file and
/// no size (a non-markdown kind with a size of 0 or none); its file is not
/// missing, it has not arrived, so the row is left out (desktop
/// `collectMissedRemovals`).
pub fn list_missing_candidates(conn: &Connection) -> Result<Vec<NoteFile>, StorageError> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {COLUMNS} FROM {ROWS}
              WHERE NOT (f.file_type <> 'markdown' AND COALESCE(f.file_size, 0) = 0)
              ORDER BY f.path"
        ))
        .map_err(failed)?;
    statement
        .query_map([], row_to_file)
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

/// Every note whose file may be behind its body, in id order: the row says the document
/// holds the file (a markdown row with a hash), and an entry of the note's body log or
/// snapshot, in either namespace ([`update_log`]), is stamped after the row
/// (`indexed_at`). The stamps are this device's clock at apply time, the same reading the
/// search index's watermark relies on (`domain::search::maintenance`).
///
/// A row's stamp is the time up to which it accounts for the body ([`NoteFile::indexed_at`]),
/// so this names every note whose body moved after that: an edit or a merged page whose
/// write-back never ran. An entry stamped in the same millisecond as the row is not counted,
/// so the feed that recorded the row does not name its own note.
pub fn behind_bodies(conn: &Connection) -> Result<Vec<String>, StorageError> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT note_id FROM note_files
              WHERE file_type = 'markdown' AND content_hash IS NOT NULL
                AND {}
              ORDER BY note_id",
            body_moved_after_stamp()
        ))
        .map_err(failed)?;
    statement
        .query_map([], |row| row.get(0))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

/// The markdown rows of tombstoned notes and journal days, by path: files a deletion on
/// another device, or one whose file operation a crash cut short, left in the vault. A note
/// this vault has no record of is not among them: its record may not have arrived yet, and
/// a file is not given up on an absence.
pub fn rows_of_deleted_notes(conn: &Connection) -> Result<Vec<NoteFile>, StorageError> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {COLUMNS} FROM {ROWS}
              WHERE f.file_type = 'markdown'
                AND (EXISTS (SELECT 1 FROM notes n
                              WHERE n.id = f.note_id AND n.deleted_at IS NOT NULL)
                  OR EXISTS (SELECT 1 FROM journal_entries j
                              WHERE j.id = f.note_id AND j.deleted_at IS NOT NULL))
              ORDER BY f.path"
        ))
        .map_err(failed)?;
    statement
        .query_map([], row_to_file)
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

/// Every `(note_id, path)`, for a caller that builds its own lookup (the desktop vault tier
/// keeps a case- and normalization-folded index, which the core does not).
pub fn list_paths(conn: &Connection) -> Result<Vec<(String, String)>, StorageError> {
    let mut statement = conn
        .prepare("SELECT note_id, path FROM note_files")
        .map_err(failed)?;
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

/// Writes the flag and nothing else. [`crate::domain::notes::local_only::set`]
/// is the one caller: the flag changes what is queued, and that is settled
/// there in the same transaction.
pub(crate) fn set_local_only(
    conn: &Connection,
    note_id: &str,
    local_only: bool,
) -> Result<(), StorageError> {
    let changed = conn
        .execute(
            "UPDATE note_files SET local_only = ?2 WHERE note_id = ?1",
            params![note_id, i64::from(local_only)],
        )
        .map_err(failed)?;
    if changed == 0 {
        return Err(not_found(note_id));
    }
    Ok(())
}

/// Whether the note is local-only: its changes and its body never leave this
/// device. A note with no `note_files` row (every note on a shell that keeps no
/// files, iOS among them) is not.
///
/// One primary-key probe. [`crate::sync::outbox::enqueue`] asks it for every
/// note change, and so does a push gate ([`crate::crdt::SnapshotGate`]) built
/// for a note.
pub fn is_local_only(conn: &Connection, note_id: &str) -> Result<bool, StorageError> {
    let flag: Option<i64> = conn
        .query_row(
            "SELECT local_only FROM note_files WHERE note_id = ?1",
            params![note_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    Ok(flag.is_some_and(|flag| flag != 0))
}

pub fn local_only_count(conn: &Connection) -> Result<i64, StorageError> {
    conn.query_row(
        "SELECT COUNT(*) FROM note_files WHERE local_only <> 0",
        [],
        |row| row.get(0),
    )
    .map_err(failed)
}
