//! A merged day's pictures (§1.9.1 step 6, chapter 14 §14.7, #5777).
//!
//! A day's pictures are fetchable wherever the day is. A journal payload has
//! no `attachmentReferences` (§13.7.2), so a day names its pictures to peers
//! in a `note` record under its own id, as desktop's upload to the day does
//! (`recordOnNote`, #5731). A foreign id `F` named its pictures in a `note`
//! record under `F`. Folding `F`'s body into `j<D>` without its references
//! leaves a device that never held `F` with a day whose embedded pictures it
//! cannot fetch. The server keeps each attachment by its own id, not by note
//! (§14.7), so the bytes `F` uploaded need no second upload once `j<D>` names
//! them.
//!
//! Desktop pairs a lone reference with a lone unrecorded file in `F`'s folder
//! (#5782). The core has no such folder: it stores every file under its
//! attachment id (`images/<id>`), so a carried reference already finds its
//! bytes and nothing is paired.

use rusqlite::Connection;

use crate::api::errors::StorageError;
use crate::domain::{attachment_uploads, notes};
use crate::storage::repositories::sync_items;

/// Unions `F`'s references into `j<D>`'s and queues `j<D>`'s `note` record,
/// creating it in desktop's shape when the day has none or a deleted one.
/// Runs in the settle's transaction, so a crash leaves neither half. Queues
/// nothing when `j<D>` names every reference already, so a re-run or a
/// peer's echo pushes nothing.
///
/// Invariant: every reference `F` holds or will hold is named under `j<D>`
/// before `F` is forgotten. `F`'s note row holds what it uploaded; an upload
/// still queued under `F` (#5510) will hold one, and the pass uploads after
/// this drain, so it moves to `j<D>` here and names `j<D>` when it lands.
///
/// A late settle (`F` deleted by the device that merged it) carries too. That
/// device may run a build without this carry, and then this is the only
/// device that names `F`'s pictures under `j<D>`; desktop carries on a late
/// settle as well. A picture removed from `j<D>` in between comes back to the
/// list as a reference, which costs a download, not the body (§1.9.1 known
/// limits).
pub(super) fn carry(
    tx: &Connection,
    foreign: &str,
    canonical: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let carried = notes::read_attachment_references(tx, foreign)?;
    attachment_uploads::move_to_note(tx, foreign, canonical)?;
    // A live record whose payload this device does not hold: not pulled yet,
    // or one it cannot read. A write here would replace what it cannot see.
    // The references stay on `F`'s note row, and the moved uploads wait until
    // the record is readable (§1.9.1 known limits).
    let unread = sync_items::load(tx, notes::ITEM_TYPE, canonical)?
        .is_some_and(|row| row.deleted_at.is_none() && row.payload.is_none());
    if unread {
        if !carried.is_empty() {
            eprintln!(
                "memry-core: journal day merge of {foreign} cannot name {} attachment(s) under \
                 {canonical}: its note record is not pulled",
                carried.len()
            );
        }
        return Ok(());
    }
    // An edit of the day's record, or its creation over a missing or deleted
    // one by the day-note owner (`day_picture_refs::create_day_note`).
    notes::add_attachment_references(tx, canonical, &carried, device_id, now_ms)?;
    Ok(())
}
