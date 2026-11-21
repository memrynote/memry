//! Seeding documents' baselines from packed `crdt_snapshot`s (chapter 08
//! §8.4), the same baseline [`BodyPull::fetch_baseline`] takes over
//! `GET /sync/crdt/snapshot/:noteId`, and their updates from packed
//! `crdt_update`s (§8.4.3), as a page of `GET /sync/crdt/updates` stores them.
//!
//! The caller decides which entries are usable (`pack_bootstrap/bodies.rs`,
//! after the body checks); this module verifies, and stores with cursors.
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

use std::collections::HashSet;
use std::sync::Arc;

use crate::api::errors::StorageError;

use super::log_writes::{Baseline, BodyEpochs, Freshness, PackRun, pack_freshness};
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

/// One packed update to seed: the next number of its document's run.
pub struct PackUpdateSeed<'a> {
    pub doc_id: &'a str,
    pub sequence_num: i64,
    /// From the entry's meta (§8.4.3), resolved as for a pulled update.
    pub signer_device_id: &'a str,
    pub packed: &'a [u8],
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
    /// is the same blob (§7.5, compared for equality only). A document whose
    /// body moved off its epoch in `epochs` is `Stale`: its new body is newer
    /// (#5356).
    pub async fn seed_pack_chunk(
        &self,
        entries: &[PackEntrySeed<'_>],
        epochs: &BodyEpochs,
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
        let opened = on_blocking_pool(fresh, Arc::clone(&self.cipher), open_all).await?;

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
        let stored = self.store_baselines(baselines, epochs).await?;
        for (at, stored) in placed.into_iter().zip(stored) {
            if !stored {
                outcome[at] = PackSeed::Stale;
            }
        }
        Ok(outcome)
    }
}

impl BodyPull {
    /// Verifies and stores `entries`, consecutive runs of one document each in
    /// sequence order. A run stops at its first update that does not open
    /// (§7.9's stop-at-gap): the updates before it are stored with their
    /// cursor and the document keeps its route pull from there. Answers the
    /// updates stored and the documents whose run stopped short, a run whose
    /// body moved off its epoch in `epochs` among them (#5356).
    pub async fn seed_pack_updates(
        &self,
        entries: &[PackUpdateSeed<'_>],
        epochs: &BodyEpochs,
    ) -> Result<(usize, HashSet<String>), BodyPullError> {
        let owned: Vec<(usize, String, String, Vec<u8>)> = entries
            .iter()
            .enumerate()
            .map(|(at, entry)| {
                (
                    at,
                    entry.doc_id.to_owned(),
                    entry.signer_device_id.to_owned(),
                    entry.packed.to_vec(),
                )
            })
            .collect();
        let opened = on_blocking_pool(owned, Arc::clone(&self.cipher), |cipher, part| {
            part.into_iter()
                .map(|(at, doc_id, signer, packed)| {
                    let update = cipher
                        .open(&PackedUpdate {
                            doc_id: &doc_id,
                            signer_device_id: Some(&signer),
                            packed: &packed,
                        })
                        .ok();
                    (at, update)
                })
                .collect()
        })
        .await?;

        let mut stopped = HashSet::new();
        let mut runs: Vec<PackRun> = Vec::new();
        for (at, update) in opened {
            let entry = &entries[at];
            if stopped.contains(entry.doc_id) {
                continue;
            }
            let Some(update) = update else {
                stopped.insert(entry.doc_id.to_owned());
                continue;
            };
            match runs.last_mut() {
                Some((doc_id, run)) if doc_id == entry.doc_id => {
                    run.push((entry.sequence_num, update))
                }
                _ => runs.push((entry.doc_id.to_owned(), vec![(entry.sequence_num, update)])),
            }
        }
        let wanted: Vec<usize> = runs.iter().map(|(_, run)| run.len()).collect();
        let doc_ids: Vec<String> = runs.iter().map(|(doc_id, _)| doc_id.clone()).collect();
        let stored = self.store_pack_runs(runs, epochs).await?;
        let mut applied = 0;
        for ((doc_id, wanted), stored) in doc_ids.into_iter().zip(wanted).zip(stored) {
            applied += stored;
            if stored < wanted {
                stopped.insert(doc_id);
            }
        }
        Ok((applied, stopped))
    }
}

/// Runs `open` over `items` on the blocking pool, one slice per core, and
/// answers the results in the order of `items`. Verify and decrypt are about
/// half a chunk's cost.
async fn on_blocking_pool<T, R>(
    items: Vec<T>,
    cipher: Arc<dyn CrdtCipher>,
    open: fn(&dyn CrdtCipher, Vec<T>) -> Vec<R>,
) -> Result<Vec<R>, StorageError>
where
    T: Send + 'static,
    R: Send + 'static,
{
    let cores = std::thread::available_parallelism().map_or(1, usize::from);
    let slice = items.len().div_ceil(cores).max(1);
    let mut items = items.into_iter().peekable();
    let mut tasks = Vec::new();
    while items.peek().is_some() {
        let part: Vec<T> = items.by_ref().take(slice).collect();
        let cipher = Arc::clone(&cipher);
        tasks.push(tokio::task::spawn_blocking(move || {
            open(cipher.as_ref(), part)
        }));
    }
    let mut out = Vec::new();
    for task in tasks {
        out.extend(task.await.map_err(|error| StorageError::Failed {
            what: format!("the pack signature checks did not finish: {error}"),
        })?);
    }
    Ok(out)
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
