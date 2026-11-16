//! Where each note's body stands with the server (#2647), Electron's
//! `note-body-push-record.ts` and `note-sync-state.ts`.
//!
//! The body travels as CRDT updates, which never move a record's `synced_at`,
//! so that column cannot say whether the latest text reached the server. The
//! state is built from three local facts:
//!
//! - waiting changes: the note's `outbox` rows (body updates and record
//!   changes) and its owed file body ([`crate::domain::owed_file_body`]);
//! - what the push wave did with its body: the `note_body_sync` row, written
//!   by [`record`] when a body push starts and ends and when the server stores
//!   a snapshot of the whole document;
//! - whether this install syncs at all, and whether the note is local-only.
//!
//! The push wave is shared, so iOS's `sync_now` writes the rows too; only the
//! desktop reads them (`sync_get_note_sync_state`, `sync_get_unsent_notes`,
//! `sync_get_large_notes`). A write that fails fails the wave like the outbox
//! write beside it, in the same transaction where there is one.
//!
//! Only a 2xx from a CRDT body route sets the confirmed time. Only a stored
//! snapshot clears a refusal: a refused update's rows are dropped, so a later
//! update carries only its own change, never the dropped text.

use std::collections::HashMap;

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;
use crate::protocol::envelope::NOTE_SYNC_MAX_BYTES;
use crate::sync::outbox::OP_CRDT_UPDATE;

/// The settings list names the oldest notes; `total` still counts every one.
pub const MAX_UNSENT_NOTES: usize = 200;
/// `large-notes.ts` `MAX_ENTRIES`.
pub const MAX_LARGE_NOTES: usize = 50;

/// What the push wave did with a note's body (`NoteBodyPushEvent`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushEvent {
    /// A body push started.
    Sent,
    /// The server stored body updates.
    Confirmed,
    /// The server stored the whole document.
    Snapshot,
    /// A body push failed; its rows wait for a retry.
    Failed,
    /// Body rows were dropped for good; only a stored snapshot carries them.
    Rejected,
}

/// Records `event` for `doc_id` at `at`, keeping every other column.
pub fn record(
    conn: &Connection,
    doc_id: &str,
    event: PushEvent,
    at: i64,
) -> Result<(), StorageError> {
    let set = match event {
        PushEvent::Sent => "last_sent_at = ?2",
        PushEvent::Confirmed => "last_confirmed_at = ?2",
        PushEvent::Snapshot => "last_confirmed_at = ?2, last_snapshot_at = ?2",
        PushEvent::Failed => "last_failed_at = ?2",
        PushEvent::Rejected => "last_rejected_at = ?2",
    };
    conn.execute(
        "INSERT INTO note_body_sync (note_id, updated_at) VALUES (?1, ?2)
         ON CONFLICT(note_id) DO NOTHING",
        params![doc_id, at],
    )
    .map_err(failed)?;
    conn.execute(
        &format!("UPDATE note_body_sync SET {set}, updated_at = ?2 WHERE note_id = ?1"),
        params![doc_id, at],
    )
    .map(|_| ())
    .map_err(failed)
}

/// `NoteSyncStateValue`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncStateValue {
    NotSyncing,
    LocalOnly,
    Pending,
    Sent,
    Confirmed,
    NotRecorded,
    Rejected,
}

impl SyncStateValue {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotSyncing => "not_syncing",
            Self::LocalOnly => "local_only",
            Self::Pending => "pending",
            Self::Sent => "sent",
            Self::Confirmed => "confirmed",
            Self::NotRecorded => "not_recorded",
            Self::Rejected => "rejected",
        }
    }
}

/// `NoteSyncState`. Times are epoch milliseconds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteSyncState {
    pub state: SyncStateValue,
    /// Oldest change still waiting on this device.
    pub waiting_since: Option<i64>,
    pub last_sent_at: Option<i64>,
    pub body_confirmed_at: Option<i64>,
    pub last_failed_at: Option<i64>,
    pub last_rejected_at: Option<i64>,
}

/// A note's waiting changes, oldest of each kind.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Waiting {
    pub body: Option<i64>,
    pub record: Option<i64>,
    pub file_not_taken: Option<i64>,
}

/// A `note_body_sync` row.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Pushes {
    pub sent: Option<i64>,
    pub confirmed: Option<i64>,
    pub failed: Option<i64>,
    pub rejected: Option<i64>,
    pub snapshot: Option<i64>,
}

impl Pushes {
    /// Refused after the last stored snapshot.
    fn refused(&self) -> bool {
        self.rejected
            .is_some_and(|rejected| rejected > self.snapshot.unwrap_or(-1))
    }
}

fn oldest(times: [Option<i64>; 3]) -> Option<i64> {
    times.into_iter().flatten().min()
}

/// `deriveNoteSyncState`.
pub fn derive(
    local_only: bool,
    waiting: Waiting,
    pushes: Pushes,
    sync_eligible: bool,
) -> NoteSyncState {
    let waiting_since = oldest([waiting.body, waiting.record, waiting.file_not_taken]);
    let state = if !sync_eligible {
        SyncStateValue::NotSyncing
    } else if local_only {
        SyncStateValue::LocalOnly
    } else if waiting_since.is_some() {
        // A failure since the last stored push means the wave is retrying:
        // the change is still waiting even while a retry is out.
        let retrying = pushes
            .failed
            .is_some_and(|failed| failed > pushes.confirmed.unwrap_or(-1));
        let answered = pushes
            .confirmed
            .unwrap_or(-1)
            .max(pushes.rejected.unwrap_or(-1));
        if !retrying && pushes.sent.is_some_and(|sent| sent > answered) {
            SyncStateValue::Sent
        } else {
            SyncStateValue::Pending
        }
    } else if pushes.refused() {
        SyncStateValue::Rejected
    } else if pushes.confirmed.is_none() {
        SyncStateValue::NotRecorded
    } else {
        SyncStateValue::Confirmed
    };
    NoteSyncState {
        state,
        waiting_since,
        last_sent_at: pushes.sent,
        body_confirmed_at: pushes.confirmed,
        last_failed_at: pushes.failed,
        last_rejected_at: pushes.rejected,
    }
}

/// A note this vault knows: one with a file row.
#[derive(Debug, Clone, PartialEq, Eq)]
struct NoteMeta {
    title: String,
    path: String,
    file_type: String,
    local_only: bool,
}

/// `getNoteSyncState`: `None` for an id with no live note.
pub fn note_sync_state(
    conn: &Connection,
    note_id: &str,
    sync_eligible: bool,
) -> Result<Option<NoteSyncState>, StorageError> {
    let Some(meta) = notes(conn, Some(note_id))?.remove(note_id) else {
        return Ok(None);
    };
    let waiting = waiting(conn, Some(note_id))?
        .remove(note_id)
        .unwrap_or_default();
    let pushes = pushes(conn, Some(note_id))?
        .remove(note_id)
        .unwrap_or_default();
    Ok(Some(derive(
        meta.local_only,
        waiting,
        pushes,
        sync_eligible,
    )))
}

/// `UnsentNoteReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnsentReason {
    Body,
    Record,
    FileNotTaken,
    Rejected,
}

impl UnsentReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Body => "body",
            Self::Record => "record",
            Self::FileNotTaken => "file_not_taken",
            Self::Rejected => "rejected",
        }
    }
}

/// `UnsentNoteEntry`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsentNote {
    pub id: String,
    pub title: String,
    pub path: String,
    pub state: SyncStateValue,
    pub waiting_since: Option<i64>,
    pub reasons: Vec<UnsentReason>,
}

/// `UnsentNotesResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsentNotes {
    /// Every note with unsent changes, even past the listed ones.
    pub total: usize,
    pub notes: Vec<UnsentNote>,
}

/// `listUnsentNotes`: every live note that is not local-only with changes the
/// server has not stored, refused ones first, then oldest waiting first, at
/// most `limit` of them.
pub fn unsent_notes(
    conn: &Connection,
    sync_eligible: bool,
    limit: usize,
) -> Result<UnsentNotes, StorageError> {
    let meta = notes(conn, None)?;
    let mut waiting = waiting(conn, None)?;
    let mut pushes = pushes(conn, None)?;
    let mut ids: Vec<String> = waiting.keys().cloned().collect();
    ids.extend(
        pushes
            .iter()
            .filter(|(_, row)| row.refused())
            .map(|(id, _)| id.clone()),
    );
    ids.sort();
    ids.dedup();
    let mut list = Vec::new();
    for id in ids {
        let Some(note) = meta.get(&id).filter(|note| !note.local_only) else {
            continue;
        };
        let changes = waiting.remove(&id).unwrap_or_default();
        let state = derive(
            false,
            changes,
            pushes.remove(&id).unwrap_or_default(),
            sync_eligible,
        );
        let reasons: Vec<UnsentReason> = [
            (changes.body.is_some(), UnsentReason::Body),
            (changes.record.is_some(), UnsentReason::Record),
            (changes.file_not_taken.is_some(), UnsentReason::FileNotTaken),
            (
                state.state == SyncStateValue::Rejected,
                UnsentReason::Rejected,
            ),
        ]
        .into_iter()
        .filter_map(|(holds, reason)| holds.then_some(reason))
        .collect();
        if reasons.is_empty() {
            continue;
        }
        list.push(UnsentNote {
            id,
            title: note.title.clone(),
            path: note.path.clone(),
            state: state.state,
            waiting_since: state.waiting_since,
            reasons,
        });
    }
    list.sort_by_key(|note| {
        (
            !note.reasons.contains(&UnsentReason::Rejected),
            note.waiting_since.unwrap_or(i64::MAX),
        )
    });
    let total = list.len();
    list.truncate(limit);
    Ok(UnsentNotes { total, notes: list })
}

/// `NoteSyncSizeStatus` past `ok`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SizeStatus {
    /// At or above the warning size: still syncs.
    Approaching,
    /// Over the limit: stopped syncing.
    Over,
}

impl SizeStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Approaching => "approaching",
            Self::Over => "over",
        }
    }
}

/// `LargeNoteEntry`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LargeNote {
    pub id: String,
    pub title: String,
    pub path: String,
    pub size_bytes: u64,
    pub status: SizeStatus,
}

/// `LargeNotesResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LargeNotes {
    /// Largest note the sync path accepts.
    pub max_bytes: u64,
    pub notes: Vec<LargeNote>,
}

/// A note `large_notes` may measure, read under the database lock.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LargeNoteCandidate {
    id: String,
    meta: NoteMeta,
}

/// The markdown notes that sync, for [`large_notes`] to measure outside the
/// database lock. Attachments ride the blob routes, which the plan's per-file
/// limit governs (`large-notes.ts:36`).
pub fn large_note_candidates(conn: &Connection) -> Result<Vec<LargeNoteCandidate>, StorageError> {
    Ok(notes(conn, None)?
        .into_iter()
        .filter(|(_, meta)| meta.file_type == "markdown" && !meta.local_only)
        .map(|(id, meta)| LargeNoteCandidate { id, meta })
        .collect())
}

/// `listLargeNotes`: `measure` answers a vault-relative path's file size, or
/// `None` when the file is gone. Largest first, at most [`MAX_LARGE_NOTES`].
pub fn large_notes(
    candidates: Vec<LargeNoteCandidate>,
    measure: impl Fn(&str) -> Option<u64>,
) -> LargeNotes {
    let max = NOTE_SYNC_MAX_BYTES as u64;
    let warn = crate::api::large_notes::warn_bytes() as u64;
    let mut notes: Vec<LargeNote> = candidates
        .into_iter()
        .filter_map(|candidate| {
            let size_bytes = measure(&candidate.meta.path)?;
            let status = if size_bytes > max {
                SizeStatus::Over
            } else if size_bytes >= warn {
                SizeStatus::Approaching
            } else {
                return None;
            };
            Some(LargeNote {
                id: candidate.id,
                title: candidate.meta.title,
                path: candidate.meta.path,
                size_bytes,
                status,
            })
        })
        .collect();
    notes.sort_by_key(|note| std::cmp::Reverse(note.size_bytes));
    notes.truncate(MAX_LARGE_NOTES);
    LargeNotes {
        max_bytes: max,
        notes,
    }
}

/// Live notes and journal days with a file row, `only` one id or all.
fn notes(conn: &Connection, only: Option<&str>) -> Result<HashMap<String, NoteMeta>, StorageError> {
    let mut statement = conn
        .prepare_cached(
            "SELECT f.note_id, COALESCE(n.title, j.date, ''), f.path, f.file_type, f.local_only
               FROM note_files f
               LEFT JOIN notes n ON n.id = f.note_id
               LEFT JOIN journal_entries j ON j.id = f.note_id
              WHERE (?1 IS NULL OR f.note_id = ?1)
                AND n.deleted_at IS NULL AND j.deleted_at IS NULL",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![only], |row| {
            Ok((
                row.get::<_, String>(0)?,
                NoteMeta {
                    title: row.get(1)?,
                    path: row.get(2)?,
                    file_type: row.get(3)?,
                    local_only: row.get::<_, i64>(4)? != 0,
                },
            ))
        })
        .map_err(failed)?;
    rows.collect::<Result<_, _>>().map_err(failed)
}

/// Oldest waiting change of each kind per note, `only` one id or all.
fn waiting(
    conn: &Connection,
    only: Option<&str>,
) -> Result<HashMap<String, Waiting>, StorageError> {
    let mut found: HashMap<String, Waiting> = HashMap::new();
    let mut queued = conn
        .prepare_cached(
            "SELECT item_id, op = ?2, MIN(enqueued_at) FROM outbox
              WHERE item_type IN ('note', 'journal') AND (?1 IS NULL OR item_id = ?1)
              GROUP BY item_id, op = ?2",
        )
        .map_err(failed)?;
    let rows = queued
        .query_map(params![only, OP_CRDT_UPDATE], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, bool>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(failed)?;
    for row in rows {
        let (id, body, at) = row.map_err(failed)?;
        let entry = found.entry(id).or_default();
        let slot = if body {
            &mut entry.body
        } else {
            &mut entry.record
        };
        *slot = Some(slot.map_or(at, |held| held.min(at)));
    }
    let owed = match only {
        Some(id) => crate::domain::owed_file_body::recorded_at(conn, id)?
            .map(|at| vec![(id.to_owned(), at)])
            .unwrap_or_default(),
        None => crate::domain::owed_file_body::all_recorded(conn)?,
    };
    for (id, at) in owed {
        found.entry(id).or_default().file_not_taken = Some(at);
    }
    Ok(found)
}

/// `note_body_sync` rows, `only` one id or all.
fn pushes(conn: &Connection, only: Option<&str>) -> Result<HashMap<String, Pushes>, StorageError> {
    let mut statement = conn
        .prepare_cached(
            "SELECT note_id, last_sent_at, last_confirmed_at, last_failed_at,
                    last_rejected_at, last_snapshot_at
               FROM note_body_sync WHERE (?1 IS NULL OR note_id = ?1)",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![only], |row| {
            Ok((
                row.get::<_, String>(0)?,
                Pushes {
                    sent: row.get(1)?,
                    confirmed: row.get(2)?,
                    failed: row.get(3)?,
                    rejected: row.get(4)?,
                    snapshot: row.get(5)?,
                },
            ))
        })
        .map_err(failed)?;
    rows.collect::<Result<_, _>>().map_err(failed)
}

/// One document's `note_body_sync` row, `None` without one.
pub fn pushes_of(conn: &Connection, doc_id: &str) -> Result<Option<Pushes>, StorageError> {
    Ok(pushes(conn, Some(doc_id))?.remove(doc_id))
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

#[cfg(test)]
#[path = "body_state_tests.rs"]
mod tests;
