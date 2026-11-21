//! The heal of a document re-created on a build before #5351 (#5354).
//!
//! Such a build cleared the tombstone of a deleted journal day (or note) and
//! authored the new text on top of the deleted body. The server had purged
//! that body (chapter 07 §7.15), so it holds only the new updates, whose
//! parents are gone: every fresh device keeps them pending and shows the
//! document empty. Only the author still holds the parents.
//!
//! The author re-pushes its full state once, as one update on the ordinary
//! update route. It integrates everywhere, including on a device that already
//! holds the pending updates, and it brings the deleted text back beside the
//! new text: the accepted price of not losing the new text.
//!
//! A candidate is cheap to find: a live note or journal with a recorded
//! tombstone and no purge on this device (a revive since #5351 and every
//! applied tombstone purge the body and move it to a new epoch, §7.16), with
//! nothing of it still queued, and not judged before. Judging it reads the
//! server's body into a scratch document. Each verdict is kept under
//! `sync.revive_heal:<id>`, so a document is read and pushed at most once. A
//! read that reaches no verdict stamps `sync.revive_heal_tried:<id>`, and the
//! document waits behind those not yet read.

use std::sync::Arc;

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;
use crate::crdt::errors::CrdtError;
use crate::crdt::registry::{Document, DocumentRegistry, UpdateSink};
use crate::crdt::update_log;
use crate::storage::{Db, nested_tx};

use super::body_pull::{BodyPull, BodyPullError};
use super::body_step::{BODY_REQUEST_BUDGET, ends_the_step};
use super::first_sync_store::write_meta;
use super::outbox::{self, Change};

const MARKER_PREFIX: &str = "sync.revive_heal:";
const TRIED_PREFIX: &str = "sync.revive_heal_tried:";

/// What the heal decided for one document, kept as its marker's value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Verdict {
    /// The server's body integrates on a fresh device: nothing to push.
    Healthy,
    /// The full state was queued for the push.
    Healed,
    /// Even the full state leaves the server's body pending, so pushing it
    /// would not help. Kept so the document is not read every pass.
    Unhealable,
}

impl Verdict {
    fn marker(self) -> &'static str {
        match self {
            Verdict::Healthy => "healthy",
            Verdict::Healed => "healed",
            Verdict::Unhealable => "unhealable",
        }
    }
}

/// Every candidate as `(item_type, id)`, the ones never read first, then the
/// longest unread.
pub fn candidates(conn: &Connection) -> Result<Vec<(String, String)>, StorageError> {
    select(conn, None)
}

fn select(conn: &Connection, only: Option<&str>) -> Result<Vec<(String, String)>, StorageError> {
    let mut statement = conn
        .prepare_cached(
            "SELECT item.item_type, item.item_id FROM sync_items AS item
             LEFT JOIN meta AS tried ON tried.key = ?3 || item.item_id
             WHERE item.item_type IN ('note', 'journal')
               AND item.deleted_at IS NULL
               AND (?1 IS NULL OR item.item_id = ?1)
               AND EXISTS (SELECT 1 FROM sync_tombstone_clocks AS t
                           WHERE t.item_type = item.item_type AND t.item_id = item.item_id)
               AND NOT EXISTS (SELECT 1 FROM yjs_doc_epochs AS e
                               WHERE e.doc_id = item.item_id AND e.epoch > 0)
               AND NOT EXISTS (SELECT 1 FROM outbox AS o WHERE o.item_id = item.item_id)
               AND NOT EXISTS (SELECT 1 FROM meta AS m WHERE m.key = ?2 || item.item_id)
             ORDER BY COALESCE(CAST(tried.value AS INTEGER), 0), item.item_id",
        )
        .map_err(failed)?;
    statement
        .query_map(params![only, MARKER_PREFIX, TRIED_PREFIX], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)
}

/// Judges every candidate within [`BODY_REQUEST_BUDGET`] requests and queues
/// the full state of each the server holds pending. Answers how many it
/// queued. A request failure leaves the document for a later pass behind the
/// others, and a failure every later request would repeat ends the step;
/// neither stops the push that follows.
pub async fn run(db: &Db, body_pull: &BodyPull) -> Result<usize, StorageError> {
    let due = db.call(|conn| candidates(conn)).await?;
    let mut requests = 0;
    let mut healed = 0;
    for (item_type, doc_id) in due {
        if requests >= BODY_REQUEST_BUDGET {
            break;
        }
        let server = match body_pull.read_server_body(&doc_id, &mut requests).await {
            Ok(Some(server)) => server,
            Err(BodyPullError::Storage { source }) => return Err(source),
            Err(BodyPullError::Api { source }) if ends_the_step(&source) => break,
            Ok(None) | Err(BodyPullError::Api { .. }) => {
                db.call(move |conn| mark_tried(conn, &doc_id, now_ms()))
                    .await?;
                continue;
            }
        };
        let verdict = db
            .call(move |conn| settle(conn, &item_type, &doc_id, &server, now_ms()))
            .await?;
        if verdict == Some(Verdict::Healed) {
            healed += 1;
        }
    }
    Ok(healed)
}

/// Decides one document against the server body read for it, in one
/// transaction. `None` when it stopped being a candidate during the read, or
/// when it could not be judged now.
fn settle(
    conn: &Connection,
    item_type: &str,
    doc_id: &str,
    server: &[Vec<u8>],
    now_ms: i64,
) -> Result<Option<Verdict>, StorageError> {
    let txn = nested_tx::begin(conn).map_err(failed)?;
    if select(&txn, Some(doc_id))?.is_empty() {
        return Ok(None);
    }
    let verdict = match judge(&txn, doc_id, server) {
        Ok((verdict, full)) => {
            if verdict == Verdict::Healed {
                outbox::enqueue(&txn, &Change::crdt_update(item_type, doc_id, full), now_ms)?;
            }
            verdict
        }
        Err(CrdtError::Storage { source }) => return Err(source),
        // Bytes that do not decode or apply cannot be judged; a push of
        // them would not help either.
        Err(CrdtError::Undecodable { .. } | CrdtError::NotApplicable { .. }) => Verdict::Unhealable,
        // Transient (`DocumentBusy`): a later pass judges it.
        Err(CrdtError::DocumentBusy { .. }) => {
            mark_tried(&txn, doc_id, now_ms)?;
            txn.commit().map_err(failed)?;
            return Ok(None);
        }
    };
    write_meta(&txn, &format!("{MARKER_PREFIX}{doc_id}"), verdict.marker())?;
    txn.execute(
        "DELETE FROM meta WHERE key = ?1",
        params![format!("{TRIED_PREFIX}{doc_id}")],
    )
    .map_err(failed)?;
    txn.commit().map_err(failed)?;
    Ok(Some(verdict))
}

fn mark_tried(conn: &Connection, doc_id: &str, now_ms: i64) -> Result<(), StorageError> {
    write_meta(
        conn,
        &format!("{TRIED_PREFIX}{doc_id}"),
        &now_ms.to_string(),
    )
}

/// The verdict, with the local full state to push when it is `Healed`.
fn judge(
    conn: &Connection,
    doc_id: &str,
    server: &[Vec<u8>],
) -> Result<(Verdict, Vec<u8>), CrdtError> {
    let on_server = scratch(doc_id, server.iter().map(Vec::as_slice))?;
    if !on_server.has_missing_updates()? {
        return Ok((Verdict::Healthy, Vec::new()));
    }
    let plan = update_log::load_plan(conn, doc_id)?;
    let full = scratch(doc_id, plan.blobs().into_iter())?.encode_state()?;
    on_server.apply_durable_update(&full)?;
    if on_server.has_missing_updates()? {
        return Ok((Verdict::Unhealable, Vec::new()));
    }
    Ok((Verdict::Healed, full))
}

fn scratch<'a>(
    doc_id: &str,
    blobs: impl Iterator<Item = &'a [u8]>,
) -> Result<Arc<Document>, CrdtError> {
    let sink: UpdateSink = Arc::new(|_, _| {});
    let document = DocumentRegistry::new("revive-heal", sink).get_or_open(doc_id)?;
    for blob in blobs {
        document.apply_durable_update(blob)?;
    }
    Ok(document)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
