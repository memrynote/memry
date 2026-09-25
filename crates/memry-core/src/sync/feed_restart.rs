//! The two reasons the record feed is read again from the start (chapter 05
//! §5.11). Both are one statement group, run by [`super::pull::PullLoop::run`]
//! before its first page.
//!
//! - **The declared types grew.** The server filters the one feed by the
//!   declaration, so a type added later has rows behind the stored cursor
//!   that no later page carries.
//! - **The one-time cursor-skip repair** (#2382, #2304). Before the server
//!   assigned cursors inside the committing transaction (#2282), a pull that
//!   landed between two concurrent pushes could step over the lower range for
//!   good. A device that synced then may hold that gap, and nothing else in
//!   this core re-reads it, so every install that holds a cursor re-pulls the
//!   feed once. Re-applying a known row is an identical skip (chapter 06
//!   §6.5.2 P4), so the cost is the requests.

use rusqlite::Connection;

use crate::api::errors::StorageError;

use super::first_sync_store::{read_meta, write_meta};
use super::store::{self, RECORD_CURSOR_SCOPE};

/// The declaration header value the record cursor was last advanced under.
pub const META_RECORD_DECLARATION: &str = "sync.record_declaration";

/// Three states, the same as desktop's `cursorSkipRepair`:
///
/// - absent: not started;
/// - `pending:<cursor>`: the record cursor was reset from `<cursor>` and no
///   pull has delivered since. An interrupted repair resumes from the stored
///   cursor and **never resets again**, or a page refused on every run would
///   restart it forever;
/// - `done`: a pull delivered after the reset, or there was nothing to
///   repair.
pub const META_CURSOR_SKIP_REPAIR: &str = "sync.cursor_skip_repair";

const REPAIR_DONE: &str = "done";

/// Starts the feed over when the declared types differ from the ones the
/// cursor was advanced under, or when a device that has pulled never recorded
/// them.
pub(super) fn restart_on_new_declaration(
    conn: &Connection,
    current: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    if read_meta(conn, META_RECORD_DECLARATION)?.as_deref() == Some(current) {
        return Ok(());
    }
    if store::read_cursor(conn, RECORD_CURSOR_SCOPE)?.is_some() {
        store::write_cursor(conn, RECORD_CURSOR_SCOPE, None, now_ms)?;
    }
    write_meta(conn, META_RECORD_DECLARATION, current)
}

/// Starts or resumes the repair. `true` while it is pending, so the caller
/// records `done` after a run that delivered.
///
/// A device with no cursor reads the whole feed anyway, which is the repair,
/// so it goes straight to `done`: a fresh install, and a device the
/// declaration restart just reset. The reset and `pending` commit together.
pub(super) fn begin_cursor_skip_repair(
    conn: &Connection,
    now_ms: i64,
) -> Result<bool, StorageError> {
    match read_meta(conn, META_CURSOR_SKIP_REPAIR)?.as_deref() {
        Some(REPAIR_DONE) => return Ok(false),
        Some(recorded) if recorded.starts_with("pending:") => return Ok(true),
        _ => {}
    }
    let Some(cursor) = store::read_cursor(conn, RECORD_CURSOR_SCOPE)? else {
        write_meta(conn, META_CURSOR_SKIP_REPAIR, REPAIR_DONE)?;
        return Ok(false);
    };
    let txn = conn.unchecked_transaction().map_err(failed)?;
    store::write_cursor(&txn, RECORD_CURSOR_SCOPE, None, now_ms)?;
    write_meta(&txn, META_CURSOR_SKIP_REPAIR, &format!("pending:{cursor}"))?;
    txn.commit().map_err(failed)?;
    Ok(true)
}

/// Records the repair done. Only after a run that was not refused and reached
/// the end of the feed.
pub(super) fn finish_cursor_skip_repair(conn: &Connection) -> Result<(), StorageError> {
    write_meta(conn, META_CURSOR_SKIP_REPAIR, REPAIR_DONE)
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
