//! The inbound half of `home_page`: Electron's `HomePageHandler.applyUpsert`
//! (`packages/sync-client/src/item-handlers/home-page-handler.ts:32-108`),
//! rule for rule.
//!
//! - **Widgets that are present and not JSON array text are skipped** before
//!   the clock is touched (`:40-47`), so a later readable version of the board
//!   still wins. A `null` or a value that is not text is skipped too, as
//!   desktop's schema rejects it (`apps/desktop/src/main/sync/apply-item.ts:166-176`).
//! - **A create needs a non-empty `name`** (`:85-91`).
//! - **§6.3.1's gate decides**; a concurrent clock is last-writer-wins under the
//!   merged clock (`:53-60`).
//! - **Over a local board** (`:62-75`), an absent `name`, `position` or
//!   `widgets` keeps the local value, and a `null` one skips the record
//!   ([`desktop_records::Kept`]); an absent `icon` or `cover` keeps it and
//!   `null` clears it; `createdAt` stays local; an absent `updatedAt` reads as
//!   the apply time. A `cover` this build cannot read
//!   (`HomePageCoverSyncSchema`'s `.catch(undefined)`) is absent.
//!
//! A delete removes the board through the tombstone path
//! ([`crate::domain::desktop_records`]).

use rusqlite::Connection;
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::domain::desktop_records::{self, Kept};
use crate::domain::task_merge;
use crate::domain::tasks::Inbound;
use crate::storage::repositories::sync_items::InboundRecord;
use crate::storage::repositories::{Change, StoredPayload};

use crate::storage::repositories::projectors::home_pages::is_readable_cover;

use super::{ITEM_TYPE, is_widgets_blob};

const KEPT: Kept = Kept {
    not_null: &[
        "name",
        "position",
        "widgets",
        "clock",
        "createdAt",
        "updatedAt",
    ],
    coalesce: &["name", "position", "widgets"],
    when_absent: &["icon", "cover"],
    local: &["createdAt"],
};

/// Applies one inbound `home_page` record.
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
    let remote_object = remote.object();
    match remote_object.get("widgets") {
        None => {}
        Some(Value::String(text)) if is_widgets_blob(text) => {}
        Some(_) => return Ok(Inbound::Skipped),
    }
    let local = desktop_records::stored(conn, ITEM_TYPE, &record.item_id, true)?;
    let Some(local) = local else {
        let named = remote_object
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| !name.is_empty());
        if !named {
            return Ok(Inbound::Skipped);
        }
        return desktop_records::apply_kept(conn, record, &remote, None, &KEPT, Vec::new(), now_ms);
    };
    // An unreadable cover is absent: the local one stays.
    let extra = match remote_object.get("cover") {
        Some(cover) if !cover.is_null() && !is_readable_cover(cover) => {
            match local.object().get("cover") {
                Some(kept) => vec![("cover", Change::Set(kept.clone()))],
                None => vec![("cover", Change::Remove)],
            }
        }
        _ => Vec::new(),
    };
    desktop_records::apply_kept(conn, record, &remote, Some(&local), &KEPT, extra, now_ms)
}
