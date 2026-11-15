//! The extended-offline cursor reset, Electron's `reconnectSync`
//! (`apps/desktop/src/main/sync/engine.ts:929-936`,
//! `STALE_CURSOR_THRESHOLD_MS`, `engine/sync-context.ts:289`).
//!
//! A device that comes back online more than a day after its last successful
//! pull reads the record feed again from the start. The feed is one ordered
//! stream, so whatever a day's gap could have hidden behind the stored cursor
//! (a page refused on a server bug since fixed, a row the server re-cursored)
//! is read again; re-applying a known row is an identical skip (chapter 06
//! §6.5.2 P4), so the cost is the requests.
//!
//! The driver arms it from the reachability seam when the network comes back
//! ([`StaleCursor::on_change`]), and the next feed pull takes the arm before
//! its first page, under the pass gate, through
//! [`super::super::feed_restart`]'s path: a pull holding the gate would
//! otherwise overwrite the reset with its own next cursor. The last success is
//! the newest `pull` row of [`super::history`], which the driver writes for
//! every pull that delivered and which survives a restart.

use std::sync::atomic::{AtomicBool, Ordering};

use rusqlite::{Connection, OptionalExtension, params};

use crate::api::errors::StorageError;
use crate::seams::reachability::{ReachabilityObserver, Reachable};
use crate::sync::store::{self, RECORD_CURSOR_SCOPE};

use super::history::HistoryKind;

/// `STALE_CURSOR_THRESHOLD_MS`: a day.
pub const STALE_AFTER_MS: i64 = 24 * 60 * 60 * 1000;

/// Armed when the network comes back; taken by the next feed pull.
#[derive(Debug, Default)]
pub struct StaleCursor {
    armed: AtomicBool,
}

impl StaleCursor {
    /// Takes the arm: `true` once per reconnect.
    pub(crate) fn take(&self) -> bool {
        self.armed.swap(false, Ordering::SeqCst)
    }
}

impl ReachabilityObserver for StaleCursor {
    fn on_change(&self, reachable: Reachable) {
        if reachable != Reachable::Offline {
            self.armed.store(true, Ordering::SeqCst);
        }
    }
}

/// Clears the record cursor when the newest successful pull is more than
/// [`STALE_AFTER_MS`] before `now_ms`. `true` when it did. A device with no
/// pull on record, or no cursor, has nothing to reset.
pub(crate) fn reset_if_stale(conn: &Connection, now_ms: i64) -> Result<bool, StorageError> {
    let last_pull: Option<i64> = conn
        .query_row(
            "SELECT MAX(created_at) FROM sync_history WHERE kind = ?1",
            params![HistoryKind::Pull.as_str()],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?
        .flatten();
    let stale = last_pull.is_some_and(|last| now_ms - last > STALE_AFTER_MS);
    if !stale || store::read_cursor(conn, RECORD_CURSOR_SCOPE)?.is_none() {
        return Ok(false);
    }
    eprintln!(
        "memry-core: back online {} h after the last pull: reading the record feed from the start",
        (now_ms - last_pull.unwrap_or(now_ms)) / 3_600_000
    );
    store::write_cursor(conn, RECORD_CURSOR_SCOPE, None, now_ms)?;
    Ok(true)
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::seams::reachability::ReachabilityObserver;
    use crate::storage::{open_data, test_support::temp_dir};
    use crate::sync::hardening::history;

    const NOW: i64 = 1_760_000_000_000;
    const HOUR: i64 = 60 * 60 * 1000;

    /// The cursor after a reconnect `hours` after the last successful pull.
    fn cursor_after(hours: i64) -> Option<String> {
        let dir = temp_dir("stale-cursor");
        let db = open_data(&dir.path().join("data.db")).expect("open");
        db.call_blocking(move |conn| {
            history::record(conn, HistoryKind::Pull, 3, 10, None, NOW)?;
            store::write_cursor(conn, RECORD_CURSOR_SCOPE, Some("4200"), NOW)?;
            reset_if_stale(conn, NOW + hours * HOUR)?;
            store::read_cursor(conn, RECORD_CURSOR_SCOPE)
        })
        .expect("reset")
    }

    #[test]
    fn a_reconnect_25_hours_after_the_last_pull_resets_the_cursor() {
        assert_eq!(cursor_after(25), None);
    }

    #[test]
    fn a_reconnect_23_hours_after_the_last_pull_keeps_the_cursor() {
        assert_eq!(cursor_after(23).as_deref(), Some("4200"));
    }

    #[test]
    fn only_a_pull_counts_as_the_last_success() {
        let dir = temp_dir("stale-cursor-kinds");
        let db = open_data(&dir.path().join("data.db")).expect("open");
        let cursor = db
            .call_blocking(|conn| {
                history::record(conn, HistoryKind::Pull, 1, 10, None, NOW)?;
                // A push and a failure a minute ago are not a pull.
                let recent = NOW + 25 * HOUR - 60_000;
                history::record(conn, HistoryKind::Push, 1, 10, None, recent)?;
                history::record(conn, HistoryKind::Error, 0, 10, Some("offline"), recent)?;
                store::write_cursor(conn, RECORD_CURSOR_SCOPE, Some("7"), NOW)?;
                assert!(reset_if_stale(conn, NOW + 25 * HOUR)?);
                store::read_cursor(conn, RECORD_CURSOR_SCOPE)
            })
            .expect("reset");
        assert_eq!(cursor, None);
    }

    #[test]
    fn a_device_with_no_pull_on_record_keeps_its_cursor() {
        let dir = temp_dir("stale-cursor-none");
        let db = open_data(&dir.path().join("data.db")).expect("open");
        db.call_blocking(|conn| {
            store::write_cursor(conn, RECORD_CURSOR_SCOPE, Some("7"), NOW)?;
            assert!(!reset_if_stale(conn, NOW + 100 * HOUR)?);
            Ok(())
        })
        .expect("reset");
    }

    #[test]
    fn coming_back_online_arms_one_reset() {
        let stale = StaleCursor::default();
        stale.on_change(Reachable::Offline);
        assert!(!stale.take(), "going offline arms nothing");
        stale.on_change(Reachable::Wifi);
        assert!(stale.take());
        assert!(!stale.take(), "the arm is taken once");
    }
}
