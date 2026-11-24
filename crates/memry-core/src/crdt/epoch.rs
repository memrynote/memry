//! A document's epoch on this device: how many times its body was purged here
//! (#2986, chapter 07 §7.16).
//!
//! A journal day's id is the same on every device, so a day deleted and
//! written again is a new document under the old id. The purge took the local
//! log, so the new document would restart this device's clock at 0 under the
//! same Yjs client id, and a peer still holding the deleted document already
//! has items `(client, 0..n)`: it takes the new ones for those and drops them.
//! Each purge moves the document to a new epoch, and each epoch authors under
//! its own client id, so no `(client, clock)` pair is minted twice.
//!
//! The epoch also tells a write from the network which body it belongs to
//! (#5356). [`HeldBody`] is the only writer of the server namespace, and it
//! exists only for a document still at the [`Epoch`] captured before the fetch,
//! the push, or the load of a resident document, so rows of a purged body
//! cannot land in a revived one.

use std::collections::HashMap;
use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension as _, params};

use crate::api::errors::StorageError;

use super::errors::CrdtError;
use super::registry::{Document, DocumentRegistry, UpdateSink, client_id_from_device_id};
use super::update_log;

/// Moves `doc_id` to its next epoch, inside the purge's transaction.
pub(crate) fn bump_in(conn: &Connection, doc_id: &str) -> Result<(), CrdtError> {
    conn.execute(
        "INSERT INTO yjs_doc_epochs (doc_id, epoch) VALUES (?1, 1)
         ON CONFLICT(doc_id) DO UPDATE SET epoch = epoch + 1",
        params![doc_id],
    )
    .map_err(failed("bump the document epoch"))?;
    Ok(())
}

/// `doc_id`'s epoch at one moment: before a fetch, or before its log loads
/// into a resident document. An opaque token, the only thing
/// [`HeldBody::check`] compares against: a check against an epoch read inside
/// the store's own transaction would pass for a body purged during the fetch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Epoch(i64);

/// `doc_id`'s [`Epoch`] now. Capture it before the fetch, the push, or the
/// load of a resident document whose rows it guards, never at the store.
pub fn capture(conn: &Connection, doc_id: &str) -> Result<Epoch, CrdtError> {
    read(conn, doc_id).map(Epoch)
}

/// Every document's [`Epoch`] now, for a fetch of many documents.
#[derive(Debug, Clone)]
pub(crate) struct Epochs(HashMap<String, i64>);

impl Epochs {
    pub(crate) fn of(&self, doc_id: &str) -> Epoch {
        Epoch(self.0.get(doc_id).copied().unwrap_or(0))
    }
}

/// [`capture`] for every document at once.
pub(crate) fn capture_all(conn: &Connection) -> Result<Epochs, CrdtError> {
    read_all(conn).map(Epochs)
}

/// `doc_id`'s epoch: 0 until this device first purges it.
fn read(conn: &Connection, doc_id: &str) -> Result<i64, CrdtError> {
    Ok(conn
        .prepare_cached("SELECT epoch FROM yjs_doc_epochs WHERE doc_id = ?1")
        .and_then(|mut statement| {
            statement
                .query_row(params![doc_id], |row| row.get(0))
                .optional()
        })
        .map_err(failed("read the document epoch"))?
        .unwrap_or(0))
}

/// Every document's epoch above 0.
fn read_all(conn: &Connection) -> Result<HashMap<String, i64>, CrdtError> {
    Ok(conn
        .prepare_cached("SELECT doc_id, epoch FROM yjs_doc_epochs")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<_, _>>()
        })
        .map_err(failed("read the document epochs"))?)
}

/// The client id `device_id` authors `doc_id` under. Epoch 0, a document this
/// device never purged, keeps the device's own id (§7.16).
pub(crate) fn client_id(
    conn: &Connection,
    device_id: &str,
    doc_id: &str,
) -> Result<u64, CrdtError> {
    Ok(match read(conn, doc_id)? {
        0 => client_id_from_device_id(device_id),
        epoch => client_id_from_device_id(&format!("{device_id}\0epoch{epoch}")),
    })
}

/// `doc_id` replayed from its durable log, opened to author a write as
/// `device_id`. The replay is durable, so `sink` sees only the write.
pub(crate) fn open_for_write(
    conn: &Connection,
    device_id: &str,
    doc_id: &str,
    sink: UpdateSink,
) -> Result<Arc<Document>, CrdtError> {
    let document = DocumentRegistry::with_client_id(client_id(conn, device_id, doc_id)?, sink)
        .get_or_open(doc_id)?;
    for blob in update_log::load_plan(conn, doc_id)?.blobs() {
        document.apply_durable_update(blob)?;
    }
    Ok(document)
}

/// `doc_id`'s body, still at the [`Epoch`] captured before a fetch or a push, inside
/// the transaction `conn` holds (#5356, chapter 07 §7.15). Every purge, a
/// delete's or a revive's, moves the epoch. Rows fetched before it belong to
/// the purged body, and stored in a revived one they give the next edit
/// parents the server purged (#5351).
pub struct HeldBody<'c> {
    conn: &'c Connection,
    doc_id: &'c str,
}

impl<'c> HeldBody<'c> {
    /// `None` when a purge moved `doc_id` off `epoch`: store nothing. Takes
    /// a captured [`Epoch`] and never a raw number, so no caller can claim
    /// an epoch it did not read:
    ///
    /// ```compile_fail
    /// fn store(conn: &rusqlite::Connection) {
    ///     let _ = memry_core::crdt::epoch::HeldBody::check(conn, "doc", 0);
    /// }
    /// ```
    pub(crate) fn check(
        conn: &'c Connection,
        doc_id: &'c str,
        epoch: Epoch,
    ) -> Result<Option<Self>, CrdtError> {
        Ok((capture(conn, doc_id)? == epoch).then_some(Self { conn, doc_id }))
    }

    /// A document this device never purged, for a fixture that fetched
    /// nothing first. Fails for a purged one. Test-only: production rows
    /// come from a fetch, and their check needs the epoch captured before it.
    #[cfg(any(test, feature = "test-support"))]
    pub fn never_purged(conn: &'c Connection, doc_id: &'c str) -> Result<Self, CrdtError> {
        Self::check(conn, doc_id, Epoch(0))?.ok_or_else(|| {
            StorageError::Failed {
                what: format!("{doc_id} was purged here: its server rows need a held epoch"),
            }
            .into()
        })
    }

    pub(crate) fn conn(&self) -> &'c Connection {
        self.conn
    }

    pub(crate) fn doc_id(&self) -> &'c str {
        self.doc_id
    }

    /// [`update_log::append_server_update`] for this body.
    pub fn append_server_update(
        &self,
        sequence_num: i64,
        update_blob: &[u8],
        created_at: i64,
    ) -> Result<(), CrdtError> {
        update_log::append_server_update(
            self.conn,
            self.doc_id,
            sequence_num,
            update_blob,
            created_at,
        )
    }

    /// [`update_log::put_server_snapshot`] for this body.
    pub fn put_server_snapshot(
        &self,
        snapshot_bytes: &[u8],
        server_sequence_num: i64,
        revision: Option<&str>,
        compacted_at: i64,
    ) -> Result<(), CrdtError> {
        update_log::put_server_snapshot(
            self.conn,
            self.doc_id,
            snapshot_bytes,
            server_sequence_num,
            revision,
            compacted_at,
        )
    }
}

fn failed(what: &'static str) -> impl Fn(rusqlite::Error) -> StorageError {
    move |err| StorageError::Failed {
        what: format!("could not {what}: {err}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{open_data, test_support::temp_dir};

    const DOC: &str = "note-1";

    fn storage(error: CrdtError) -> StorageError {
        StorageError::Failed {
            what: error.to_string(),
        }
    }

    /// #5356: an epoch captured before a purge holds no body after it, and
    /// one captured after it does.
    #[test]
    fn a_body_is_held_only_at_the_epoch_captured_before_the_purge() {
        let dir = temp_dir("epoch-held");
        let db = open_data(&dir.path().join("data.db")).expect("open data.db");
        let (stale, held) = db
            .call_blocking(|conn| {
                let before = capture(conn, DOC).map_err(storage)?;
                update_log::purge_in(conn, DOC).map_err(storage)?;
                let stale = HeldBody::check(conn, DOC, before).map_err(storage)?;
                let fresh = capture(conn, DOC).map_err(storage)?;
                let held = HeldBody::check(conn, DOC, fresh).map_err(storage)?;
                Ok((stale.is_some(), held.is_some()))
            })
            .expect("check");
        assert!(!stale, "a purged body is not held");
        assert!(held, "the new body is held");
    }

    #[test]
    fn many_documents_capture_each_epoch() {
        let dir = temp_dir("epoch-all");
        let db = open_data(&dir.path().join("data.db")).expect("open data.db");
        let (purged, untouched, all) = db
            .call_blocking(|conn| {
                update_log::purge_in(conn, DOC).map_err(storage)?;
                Ok((
                    capture(conn, DOC).map_err(storage)?,
                    capture(conn, "other").map_err(storage)?,
                    capture_all(conn).map_err(storage)?,
                ))
            })
            .expect("capture");
        assert_eq!(all.of(DOC), purged);
        assert_eq!(all.of("other"), untouched);
        assert_ne!(purged, untouched);
    }

    #[test]
    fn a_fixture_cannot_seed_a_purged_document() {
        let dir = temp_dir("epoch-fixture");
        let db = open_data(&dir.path().join("data.db")).expect("open data.db");
        let (fresh, purged) = db
            .call_blocking(|conn| {
                let fresh = HeldBody::never_purged(conn, DOC).is_ok();
                update_log::purge_in(conn, DOC).map_err(storage)?;
                Ok((fresh, HeldBody::never_purged(conn, DOC).is_err()))
            })
            .expect("check");
        assert!(fresh && purged);
    }
}
