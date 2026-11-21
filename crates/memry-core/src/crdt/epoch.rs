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
//! exists only for a document still at the epoch read before the fetch or the
//! push, so rows of a purged body cannot land in a revived one.

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

/// `doc_id`'s epoch: 0 until this device first purges it.
pub(crate) fn read(conn: &Connection, doc_id: &str) -> Result<i64, CrdtError> {
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
pub(crate) fn read_all(conn: &Connection) -> Result<HashMap<String, i64>, CrdtError> {
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

/// `doc_id`'s body, still at the epoch read before a fetch or a push, inside
/// the transaction `conn` holds (#5356, chapter 07 §7.15). Every purge, a
/// delete's or a revive's, moves the epoch. Rows fetched before it belong to
/// the purged body, and stored in a revived one they give the next edit
/// parents the server purged (#5351).
pub struct HeldBody<'c> {
    conn: &'c Connection,
    doc_id: &'c str,
}

impl<'c> HeldBody<'c> {
    /// `None` when a purge moved `doc_id` off `epoch`: store nothing.
    pub fn check(
        conn: &'c Connection,
        doc_id: &'c str,
        epoch: i64,
    ) -> Result<Option<Self>, CrdtError> {
        Ok((read(conn, doc_id)? == epoch).then_some(Self { conn, doc_id }))
    }

    /// A document this device never purged, for a write that fetched nothing
    /// first, such as a fixture. Fails for a purged one.
    pub fn never_purged(conn: &'c Connection, doc_id: &'c str) -> Result<Self, CrdtError> {
        Self::check(conn, doc_id, 0)?.ok_or_else(|| {
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
