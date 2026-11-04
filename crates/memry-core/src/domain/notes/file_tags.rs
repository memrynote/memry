//! An edit outside the app to a vault file's frontmatter `tags:`, taken into the record of the
//! note or journal day the file is (desktop, #3825). The vault tier asks here once the file's
//! text reached the document, for bytes the app did not write; nothing here reads a file.
//!
//! - **A note's file owns its header tags**, as on desktop, where an edit in the app writes
//!   them into the file with the record and a push reads them from the file
//!   (`buildNotePushPayload`). The record takes the file's list through [`tags::set`]: case
//!   variants collapse to the first spelling, a pin on a dropped tag goes, and a list the record
//!   already holds writes nothing, so a body edit queues no push.
//! - **A journal day's record owns its tags** (decision on #3530: the app never writes a day's
//!   tags into its file, and keeps the file's `tags:` as the author wrote them), so the file's
//!   list is not the day's. What the edit changed in that list, against the list the file had
//!   (`before`), is applied to the record: a tag the author added joins it, one they removed
//!   leaves it, and the tags only the record holds stay. With no `before` known (the index has
//!   not measured the file the edit replaced) nothing is taken: a guess would add back a tag the
//!   record dropped, or drop one only the record holds. A respelling in the file changes nothing
//!   (same tag, §13.7.7).
//!
//! A deleted or absent record takes nothing: its queued delete must not become an upsert.

use rusqlite::Connection;

use crate::api::errors::StorageError;
use crate::domain::header_tags::{self, HeaderTagEdit};
use crate::domain::journal;
use crate::domain::journal_ops::metadata;
use crate::domain::tags;
use crate::storage::repositories::sync_items;

use super::ITEM_TYPE;

/// Takes the file's header tags `after` into the record `id`; `before` is the list the file
/// it replaced had, when known.
pub fn taken(
    conn: &Connection,
    id: &str,
    before: Option<&[String]>,
    after: &[String],
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    if let Some(date) = journal::date_of(conn, id)? {
        let Some(change) = before.and_then(|before| header_tags::compare(before, after)) else {
            return Ok(());
        };
        let edit = HeaderTagEdit {
            add: change.added,
            remove: change.removed,
            ..HeaderTagEdit::default()
        };
        let next = header_tags::apply(&tags::list(conn, journal::ITEM_TYPE, id)?, &edit);
        metadata::set_live_tags(conn, &date, &next, device_id, now_ms)?;
        return Ok(());
    }
    match sync_items::load(conn, ITEM_TYPE, id)? {
        Some(row) if row.deleted_at.is_none() => {
            tags::set(conn, ITEM_TYPE, id, after, device_id, now_ms)?;
            Ok(())
        }
        _ => Ok(()),
    }
}
