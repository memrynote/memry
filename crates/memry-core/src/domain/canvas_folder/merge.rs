//! The inbound half of `canvas_folder`: Electron's
//! `CanvasFolderHandler.applyUpsert`
//! (`apps/desktop/src/main/sync/item-handlers/canvas-folder-handler.ts:53-135`),
//! rule for rule.
//!
//! - **A create needs a non-empty `vaultId` and `path`** (`:106-114`).
//! - **§6.3.1's gate decides**; a concurrent clock is last-writer-wins under the
//!   merged clock (`:65-73`).
//! - **Over a local folder** (`:75-90`), deleted ones included because Electron
//!   soft-deletes: an absent `path` keeps the local path and a `null` one
//!   skips the record, as desktop's schema rejects it
//!   ([`desktop_records::Kept`]); an absent
//!   `icon` keeps the local icon and `null` clears it, and `vaultId` stays
//!   local. `deletedAt` is the remote's: absent or `null` revives the folder.
//!
//! A delete is the tombstone path unchanged ([`crate::domain::desktop_records`]).

use rusqlite::Connection;
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::domain::desktop_records::{self, Kept};
use crate::domain::task_merge;
use crate::domain::tasks::Inbound;
use crate::storage::repositories::StoredPayload;
use crate::storage::repositories::sync_items::InboundRecord;

use super::ITEM_TYPE;

pub(crate) const KEPT: Kept = Kept {
    not_null: &["id", "vaultId", "path", "clock"],
    coalesce: &["path"],
    when_absent: &["icon"],
    local: &["vaultId"],
};

/// Applies one inbound `canvas_folder` record.
pub fn apply_remote(
    conn: &Connection,
    record: &InboundRecord,
    now_ms: i64,
) -> Result<Inbound, StorageError> {
    let remote = match StoredPayload::parse(&record.payload_json) {
        Ok(remote) if record.deleted_at.is_none() => remote,
        Ok(_) => return task_merge::wholesale(conn, record, now_ms),
        Err(_) => return desktop_records::unreadable(conn, record, now_ms),
    };
    let local = desktop_records::stored(conn, ITEM_TYPE, &record.item_id, false)?;
    let stated = |key: &str| {
        remote
            .object()
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty())
    };
    if local.is_none() && !(stated("vaultId") && stated("path")) {
        return Ok(Inbound::Skipped);
    }
    desktop_records::apply_kept(conn, record, &remote, local.as_ref(), Vec::new(), now_ms)
}
