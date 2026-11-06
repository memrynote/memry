//! How the editor hears of every other writer of a body log and brings its
//! documents up to what they committed ([`crate::crdt::body_writes`]).
//!
//! The rows a closure wrote are read back by key, not replayed from the whole
//! log: the cost is the rows written, and a sync pull writes one update per
//! closure. A row that rolled back is not there, so nothing uncommitted reaches
//! a document or a window.

use rusqlite::{Connection, OptionalExtension as _, params};

use super::{Editor, EditorError, Notice};
use crate::api::errors::StorageError;
use crate::crdt::body_writes::{BodyObserver, BodyWrite, LogRow};
use crate::crdt::epoch;
use crate::crdt::errors::CrdtError;
use crate::crdt::update_log::{self, Namespace};

impl BodyObserver for Editor {
    fn bodies_written(&self, writes: &[BodyWrite]) {
        for write in writes {
            if let Err(error) = self.catch_up(write) {
                // The next access replays the committed log.
                self.resident().invalidate(&write.doc_id);
                eprintln!(
                    "memry editor: {} did not take {} {} row(s) a writer committed: {error}",
                    write.doc_id,
                    write.rows.len(),
                    write.origin.kind()
                );
            }
        }
    }
}

impl Editor {
    /// Applies the rows `write` committed to its resident document and hands
    /// each one that adds to it to the listeners, with the writer's origin. A
    /// held document not in memory replays the log when it loads, and its
    /// windows take the rows as committed. A log that moved to a new epoch was
    /// purged ([`Editor::purge`]).
    fn catch_up(&self, write: &BodyWrite) -> Result<(), EditorError> {
        let id = write.doc_id.as_str();
        let (present, held) = {
            let resident = self.resident();
            (resident.peek(id).is_some(), resident.is_held(id))
        };
        if !present && write.purged {
            // No copy to compare epochs with: a held one's windows reopen, and
            // a log that did not replay may now.
            self.purge(id);
            return Ok(());
        }
        if !present && !held {
            return Ok(());
        }
        let (client_id, rows) = self
            .db
            .read_blocking(|conn| Ok(committed(conn, &self.device_id, id, &write.rows)))??;
        let resident = self.resident();
        let took = match resident.peek(id) {
            Some(document) if document.client_id() != client_id => {
                drop(resident);
                self.purge(id);
                return Ok(());
            }
            Some(document) => {
                let mut took = Vec::new();
                for row in rows {
                    if document.apply_durable_update_changed(&row)? {
                        took.push(row);
                    }
                }
                took
            }
            None => rows,
        };
        // Every window holds the deleted copy: a new document's rows would mix
        // into it. They take the new document when they open it again.
        let took = if resident.all_stale(id) {
            Vec::new()
        } else {
            took
        };
        drop(resident);
        for row in &took {
            self.fan_out(id, Notice::Update(row, &write.origin));
        }
        Ok(())
    }
}

/// The epoch client id of `doc_id` and the committed bytes of `rows`, read in
/// one transaction so both are of one commit.
///
/// A row a fold took after its writer committed it ([`crate::crdt::compact`],
/// or a pushed snapshot's prune) is read from the snapshot that holds it, once.
/// A row that rolled back reads nothing, unless a later row reused its sequence
/// and was folded: the snapshot read then is committed content. The snapshot
/// goes to the windows under this write's origin, though it may hold rows
/// another writer committed.
fn committed(
    conn: &Connection,
    device_id: &str,
    doc_id: &str,
    rows: &[LogRow],
) -> Result<(u64, Vec<Vec<u8>>), CrdtError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let client_id = epoch::client_id(&tx, device_id, doc_id)?;
    let mut blobs = Vec::new();
    let mut folded = Vec::new();
    for row in rows {
        let blob = match *row {
            LogRow::Local(seq) => update_or_fold(&tx, Namespace::Local, doc_id, seq, &mut folded)?,
            LogRow::Server(seq) => {
                update_or_fold(&tx, Namespace::Server, doc_id, seq, &mut folded)?
            }
            LogRow::ServerSnapshot => {
                update_log::snapshot(&tx, Namespace::Server, doc_id)?.map(|row| row.snapshot)
            }
            LogRow::LocalSnapshot => {
                update_log::snapshot(&tx, Namespace::Local, doc_id)?.map(|row| row.snapshot)
            }
        };
        blobs.extend(blob);
    }
    Ok((client_id, blobs))
}

/// Row `seq` of `namespace`, or the namespace's snapshot when it folded the
/// row and `folded` does not name it yet.
fn update_or_fold(
    conn: &Connection,
    namespace: Namespace,
    doc_id: &str,
    seq: i64,
    folded: &mut Vec<Namespace>,
) -> Result<Option<Vec<u8>>, CrdtError> {
    let row = conn
        .query_row(
            "SELECT update_blob FROM yjs_updates WHERE doc_id = ?1 AND seq = ?2",
            params![namespace.row_id(doc_id), seq],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    if row.is_some() || folded.contains(&namespace) {
        return Ok(row);
    }
    let snapshot = update_log::snapshot(conn, namespace, doc_id)?.filter(|row| row.last_seq >= seq);
    if snapshot.is_some() {
        folded.push(namespace);
    }
    Ok(snapshot.map(|row| row.snapshot))
}

fn failed(error: rusqlite::Error) -> CrdtError {
    StorageError::Failed {
        what: format!("could not read a committed body row: {error}"),
    }
    .into()
}
