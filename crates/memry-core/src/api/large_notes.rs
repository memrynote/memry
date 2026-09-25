//! Notes near the sync size limit (spec 006 ST15), desktop
//! `packages/sync-client/src/note-size.ts`: a note's push payload over
//! `NOTE_SYNC_MAX_BYTES` stops syncing, and one at or above 0.8 of it is
//! "approaching".
//!
//! The size measured is the stored record payload's byte length, the same
//! bytes a push encrypts.

use rusqlite::params;

use crate::api::errors::StorageError;
use crate::api::notes::Notes;
use crate::domain::notes::failed;
use crate::protocol::envelope::NOTE_SYNC_MAX_BYTES;

/// `NOTE_SYNC_WARN_RATIO`.
pub const NOTE_SYNC_WARN_RATIO: f64 = 0.8;

/// `NOTE_SYNC_WARN_BYTES = floor(MAX * 0.8)`.
pub fn warn_bytes() -> i64 {
    (NOTE_SYNC_MAX_BYTES as f64 * NOTE_SYNC_WARN_RATIO).floor() as i64
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct LargeNote {
    pub id: String,
    /// `note` or `journal`.
    pub item_type: String,
    pub title: String,
    pub bytes: i64,
    /// Over the limit: this note does not sync.
    pub over_limit: bool,
}

#[uniffi::export]
impl Notes {
    /// Every live note and journal entry at or above the warning size,
    /// largest first.
    pub fn large_notes(&self) -> Result<Vec<LargeNote>, StorageError> {
        let warn = warn_bytes();
        let max = NOTE_SYNC_MAX_BYTES as i64;
        self.db.call_blocking(move |conn| {
            let mut statement = conn
                .prepare(
                    "SELECT item_id, item_type,
                            COALESCE(json_extract(payload, '$.title'), ''),
                            length(CAST(payload AS BLOB)) AS size
                       FROM sync_items
                      WHERE item_type IN ('note', 'journal')
                        AND deleted_at IS NULL AND payload IS NOT NULL
                        AND json_valid(payload)
                        AND length(CAST(payload AS BLOB)) >= ?1
                      ORDER BY size DESC",
                )
                .map_err(failed)?;
            let rows = statement
                .query_map(params![warn], |row| {
                    let bytes: i64 = row.get(3)?;
                    Ok(LargeNote {
                        id: row.get(0)?,
                        item_type: row.get(1)?,
                        title: row.get(2)?,
                        bytes,
                        over_limit: bytes > max,
                    })
                })
                .map_err(failed)?;
            rows.collect::<Result<_, _>>().map_err(failed)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::repositories::{InboundRecord, sync_items};
    use crate::storage::{open_data, test_support::temp_dir};

    #[test]
    fn warn_and_over_match_desktop_and_small_notes_are_left_out() {
        assert_eq!(NOTE_SYNC_MAX_BYTES, 3_826_919);
        assert_eq!(warn_bytes(), 3_061_535);
        let dir = temp_dir("large-notes");
        let db = open_data(&dir.path().join("data.db")).expect("open");
        let seed = |id: &str, body_len: usize| {
            let payload = format!(
                r#"{{"title":"{id}","content":"{}","clock":{{"a":1}}}}"#,
                "x".repeat(body_len)
            );
            db.call_blocking(|conn| {
                sync_items::apply_remote(
                    conn,
                    &InboundRecord {
                        item_type: "note".into(),
                        item_id: id.into(),
                        payload_json: payload,
                        server_cursor: Some(1),
                        signer_device_id: None,
                        updated_at: 1,
                        deleted_at: None,
                    },
                    1,
                )?;
                Ok(())
            })
            .expect("seed");
        };
        seed("small", 10);
        seed("near", 3_200_000);
        seed("over", 3_900_000);
        let notes = Notes::over(db.clone());
        let found = notes.large_notes().expect("large");
        assert_eq!(
            found
                .iter()
                .map(|n| (n.id.as_str(), n.over_limit))
                .collect::<Vec<_>>(),
            vec![("over", true), ("near", false)]
        );
        assert_eq!(found[1].title, "near");
    }
}
