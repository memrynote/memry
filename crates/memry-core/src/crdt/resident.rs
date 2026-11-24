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

use std::sync::{Arc, Mutex, PoisonError};

use rusqlite::{Connection, OptionalExtension as _, params};

use crate::api::errors::StorageError;

use super::epoch::{self, Epoch};
use super::errors::CrdtError;
use super::registry::{Document, UpdateSink};
use super::update_log::Namespace;

/// How many bodies each database keeps decoded: the notes a user moves
/// between. Counted per database, so one vault's writes never evict another's.
const KEPT: usize = 4;

static RESIDENT: Mutex<Vec<Resident>> = Mutex::new(Vec::new());

/// A body checked out for one write. Dropped, it is forgotten: only
/// [`Body::keep`] puts it back.
pub(crate) struct Body {
    key: Option<Key>,
    mark: LogMark,
    document: Arc<Document>,
    authored: Authored,
}

type Authored = Arc<Mutex<Vec<Vec<u8>>>>;

/// One body of one database, written as one device.
#[derive(Clone, PartialEq, Eq)]
struct Key {
    database: String,
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
/// when the log has not moved past it, else replayed from the log.
pub(crate) fn checkout(
    conn: &Connection,
    device_id: &str,
    doc_id: &str,
) -> Result<Body, CrdtError> {
    let key = conn
        .path()
        .filter(|path| !path.is_empty())
        .map(|database| Key {
            database: database.to_owned(),
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
        let mut resident = lock(&RESIDENT);
        resident.retain(|kept| kept.key != key);
        let mut same_database = 0;
        resident.retain(|kept| {
            kept.key.database != key.database || {
                same_database += 1;
                same_database < KEPT
            }
        });
        resident.insert(
            0,
            Resident {
                key,
                body: self,
                expected: authored,
            },
        );
    }
}

/// Drops every body kept for the database at `path`, once it closes.
pub(crate) fn release_database(path: &str) {
    drop(forget(|key| key.database == path));
}

/// Drops `doc_id`'s kept bodies, for a purge of its log.
pub(crate) fn release_document(conn: &Connection, doc_id: &str) {
    if let Some(database) = conn.path().filter(|path| !path.is_empty()) {
        drop(forget(|key| {
            key.database == database && key.doc_id == doc_id
        }));
    }
}

/// Takes the matching bodies out under the lock, so the caller drops them
/// after it: a document's drop never runs while the cache is locked.
fn forget(matches: impl Fn(&Key) -> bool) -> Vec<Resident> {
    let mut resident = lock(&RESIDENT);
    let (gone, kept) = std::mem::take(&mut *resident)
        .into_iter()
        .partition(|kept| matches(&kept.key));
    *resident = kept;
    gone
}

fn take(key: &Key) -> Option<Resident> {
    let mut resident = lock(&RESIDENT);
    let at = resident.iter().position(|kept| &kept.key == key)?;
    Some(resident.remove(at))
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
mod tests {
    use std::sync::Weak;

    use super::*;
    use crate::crdt::markdown_seed::append_markdown_in;
    use crate::crdt::{DocumentRegistry, epoch::HeldBody, extract_text, update_log};
    use crate::domain::body_write::author_with;
    use crate::storage::{nested_tx, open_data, test_support::temp_dir};

    const DAY: &str = "j2026-04-16";
    const DEVICE: &str = "device-a";

    fn storage(error: CrdtError) -> StorageError {
        StorageError::Failed {
            what: error.to_string(),
        }
    }

    /// Writes `markdown` as this device and answers the update with the body
    /// text the write saw before it.
    fn write(conn: &Connection, markdown: &str) -> Result<(Vec<u8>, String), StorageError> {
        let mut seen = String::new();
        let update = author_with(conn, DAY, DEVICE, |document| {
            seen = extract_text(document)?;
            document.write(|txn| append_markdown_in(txn, markdown).map(|_| ()))?
        })
        .map_err(storage)?
        .expect("authored an update");
        Ok((update, seen))
    }

    fn commit(conn: &Connection, update: &[u8]) -> Result<(), StorageError> {
        let failed = |e: rusqlite::Error| StorageError::Failed {
            what: e.to_string(),
        };
        let tx = nested_tx::begin(conn).map_err(failed)?;
        update_log::append_local_update_in(&tx, DAY, update, 1).map_err(storage)?;
        tx.commit().map_err(failed)
    }

    /// An update another device authored over `base`, holding `markdown`.
    fn peer_update(base: Option<&[u8]>, markdown: &str) -> Vec<u8> {
        let authored: Authored = Arc::new(Mutex::new(Vec::new()));
        let sink: UpdateSink = {
            let authored = Arc::clone(&authored);
            Arc::new(move |_, bytes: &[u8]| lock(&authored).push(bytes.to_vec()))
        };
        let peer = DocumentRegistry::new("device-b", sink)
            .get_or_open(DAY)
            .unwrap();
        if let Some(base) = base {
            peer.apply_durable_update(base).unwrap();
        }
        peer.write(|txn| append_markdown_in(txn, markdown).map(|_| ()))
            .unwrap()
            .unwrap();
        lock(&authored).remove(0)
    }

    /// A kept body serves the next write while the log holds its update.
    #[test]
    fn a_write_sees_every_committed_write_before_it() {
        let dir = temp_dir("resident-chain");
        let db = open_data(&dir.path().join("data.db")).expect("open data.db");
        let seen = db
            .call_blocking(|conn| {
                for text in ["one", "two"] {
                    let (update, _) = write(conn, text)?;
                    commit(conn, &update)?;
                }
                Ok(write(conn, "three")?.1)
            })
            .expect("write");
        assert!(seen.contains("one") && seen.contains("two"), "{seen}");
    }

    /// A pull between two writes lands in the second one's body.
    #[test]
    fn a_server_row_after_a_write_is_in_the_next_one() {
        let dir = temp_dir("resident-pull");
        let db = open_data(&dir.path().join("data.db")).expect("open data.db");
        let seen = db
            .call_blocking(|conn| {
                let (update, _) = write(conn, "mine")?;
                commit(conn, &update)?;
                HeldBody::never_purged(conn, DAY)
                    .and_then(|body| {
                        body.append_server_update(1, &peer_update(Some(&update), "pulled"), 2)
                    })
                    .map_err(storage)?;
                Ok(write(conn, "next")?.1)
            })
            .expect("write");
        assert!(seen.contains("mine") && seen.contains("pulled"), "{seen}");
    }

    /// A write whose update never committed leaves nothing in the next body.
    #[test]
    fn an_update_that_never_committed_is_not_in_the_next_write() {
        let dir = temp_dir("resident-abandoned");
        let db = open_data(&dir.path().join("data.db")).expect("open data.db");
        let seen = db
            .call_blocking(|conn| {
                write(conn, "dropped")?;
                Ok(write(conn, "next")?.1)
            })
            .expect("write");
        assert!(!seen.contains("dropped"), "{seen}");
    }

    /// One row from another writer in place of the expected update is a
    /// moved log, though it grows the log by the same one row.
    #[test]
    fn another_row_in_place_of_the_kept_update_is_a_moved_log() {
        let dir = temp_dir("resident-swapped");
        let db = open_data(&dir.path().join("data.db")).expect("open data.db");
        let seen = db
            .call_blocking(|conn| {
                write(conn, "dropped")?;
                commit(conn, &peer_update(None, "other"))?;
                Ok(write(conn, "next")?.1)
            })
            .expect("write");
        assert!(
            seen.contains("other") && !seen.contains("dropped"),
            "{seen}"
        );
    }

    /// A purge between two writes leaves the next one an empty body.
    #[test]
    fn a_purge_after_a_write_empties_the_next_one() {
        let dir = temp_dir("resident-purge");
        let db = open_data(&dir.path().join("data.db")).expect("open data.db");
        let seen = db
            .call_blocking(|conn| {
                let (update, _) = write(conn, "gone")?;
                commit(conn, &update)?;
                update_log::purge_in(conn, DAY).map_err(storage)?;
                Ok(write(conn, "new")?.1)
            })
            .expect("write");
        assert!(!seen.contains("gone"), "{seen}");
    }

    /// Writes `markdown` to `doc_id` and keeps the body, answering a handle
    /// that lives exactly as long as the kept document.
    fn kept(
        conn: &Connection,
        doc_id: &str,
        markdown: &str,
    ) -> Result<Weak<Document>, StorageError> {
        let body = checkout(conn, DEVICE, doc_id).map_err(storage)?;
        body.document()
            .write(|txn| append_markdown_in(txn, markdown).map(|_| ()))
            .map_err(storage)?
            .map_err(storage)?;
        let update = body.take_authored().remove(0);
        let failed = |e: rusqlite::Error| StorageError::Failed {
            what: e.to_string(),
        };
        let tx = nested_tx::begin(conn).map_err(failed)?;
        update_log::append_local_update_in(&tx, doc_id, &update, 1).map_err(storage)?;
        tx.commit().map_err(failed)?;
        let weak = Arc::downgrade(&body.document);
        body.keep(Some(update));
        Ok(weak)
    }

    /// A database keeps the four bodies written last: the fifth write
    /// releases the first, whose next write is rebuilt from its log.
    #[test]
    fn a_fifth_body_releases_the_first() {
        let dir = temp_dir("resident-evict");
        let db = open_data(&dir.path().join("data.db")).expect("open data.db");
        db.call_blocking(|conn| {
            let docs: Vec<String> = (0..5).map(|n| format!("note-{n}")).collect();
            let mut weak = Vec::new();
            for doc in &docs {
                weak.push(kept(conn, doc, &format!("text of {doc}"))?);
            }
            assert!(weak[0].upgrade().is_none(), "first body still held");
            assert!(weak[1..].iter().all(|kept| kept.upgrade().is_some()));

            let rebuilt = checkout(conn, DEVICE, &docs[0]).map_err(storage)?;
            let text = extract_text(rebuilt.document()).map_err(storage)?;
            assert!(text.contains("text of note-0"), "{text}");
            Ok(())
        })
        .expect("write");
    }

    /// A purge releases the document it purges (chapter 07 §7.15.1).
    #[test]
    fn a_purge_releases_the_kept_body() {
        let dir = temp_dir("resident-purge-release");
        let db = open_data(&dir.path().join("data.db")).expect("open data.db");
        db.call_blocking(|conn| {
            let purged = kept(conn, DAY, "gone")?;
            let other = kept(conn, "note-other", "stays")?;
            update_log::purge_in(conn, DAY).map_err(storage)?;
            assert!(purged.upgrade().is_none(), "purged body still held");
            assert!(other.upgrade().is_some());
            Ok(())
        })
        .expect("purge");
    }

    /// Closing a database, as a vault close or a sign-out does, releases
    /// every body kept for it.
    #[test]
    fn closing_the_database_releases_its_bodies() {
        let dir = temp_dir("resident-close");
        let db = open_data(&dir.path().join("data.db")).expect("open data.db");
        let clone = db.clone();
        let weak = db
            .call_blocking(|conn| kept(conn, DAY, "plaintext"))
            .expect("write");
        drop(db);
        assert!(weak.upgrade().is_some(), "released while a handle is open");
        drop(clone);
        assert!(weak.upgrade().is_none(), "body outlived its database");
    }
}
