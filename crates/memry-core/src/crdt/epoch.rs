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

fn failed(what: &'static str) -> impl Fn(rusqlite::Error) -> StorageError {
    move |err| StorageError::Failed {
        what: format!("could not {what}: {err}"),
    }
}
