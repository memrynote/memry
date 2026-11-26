//! Bodies kept decoded between this device's writes (#5692).
//!
//! A write needs the body as a document, and the body is its update log. A
//! replay of the log for every write made each edit cost the whole history:
//! the 5,001st edit of a note applied 5,000 updates before it changed one
//! word, until a sync folded the log.
//!
//! The log stays the only owner of the body. A resident body is the document
//! the last write left, kept with the [`LogMark`] of the log it was replayed
//! from and the one update that write authored. The next write takes it only
//! while the log is exactly that log plus that update, the case where a replay
//! would build the same document, and replays otherwise. Any other writer of
//! the log, a pull, a fold, a purge, another process, or an authored update
//! that never committed, costs one replay and never a stale body.
//!
//! A kept body is decrypted plaintext, so it goes when its document is purged
//! (chapter 07 §7.15.1) and when its database closes, as a vault close or a
//! sign-out does: memory frees what the log no longer holds.
//!
//! Bodies are kept per open connection, never per path. A sign-out wipes a
//! vault and a re-sign-in recreates its data.db at the same path, maybe while
//! a handle on the old file still lives; the new log can carry the same
//! epoch, row count and newest seq as the old one, so a path-keyed body
//! would serve the deleted vault's plaintext to the new one, and the next
//! edit would be authored on top of it and lost on replay.

use std::sync::{Arc, Mutex, PoisonError};

use rusqlite::{Connection, OptionalExtension as _, params};

use crate::api::errors::StorageError;

use super::epoch::{self, Epoch};
use super::errors::CrdtError;
use super::registry::{Document, UpdateSink};
use super::update_log::Namespace;

/// How many bodies each connection keeps decoded: the notes a user moves
/// between. Counted per connection, so one vault's writes never evict another's.
const KEPT: usize = 4;

static RESIDENT: Mutex<Cache> = Mutex::new(Cache {
    open: Vec::new(),
    kept: Vec::new(),
});

struct Cache {
    /// The connections that keep bodies: file-backed ones a `Db` owns,
    /// registered at open and removed as the connection closes.
    open: Vec<ConnectionId>,
    kept: Vec<Resident>,
}

/// The address of a `Db`'s connection. Unique while the connection is open,
/// and every body kept under it goes before the connection closes, so an
/// address reused by a later connection finds nothing kept.
type ConnectionId = usize;

fn connection_id(conn: &Connection) -> ConnectionId {
    std::ptr::from_ref(conn) as ConnectionId
}

/// A body checked out for one write. Dropped, it is forgotten: only
/// [`Body::keep`] puts it back.
pub(crate) struct Body {
    key: Option<Key>,
    mark: LogMark,
    document: Arc<Document>,
    authored: Authored,
}

type Authored = Arc<Mutex<Vec<Vec<u8>>>>;

/// One body of one open connection, written as one device.
///
/// Invariant: a kept body is only ever served to the connection that
/// replayed it; a new connection on the same path always replays.
#[derive(Clone, PartialEq, Eq)]
struct Key {
    connection: ConnectionId,
    doc_id: String,
    device_id: String,
}

struct Resident {
    key: Key,
    body: Body,
    /// The update the write that kept this body authored, which the log must
    /// end with before the body is taken again.
    expected: Option<Vec<u8>>,
}

/// What a replay of `doc_id`'s log depends on: its epoch, both snapshots, and
/// both namespaces' rows. Two equal marks are the same log, because every
/// write to it inserts a row, replaces a snapshot, or bumps the epoch.
#[derive(Debug, Clone, PartialEq, Eq)]
struct LogMark {
    epoch: Epoch,
    server_snapshot: Option<SnapshotMark>,
    local_snapshot: Option<SnapshotMark>,
    server_rows: RowsMark,
    local_rows: RowsMark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SnapshotMark {
    last_seq: i64,
    compacted_at: i64,
    len: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RowsMark {
    count: i64,
    high: Option<i64>,
}

/// `doc_id`'s body, opened to author a write as `device_id`: the resident one
/// when the log has not moved past it, else replayed from the log. Inside the
/// transaction that stores what it authors ([`epoch::require_write_lock`]).
pub(crate) fn checkout(
    conn: &Connection,
    device_id: &str,
    doc_id: &str,
) -> Result<Body, CrdtError> {
    epoch::require_write_lock(conn, doc_id)?;
    let connection = connection_id(conn);
    let key = lock(&RESIDENT).open.contains(&connection).then(|| Key {
        connection,
        doc_id: doc_id.to_owned(),
        device_id: device_id.to_owned(),
    });
    // Read before the replay: a row landing between the two leaves the mark
    // behind the document, which the next checkout sees as a moved log.
    let mark = LogMark::read(conn, doc_id)?;
    if let Some(key) = &key
        && let Some(resident) = take(key)
        && resident.still_current(conn, doc_id, &mark)?
    {
        let mut body = resident.body;
        body.mark = mark;
        return Ok(body);
    }

    let authored: Authored = Arc::new(Mutex::new(Vec::new()));
    let sink: UpdateSink = {
        let authored = Arc::clone(&authored);
        Arc::new(move |_, bytes: &[u8]| lock(&authored).push(bytes.to_vec()))
    };
    let document = epoch::open_for_write(conn, device_id, doc_id, sink)?;
    Ok(Body {
        key,
        mark,
        document,
        authored,
    })
}

impl Body {
    pub(crate) fn document(&self) -> &Document {
        &self.document
    }

    /// Every update this checkout's writes authored, in order.
    pub(crate) fn take_authored(&self) -> Vec<Vec<u8>> {
        std::mem::take(&mut *lock(&self.authored))
    }

    /// Keeps the body for the next write, which takes it only once the log
    /// holds `authored` as its newest local row, or holds nothing new when it
    /// is `None`.
    pub(crate) fn keep(self, authored: Option<Vec<u8>>) {
        let Some(key) = self.key.clone() else {
            return;
        };
        let evicted = {
            let mut cache = lock(&RESIDENT);
            let mut same_connection = 0;
            let (evicted, kept) = std::mem::take(&mut cache.kept)
                .into_iter()
                .partition(|kept| {
                    kept.key == key
                        || (kept.key.connection == key.connection && {
                            same_connection += 1;
                            same_connection >= KEPT
                        })
                });
            cache.kept = kept;
            cache.kept.insert(
                0,
                Resident {
                    key,
                    body: self,
                    expected: authored,
                },
            );
            evicted
        };
        drop::<Vec<Resident>>(evicted);
    }
}

/// Lets `conn`, a file-backed connection a `Db` just opened, keep bodies.
pub(crate) fn open_connection(conn: &Connection) {
    lock(&RESIDENT).open.push(connection_id(conn));
}

/// Drops every body kept for `conn`, which is closing.
pub(crate) fn release_connection(conn: &Connection) {
    let connection = connection_id(conn);
    lock(&RESIDENT).open.retain(|open| *open != connection);
    drop(forget(|key| key.connection == connection));
}

/// Drops `doc_id`'s kept bodies, for a purge of its log.
pub(crate) fn release_document(conn: &Connection, doc_id: &str) {
    let connection = connection_id(conn);
    drop(forget(|key| {
        key.connection == connection && key.doc_id == doc_id
    }));
}

/// Takes the matching bodies out under the lock, so the caller drops them
/// after it: a document's drop never runs while the cache is locked.
fn forget(matches: impl Fn(&Key) -> bool) -> Vec<Resident> {
    let mut cache = lock(&RESIDENT);
    let (gone, kept) = std::mem::take(&mut cache.kept)
        .into_iter()
        .partition(|kept| matches(&kept.key));
    cache.kept = kept;
    gone
}

fn take(key: &Key) -> Option<Resident> {
    let mut cache = lock(&RESIDENT);
    let at = cache.kept.iter().position(|kept| &kept.key == key)?;
    Some(cache.kept.remove(at))
}

impl Resident {
    /// Whether a replay of the log at `now` builds this body: the log is the
    /// one it was replayed from, plus the update its write authored.
    fn still_current(
        &self,
        conn: &Connection,
        doc_id: &str,
        now: &LogMark,
    ) -> Result<bool, CrdtError> {
        let before = &self.body.mark;
        let Some(expected) = &self.expected else {
            return Ok(now == before);
        };
        let grown = LogMark {
            local_rows: RowsMark {
                count: before.local_rows.count + 1,
                high: now.local_rows.high,
            },
            ..before.clone()
        };
        let Some(high) = now
            .local_rows
            .high
            .filter(|high| Some(*high) != before.local_rows.high)
        else {
            return Ok(false);
        };
        Ok(*now == grown && local_row(conn, doc_id, high)?.as_ref() == Some(expected))
    }
}

impl LogMark {
    fn read(conn: &Connection, doc_id: &str) -> Result<Self, CrdtError> {
        let server = Namespace::Server.row_id(doc_id);
        let local = Namespace::Local.row_id(doc_id);
        Ok(Self {
            epoch: epoch::capture(conn, doc_id)?,
            server_snapshot: snapshot_mark(conn, &server)?,
            local_snapshot: snapshot_mark(conn, &local)?,
            server_rows: rows_mark(conn, &server)?,
            local_rows: rows_mark(conn, &local)?,
        })
    }
}

fn snapshot_mark(conn: &Connection, row_id: &str) -> Result<Option<SnapshotMark>, CrdtError> {
    Ok(conn
        .prepare_cached(
            "SELECT last_seq, compacted_at, length(snapshot) FROM yjs_snapshots WHERE doc_id = ?1",
        )
        .and_then(|mut statement| {
            statement
                .query_row(params![row_id], |row| {
                    Ok(SnapshotMark {
                        last_seq: row.get(0)?,
                        compacted_at: row.get(1)?,
                        len: row.get(2)?,
                    })
                })
                .optional()
        })
        .map_err(failed("read a snapshot mark"))?)
}

fn rows_mark(conn: &Connection, row_id: &str) -> Result<RowsMark, CrdtError> {
    Ok(conn
        .prepare_cached("SELECT COUNT(*), MAX(seq) FROM yjs_updates WHERE doc_id = ?1")
        .and_then(|mut statement| {
            statement.query_row(params![row_id], |row| {
                Ok(RowsMark {
                    count: row.get(0)?,
                    high: row.get(1)?,
                })
            })
        })
        .map_err(failed("read an update-log mark"))?)
}

fn local_row(conn: &Connection, doc_id: &str, seq: i64) -> Result<Option<Vec<u8>>, CrdtError> {
    Ok(conn
        .prepare_cached("SELECT update_blob FROM yjs_updates WHERE doc_id = ?1 AND seq = ?2")
        .and_then(|mut statement| {
            statement
                .query_row(params![Namespace::Local.row_id(doc_id), seq], |row| {
                    row.get(0)
                })
                .optional()
        })
        .map_err(failed("read the newest local update"))?)
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn failed(what: &'static str) -> impl Fn(rusqlite::Error) -> StorageError {
    move |err| StorageError::Failed {
        what: format!("could not {what}: {err}"),
    }
}

#[cfg(test)]
#[path = "resident_tests.rs"]
mod tests;
