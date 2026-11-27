//! The first sync's window boundary, chosen once and remembered. Split out of
//! [`super`] for the line ceiling.

use crate::sync::first_sync_store::{read_meta, write_meta};

use super::{FirstSync, FirstSyncError, META_FIRST_SYNC_WINDOW_START};

impl FirstSync {
    /// The window boundary, chosen once and remembered.
    pub(super) async fn window_start(&self, now_ms: i64) -> Result<i64, FirstSyncError> {
        // No window has no boundary to slide, so there is nothing to remember.
        let Some(window_ms) = self.limits.recent_window_ms else {
            return Ok(i64::MIN);
        };
        if let Some(stored) = self
            .db
            .call(|conn| read_meta(conn, META_FIRST_SYNC_WINDOW_START))
            .await?
            .and_then(|text| text.parse::<i64>().ok())
        {
            return Ok(stored);
        }
        let chosen = now_ms - window_ms;
        self.db
            .call(move |conn| write_meta(conn, META_FIRST_SYNC_WINDOW_START, &chosen.to_string()))
            .await?;
        Ok(chosen)
    }
}
