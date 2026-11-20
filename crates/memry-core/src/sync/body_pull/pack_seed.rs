//! Seeding documents' baselines from packed `crdt_snapshot`s (chapter 08
//! §8.4), the same baseline [`BodyPull::fetch_baseline`] takes over
//! `GET /sync/crdt/snapshot/:noteId`.
//!
//! It lives on [`BodyPull`] because the body feed owns a document's baseline
//! and its `crdt:<docId>` cursor. A seeded document then looks exactly like
//! one whose snapshot GET already ran: its cursor is the snapshot's
//! `sequenceNum` and its stored revision is the snapshot's `revision`, so the
//! bodies pass's §7.8 checks find nothing to fetch.
//!
//! A pack carries thousands of baselines, so they land a chunk at a time
//! (#5231): one read for the chunk's freshness, the signature checks on the
//! blocking pool, and one transaction that stores every verified baseline with
//! its cursor.

use std::sync::Arc;

use crate::api::errors::StorageError;

use super::log_writes::{Baseline, Freshness, pack_freshness};
use super::{BodyPull, BodyPullError, CrdtCipher, PackedUpdate};

/// Pack entries seeded per transaction. A chunk holds at most this many
/// opened snapshots in memory on top of the pack itself.
pub const PACK_SEED_CHUNK: usize = 250;

/// What one packed snapshot did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackSeed {
    Applied,
    /// The local document already holds these bytes or newer ones.
    Stale,
    /// The record feed says the document is deleted (§7.15).
    Deleted,
    /// No known signer verifies the bytes. The document keeps its GET.
    Unverified,
}

/// One pack entry to seed.
pub struct PackEntrySeed<'a> {
    pub doc_id: &'a str,
    pub packed: &'a [u8],
    pub sequence_num: i64,
    pub revision: &'a str,
}

impl BodyPull {
    /// Seeds every entry of `entries` whose local state is not already at or
    /// past it, and answers per entry in order.
    ///
    /// The freshness gate is desktop's `shouldApply`: a cursor at or above the
    /// snapshot's `sequenceNum` already absorbed it, and an equal `revision`
    /// is the same blob (§7.5, compared for equality only).
    pub async fn seed_pack_chunk(
        &self,
        entries: &[PackEntrySeed<'_>],
    ) -> Result<Vec<PackSeed>, BodyPullError> {
        let keys: Vec<(String, i64, String)> = entries
            .iter()
            .map(|entry| {
                (
                    entry.doc_id.to_owned(),
                    entry.sequence_num,
                    entry.revision.to_owned(),
                )
            })
            .collect();
        let mut outcome: Vec<PackSeed> = self
            .db
            .call(move |conn| {
                keys.iter()
                    .map(|(doc_id, sequence_num, revision)| {
                        pack_freshness(conn, *sequence_num, doc_id, revision).map(|fresh| {
                            match fresh {
                                Freshness::Fresh { .. } => PackSeed::Applied,
                                Freshness::Stale => PackSeed::Stale,
                                Freshness::Deleted => PackSeed::Deleted,
                            }
                        })
                    })
                    .collect::<Result<_, StorageError>>()
            })
            .await?;

        let fresh: Vec<(usize, String, Vec<u8>)> = entries
            .iter()
            .enumerate()
            .filter(|(at, _)| outcome[*at] == PackSeed::Applied)
            .map(|(at, entry)| (at, entry.doc_id.to_owned(), entry.packed.to_vec()))
            .collect();
        // Verify and decrypt are about half a chunk's cost, so they spread
        // over the blocking pool, one slice per core.
        let cores = std::thread::available_parallelism().map_or(1, usize::from);
        let slice = fresh.len().div_ceil(cores).max(1);
        let mut fresh = fresh.into_iter().peekable();
        let mut tasks = Vec::new();
        while fresh.peek().is_some() {
            let part: Vec<_> = fresh.by_ref().take(slice).collect();
            let cipher = Arc::clone(&self.cipher);
            tasks.push(tokio::task::spawn_blocking(move || {
                open_all(cipher.as_ref(), part)
            }));
        }
        let mut opened = Vec::new();
        for task in tasks {
            opened.extend(task.await.map_err(|error| StorageError::Failed {
                what: format!("the pack signature checks did not finish: {error}"),
            })?);
        }

        let mut baselines = Vec::with_capacity(opened.len());
        let mut placed = Vec::with_capacity(opened.len());
        for (at, snapshot) in opened {
            let Some(snapshot) = snapshot else {
                outcome[at] = PackSeed::Unverified;
                continue;
            };
            let entry = &entries[at];
            placed.push(at);
            baselines.push(Baseline {
                doc_id: entry.doc_id.to_owned(),
                snapshot,
                sequence_num: entry.sequence_num,
                revision: entry.revision.to_owned(),
            });
        }
        let stored = self.store_baselines(baselines).await?;
        let mut applied = Vec::new();
        for (at, stored) in placed.into_iter().zip(stored) {
            if stored {
                applied.push(entries[at].doc_id.to_owned());
            } else {
                outcome[at] = PackSeed::Stale;
            }
        }
        if !applied.is_empty()
            && let Some(observers) = &self.observers
        {
            observers.bodies_applied(applied).await;
        }
        Ok(outcome)
    }
}

/// The index names no signer, so every registered device is tried. This
/// proves what the item path proves: signed by a key of this account.
fn open_all(
    cipher: &dyn CrdtCipher,
    fresh: Vec<(usize, String, Vec<u8>)>,
) -> Vec<(usize, Option<Vec<u8>>)> {
    let candidates = cipher.signer_candidates();
    fresh
        .into_iter()
        .map(|(at, doc_id, packed)| {
            let opened = candidates.iter().find_map(|device| {
                cipher
                    .open(&PackedUpdate {
                        doc_id: &doc_id,
                        signer_device_id: Some(device),
                        packed: &packed,
                    })
                    .ok()
            });
            (at, opened)
        })
        .collect()
}
