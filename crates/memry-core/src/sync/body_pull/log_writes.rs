//! The durable writes of [`BodyPull`]: each update or baseline lands with its
//! cursor in one transaction (§7.9), and an empty log leaves a cursor too.

use crate::api::errors::StorageError;
use crate::crdt::update_log;
use crate::sync::store;

use super::{BodyPull, BodyPullError, crdt_cursor_scope, now_ms};

impl BodyPull {
    /// One update, durable **with** its cursor. §7.9 advances the watermark
    /// per update rather than per page, and the transaction is what makes a
    /// kill between the two impossible.
    ///
    /// The log row is stamped with **this device's** clock at apply time, not
    /// the server's `createdAt`: the search index's incremental watermark
    /// compares `yjs_updates.created_at` against its own epoch-ms stamps
    /// (`domain::search::maintenance`), and a server stamp (seconds, or a
    /// remote clock) sat below it, so a pulled body was never re-indexed and
    /// its links never became backlinks.
    pub(super) async fn store_update(
        &self,
        doc_id: &str,
        sequence_num: i64,
        update: Vec<u8>,
    ) -> Result<(), BodyPullError> {
        let doc = doc_id.to_owned();
        let scope = crdt_cursor_scope(doc_id);
        let created_at = now_ms();
        self.db
            .call(move |conn| {
                let txn = conn.unchecked_transaction().map_err(sqlite_failed)?;
                update_log::append_server_update(&txn, &doc, sequence_num, &update, created_at)
                    .map_err(crdt_failed)?;
                store::write_cursor(&txn, &scope, Some(&sequence_num.to_string()), created_at)?;
                txn.commit().map_err(sqlite_failed)?;
                Ok(())
            })
            .await?;
        Ok(())
    }

    /// §7.8: store the snapshot with its sequence number and revision, and
    /// advance the cursor **only if** the snapshot's sequence number is ahead.
    pub(super) async fn store_baseline(
        &self,
        doc_id: &str,
        snapshot: Vec<u8>,
        sequence_num: i64,
        revision: Option<String>,
        cursor: i64,
    ) -> Result<(), BodyPullError> {
        let doc = doc_id.to_owned();
        let scope = crdt_cursor_scope(doc_id);
        let now = now_ms();
        self.db
            .call(move |conn| {
                let txn = conn.unchecked_transaction().map_err(sqlite_failed)?;
                update_log::put_server_snapshot(
                    &txn,
                    &doc,
                    &snapshot,
                    sequence_num,
                    revision.as_deref(),
                    now,
                )
                .map_err(crdt_failed)?;
                if sequence_num > cursor {
                    store::write_cursor(&txn, &scope, Some(&sequence_num.to_string()), now)?;
                }
                txn.commit().map_err(sqlite_failed)?;
                Ok(())
            })
            .await?;
        Ok(())
    }

    /// A `crdt:<docId>` cursor of `0`, unless one is already stored.
    pub(super) async fn hold_empty_body(&self, doc_id: &str) -> Result<(), BodyPullError> {
        let scope = crdt_cursor_scope(doc_id);
        let now = now_ms();
        self.db
            .call(move |conn| match store::read_cursor(conn, &scope)? {
                Some(_) => Ok(()),
                None => store::write_cursor(conn, &scope, Some("0"), now),
            })
            .await?;
        Ok(())
    }
}

fn crdt_failed(error: crate::crdt::CrdtError) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

fn sqlite_failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
