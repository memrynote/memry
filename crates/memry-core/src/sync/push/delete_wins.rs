//! The delete a push refusal names (`SYNC_DELETE_WINS`, §5.8), taken here.

use crate::api::errors::StorageError;
use crate::domain::notes::failed;
use crate::storage::repositories::{projectors, sync_items};
use crate::sync::{outbox, store};

/// §5.8's client rule for a write the server refused because it holds the item deleted: the
/// delete wins here too, as a pulled one would, and nothing is queued. Only for a
/// `property_definition` upsert (#4025): a device that never saw a definition's tombstone (shed
/// to a marker, §5.12.3, which this core never pulls) can still learn its name and promote it,
/// and this refusal is the only delete it will ever see. A user's create is a `create`, which the
/// server re-creates over the marker. And for the manifest check's re-upload, a `create` of a
/// [`manifest::REUPLOADED`] type: kept live, the row would be re-pushed every 30 minutes for
/// ever. Not a [`manifest::PROBED`] type, whose `create` is also the user's own (a journal day, a
/// bookmark re-add): the manifest check asks the server about such a row again, and a delete it
/// names stops the re-upload. Acked in the same transaction, so the local record never outlives its outbox row.
///
/// A change queued while the refused push was in flight is the user's newer edit, create or
/// delete: the record stays as it is and that row is pushed next.
pub(super) fn take_the_delete(
    conn: &rusqlite::Connection,
    item_type: &str,
    item_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let queued: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM outbox
              WHERE item_type = ?1 AND item_id = ?2 AND op <> ?3)",
            rusqlite::params![item_type, item_id, outbox::OP_CRDT_UPDATE],
            |row| row.get(0),
        )
        .map_err(failed)?;
    let live =
        sync_items::load(conn, item_type, item_id)?.is_some_and(|row| row.deleted_at.is_none());
    if queued || !live {
        return Ok(());
    }
    eprintln!(
        "memry-core: the server holds a {item_type} deleted (SYNC_DELETE_WINS); \
         deleted here too"
    );
    store::mark_deleted(conn, item_type, item_id, now_ms, None, now_ms)?;
    projectors::delete(conn, item_type, item_id, now_ms)
}
