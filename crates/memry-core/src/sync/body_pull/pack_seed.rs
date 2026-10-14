//! Seeding a document's baseline from a packed `crdt_snapshot` (chapter 08
//! §8.4), the same baseline [`BodyPull::fetch_baseline`] takes over
//! `GET /sync/crdt/snapshot/:noteId`.
//!
//! It lives on [`BodyPull`] because the body feed owns a document's baseline
//! and its `crdt:<docId>` cursor. A seeded document then looks exactly like
//! one whose snapshot GET already ran: its cursor is the snapshot's
//! `sequenceNum` and its stored revision is the snapshot's `revision`, so the
//! bodies pass's §7.8 checks find nothing to fetch.

use crate::api::errors::StorageError;
use crate::crdt::update_log::{self, Namespace};

use super::{BodyPull, BodyPullError, PackedUpdate};

/// What one packed snapshot did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackSeed {
    Applied,
    /// The local document already holds these bytes or newer ones.
    Stale,
    /// No known signer verifies the bytes. The document keeps its GET.
    Unverified,
}

impl BodyPull {
    /// Seeds `doc_id` from a packed snapshot, unless local state is already at
    /// or past it.
    ///
    /// The freshness gate is desktop's `shouldApply`: a cursor at or above the
    /// snapshot's `sequenceNum` already absorbed it, and an equal `revision`
    /// is the same blob (§7.5, compared for equality only).
    pub async fn seed_from_pack(
        &self,
        doc_id: &str,
        packed: &[u8],
        sequence_num: i64,
        revision: &str,
    ) -> Result<PackSeed, BodyPullError> {
        let cursor = self.read_cursor(doc_id).await?;
        if cursor >= sequence_num {
            return Ok(PackSeed::Stale);
        }
        let doc = doc_id.to_owned();
        let stored = self
            .db
            .call(move |conn| {
                update_log::snapshot(conn, Namespace::Server, &doc)
                    .map_err(|error| StorageError::Failed {
                        what: error.to_string(),
                    })
                    .map(|row| row.and_then(|row| row.server_revision))
            })
            .await?;
        if stored.as_deref() == Some(revision) {
            return Ok(PackSeed::Stale);
        }

        // The index names no signer, so every registered device is tried. This
        // proves what the item path proves: signed by a key of this account.
        let opened = self
            .cipher
            .signer_candidates()
            .into_iter()
            .find_map(|device| {
                self.cipher
                    .open(&PackedUpdate {
                        doc_id,
                        signer_device_id: Some(&device),
                        packed,
                    })
                    .ok()
            });
        let Some(snapshot) = opened else {
            return Ok(PackSeed::Unverified);
        };

        self.store_baseline(
            doc_id,
            snapshot,
            sequence_num,
            Some(revision.to_owned()),
            cursor,
        )
        .await?;
        Ok(PackSeed::Applied)
    }
}
