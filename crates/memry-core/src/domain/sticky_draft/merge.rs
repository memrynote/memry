//! The inbound half of `sticky_draft`: Electron's
//! `StickyDraftHandler.applyUpsert`
//! (`apps/desktop/src/main/sync/item-handlers/sticky-draft-handler.ts:23-79`),
//! rule for rule.
//!
//! - **A create needs `content`** (`:54-60`): every payload field is optional,
//!   so `{}` parses, and an empty draft under an empty clock would lose every
//!   later version.
//! - **§6.3.1's gate decides**; a concurrent clock is last-writer-wins under the
//!   merged clock (`:36-40`).
//! - **Over a local draft** (`:42-51`), an absent `content` or `kind` keeps the
//!   local value and a `null` one skips the record, as desktop's schema rejects
//!   it ([`desktop_records::Kept`]); `createdAt` stays local, and an absent `modifiedAt`
//!   reads as the apply time
//!   ([`crate::storage::repositories::projectors::sticky_drafts`]).
//!
//! A delete removes the draft through the tombstone path
//! ([`crate::domain::desktop_records`]).

use rusqlite::Connection;

use crate::api::errors::StorageError;
use crate::domain::desktop_records::{self, Kept};
use crate::domain::task_merge;
use crate::domain::tasks::Inbound;
use crate::storage::repositories::StoredPayload;
use crate::storage::repositories::sync_items::InboundRecord;

use super::{ITEM_TYPE, can_create};

const KEPT: Kept = Kept {
    not_null: &["content", "kind", "clock", "createdAt", "modifiedAt"],
    coalesce: &["content", "kind"],
    when_absent: &[],
    local: &["createdAt"],
};

/// Applies one inbound `sticky_draft` record.
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
    let local = desktop_records::stored(conn, ITEM_TYPE, &record.item_id, true)?;
    if local.is_none() && !can_create(remote.object()) {
        return Ok(Inbound::Skipped);
    }
    desktop_records::apply_kept(
        conn,
        record,
        &remote,
        local.as_ref(),
        &KEPT,
        Vec::new(),
        now_ms,
    )
}
