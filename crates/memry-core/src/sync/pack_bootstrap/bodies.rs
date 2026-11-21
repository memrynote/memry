//! Bodies from `crdt_snapshot` and `crdt_update` packs (chapter 08 §8.4.3,
//! §8.10, #5232).
//!
//! The order is the chapter's: hold the pack bytes, then read the body checks,
//! then apply what they confirm.
//!
//! 1. **Hold.** Every listed body pack is downloaded, [`RECORD_DOWNLOAD_WIDTH`]
//!    at a time, verified (§8.5) and spilled to a file of the spill directory.
//!    A pack does not fit in memory beside the others, and the checks must be
//!    read after all of them are held. The rename that lands a file is its
//!    done mark, so a killed run downloads no finished pack again. Only a
//!    compact index stays in memory.
//! 2. **Check.** One body manifest read (`GET /sync/crdt/manifest`), or the
//!    batch route when the server answers it 404 or the read stops short.
//! 3. **Snapshots.** A packed snapshot is applied only when its `revision` is
//!    the checked one.
//! 4. **Updates.** Per document, [`plan_packed_updates`]: above the `floor`,
//!    the cursor plus one, stopping at the first gap. A document whose server
//!    snapshot this device does not hold takes none (§7.8).
//! 5. **Settle.** With a body manifest, a document at its `maxSequenceNum`
//!    with the server's snapshot held needs no pull; every other live
//!    document is owed one. The batch fallback proves no document current.
//!
//! A document whose record is a tombstone or absent takes nothing (§8.10),
//! checked again in each store transaction. Applies are chunked at
//! [`BODY_CHUNK_ENTRIES`] entries or [`BODY_CHUNK_BYTES`] of payload.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::Value as Json;

use crate::api::errors::StorageError;
use crate::protocol::pack::{PackEntry, PackKind};

use super::super::body_pull::{BodyEpochs, BodyPullError, PackEntrySeed, PackSeed, PackUpdateSeed};
use super::super::first_sync_store::{body_states, settle_pack_bodies};
use super::PackBootstrap;
use super::body_plan::{BodyCheck, ServerSnapshot, plan_packed_updates, updates_may_follow};
use super::download::Downloads;
use super::listing::{PackSummary, list};
use super::spill::{self, Loc, Spilled};

/// Entries per apply transaction.
pub const BODY_CHUNK_ENTRIES: usize = 250;

/// Payload bytes per apply transaction, so a chunk of large bodies is cut
/// before [`BODY_CHUNK_ENTRIES`].
pub const BODY_CHUNK_BYTES: usize = 4 * 1024 * 1024;

/// What the body pack phase did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BodyPackReport {
    /// Body packs were held and every live document was settled or owed.
    /// `false` leaves the bodies to the item-granular path.
    pub ran: bool,
    pub packs_held: usize,
    pub snapshots_applied: usize,
    pub updates_applied: usize,
    /// Entries whose meta is unusable (§8.4).
    pub entries_unusable: usize,
    /// Entries the checks did not confirm, or that did not verify.
    pub entries_unconfirmed: usize,
    /// The checks came from a body manifest read, not the batch fallback.
    pub manifest: bool,
    /// Documents proven current, and documents owed a route pull.
    pub settled: usize,
    pub owed: usize,
    pub requests: usize,
    pub fallback_reasons: Vec<String>,
}

struct HeldSnapshot {
    sequence_num: i64,
    revision: String,
    loc: Loc,
}

struct HeldUpdate {
    sequence_num: i64,
    signer: usize,
    loc: Loc,
}

/// The index of every held body pack: entries by document, payloads on disk.
#[derive(Default)]
struct Held {
    files: Vec<PathBuf>,
    snapshots: HashMap<String, Vec<HeldSnapshot>>,
    updates: HashMap<String, Vec<HeldUpdate>>,
    signers: Vec<String>,
}

impl Held {
    fn index(&mut self, path: PathBuf, entries: Vec<PackEntry>, report: &mut BodyPackReport) {
        let pack = self.files.len();
        self.files.push(path);
        for entry in entries {
            let loc = Loc {
                pack,
                offset: entry.offset,
                length: entry.length,
                sha256: entry.sha256,
            };
            match (entry.kind, read_meta(entry.kind, entry.meta.as_ref())) {
                (PackKind::CrdtSnapshot, Some((sequence_num, Meta::Revision(revision)))) => self
                    .snapshots
                    .entry(entry.id)
                    .or_default()
                    .push(HeldSnapshot {
                        sequence_num,
                        revision,
                        loc,
                    }),
                (PackKind::CrdtUpdate, Some((sequence_num, Meta::Signer(signer)))) => {
                    let signer = match self.signers.iter().position(|held| *held == signer) {
                        Some(at) => at,
                        None => {
                            self.signers.push(signer);
                            self.signers.len() - 1
                        }
                    };
                    self.updates.entry(entry.id).or_default().push(HeldUpdate {
                        sequence_num,
                        signer,
                        loc,
                    })
                }
                _ => report.entries_unusable += 1,
            }
        }
    }

    fn documents(&self) -> HashSet<&String> {
        self.snapshots.keys().chain(self.updates.keys()).collect()
    }
}

enum Meta {
    Revision(String),
    Signer(String),
}

/// A snapshot's `{sequenceNum, revision}` or an update's `{sequenceNum,
/// signerDeviceId}` (`sequenceNum` at least 1), all present, or the entry is
/// not trusted.
fn read_meta(kind: PackKind, meta: Option<&Json>) -> Option<(i64, Meta)> {
    let meta = meta?;
    let sequence_num = meta.get("sequenceNum").and_then(Json::as_i64)?;
    let text = |key: &str| {
        meta.get(key)
            .and_then(Json::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    match kind {
        PackKind::CrdtSnapshot => Some((sequence_num, Meta::Revision(text("revision")?))),
        PackKind::CrdtUpdate if sequence_num >= 1 => {
            Some((sequence_num, Meta::Signer(text("signerDeviceId")?)))
        }
        _ => None,
    }
}

impl PackBootstrap {
    /// Holds, checks, applies and settles. A listing failure, no body pack, a
    /// spill that cannot be written, or no spill directory answers
    /// `ran: false`: the item-granular bodies pass then decides every
    /// document, as before packs. Only a SQLite failure is an error.
    ///
    /// The spill is removed on every `Ok`, `ran: false` included, since the
    /// phase does not run again after one. An `Err` keeps it: the first sync
    /// is retried with the marker unset, and the retry downloads no held
    /// pack again.
    pub async fn run_bodies(&self, now_s: i64) -> Result<BodyPackReport, BodyPullError> {
        let mut report = BodyPackReport::default();
        let Some(dir) = &self.spill_dir else {
            return Ok(report);
        };
        let result = self.bodies_through(dir, now_s, &mut report).await;
        result?;
        report.fallback_reasons.extend(spill::remove(dir).await);
        Ok(report)
    }

    /// Removes a spill a killed run left, for a resume that does not run the
    /// phase again. Answers why it could not.
    pub async fn remove_spill(&self) -> Option<String> {
        spill::remove(self.spill_dir.as_deref()?).await
    }

    async fn bodies_through(
        &self,
        dir: &Path,
        now_s: i64,
        report: &mut BodyPackReport,
    ) -> Result<(), BodyPullError> {
        // Before anything is fetched: a body purged after this, by a delete
        // or a revive, takes nothing the packs hold (#5356).
        let epochs = self.bodies.body_epochs().await?;
        let listing = match list(&self.http, self.vault_id.as_deref(), now_s).await {
            Ok(listing) => listing,
            Err(error) => {
                report.requests += 1;
                report.fallback_reasons.push(error.to_string());
                return Ok(());
            }
        };
        report.requests += listing.pages;
        let packs: Vec<PackSummary> = listing
            .packs
            .into_iter()
            .filter(|pack| matches!(pack.kind, PackKind::CrdtSnapshot | PackKind::CrdtUpdate))
            .collect();
        if packs.is_empty() {
            return Ok(());
        }
        let Some(held) = self.hold(dir, packs, now_s, report).await? else {
            return Ok(());
        };
        if held.files.is_empty() {
            return Ok(());
        }

        let checks = match self.bodies.read_body_manifest(&mut report.requests).await? {
            Some(checks) => {
                report.manifest = true;
                checks
            }
            None => {
                report
                    .fallback_reasons
                    .push("no body manifest: checked through the batch route".to_owned());
                let docs = since_per_document(&held);
                self.bodies
                    .batch_checks(&docs, &mut report.requests)
                    .await?
            }
        };
        self.apply_snapshots(&held, &checks, &epochs, report)
            .await?;
        self.apply_updates(&held, &checks, &epochs, report).await?;

        let manifest = report.manifest.then_some(checks);
        let (settled, owed) = self
            .db
            .call(move |conn| settle_pack_bodies(conn, manifest.as_ref()))
            .await?;
        report.settled = settled;
        report.owed = owed;
        report.ran = true;
        Ok(())
    }

    /// Downloads and spills every pack not already held, and indexes them
    /// all. A pack that fails to download or verify is absent (§8.12). `None`
    /// when the spill cannot be written: no pack is used.
    async fn hold(
        &self,
        dir: &Path,
        packs: Vec<PackSummary>,
        now_s: i64,
        report: &mut BodyPackReport,
    ) -> Result<Option<Held>, BodyPullError> {
        if let Err(error) = spill::create(dir).await? {
            report
                .fallback_reasons
                .push(format!("the pack spill cannot be created: {error}"));
            return Ok(None);
        }
        let mut held = Held::default();
        let mut queue = Vec::new();
        for pack in packs {
            let path = dir.join(spill::name(&pack.id));
            match spill::read_held(&path).await? {
                Some(entries) => held.index(path, entries, report),
                None => queue.push((pack, path)),
            }
        }
        let mut downloads = Downloads::new(&self.http, self.vault_id.as_deref(), now_s, queue);
        loop {
            let next = downloads
                .next(&mut report.requests, &mut report.fallback_reasons)
                .await
                .map_err(|error| StorageError::Failed {
                    what: format!("a body pack download did not finish: {error}"),
                })?;
            let Some((pack, path, bytes)) = next else {
                break;
            };
            match spill::verify_and_write(&path, bytes).await? {
                Spilled::Held(entries) => held.index(path, entries, report),
                Spilled::NotWritten(error) => {
                    report
                        .fallback_reasons
                        .push(format!("pack {} cannot be spilled: {error}", pack.id));
                    return Ok(None);
                }
                Spilled::Unusable(reason) => report
                    .fallback_reasons
                    .push(format!("pack {}: {reason}", pack.id)),
            }
        }
        report.packs_held = held.files.len();
        Ok(Some(held))
    }

    async fn apply_snapshots(
        &self,
        held: &Held,
        checks: &HashMap<String, BodyCheck>,
        epochs: &BodyEpochs,
        report: &mut BodyPackReport,
    ) -> Result<(), BodyPullError> {
        let mut todo: Vec<(&str, &HeldSnapshot)> = Vec::new();
        for (doc_id, entries) in &held.snapshots {
            let confirmed = match checks.get(doc_id).map(|check| &check.snapshot) {
                // The cursor is set from the entry's number, so it must be
                // the checked one too.
                Some(ServerSnapshot::Some {
                    sequence_num,
                    revision,
                }) => entries.iter().find(|entry| {
                    entry.revision == *revision && entry.sequence_num == *sequence_num
                }),
                _ => None,
            };
            report.entries_unconfirmed += entries.len() - usize::from(confirmed.is_some());
            if let Some(entry) = confirmed {
                todo.push((doc_id, entry));
            }
        }
        todo.sort_by_key(|(_, entry)| (entry.loc.pack, entry.loc.offset));
        for chunk in chunks(&todo, |(_, entry)| entry.loc.length) {
            let payloads =
                spill::read_payloads(&held.files, chunk.iter().map(|(_, e)| e.loc).collect())
                    .await?;
            let mut seeds = Vec::with_capacity(chunk.len());
            for ((doc_id, entry), payload) in chunk.iter().zip(&payloads) {
                match payload {
                    Some(packed) => seeds.push(PackEntrySeed {
                        doc_id,
                        packed,
                        sequence_num: entry.sequence_num,
                        revision: &entry.revision,
                    }),
                    None => report.entries_unconfirmed += 1,
                }
            }
            for seeded in self.bodies.seed_pack_chunk(&seeds, epochs).await? {
                match seeded {
                    PackSeed::Applied => report.snapshots_applied += 1,
                    PackSeed::Stale => {}
                    PackSeed::Deleted | PackSeed::Unverified => report.entries_unconfirmed += 1,
                }
            }
        }
        Ok(())
    }

    async fn apply_updates(
        &self,
        held: &Held,
        checks: &HashMap<String, BodyCheck>,
        epochs: &BodyEpochs,
        report: &mut BodyPackReport,
    ) -> Result<(), BodyPullError> {
        let mut docs: Vec<String> = held
            .updates
            .keys()
            .filter(|doc_id| checks.contains_key(*doc_id))
            .cloned()
            .collect();
        docs.sort();
        let wanted = docs.clone();
        let states = self.db.call(move |conn| body_states(conn, &wanted)).await?;

        let total: usize = held.updates.values().map(Vec::len).sum();
        let mut applied = 0;
        let mut todo: Vec<(&str, &HeldUpdate)> = Vec::new();
        for (doc_id, entries) in &held.updates {
            let Some(check) = checks.get(doc_id) else {
                continue;
            };
            let (cursor, revision) = states.get(doc_id).cloned().unwrap_or_default();
            if !updates_may_follow(check, revision.as_deref()) {
                continue;
            }
            let digests: Vec<(i64, [u8; 32])> = entries
                .iter()
                .map(|entry| (entry.sequence_num, entry.loc.sha256))
                .collect();
            let planned = plan_packed_updates(&digests, cursor.unwrap_or(0), check.floor, true);
            for sequence_num in planned.apply {
                if let Some(entry) = entries.iter().find(|e| e.sequence_num == sequence_num) {
                    todo.push((doc_id, entry));
                }
            }
        }
        todo.sort_by(|a, b| (a.0, a.1.sequence_num).cmp(&(b.0, b.1.sequence_num)));

        let mut stopped: HashSet<String> = HashSet::new();
        for chunk in chunks(&todo, |(_, entry)| entry.loc.length) {
            let chunk: Vec<&(&str, &HeldUpdate)> = chunk
                .iter()
                .filter(|(doc_id, _)| !stopped.contains(*doc_id))
                .collect();
            let payloads =
                spill::read_payloads(&held.files, chunk.iter().map(|(_, e)| e.loc).collect())
                    .await?;
            let mut seeds = Vec::with_capacity(chunk.len());
            for ((doc_id, entry), payload) in chunk.iter().zip(&payloads) {
                if stopped.contains(*doc_id) {
                    continue;
                }
                match payload {
                    Some(packed) => seeds.push(PackUpdateSeed {
                        doc_id,
                        sequence_num: entry.sequence_num,
                        signer_device_id: &held.signers[entry.signer],
                        packed,
                    }),
                    // A payload that no longer matches its digest is a gap.
                    None => {
                        stopped.insert((*doc_id).to_owned());
                    }
                }
            }
            let (stored, stops) = self.bodies.seed_pack_updates(&seeds, epochs).await?;
            applied += stored;
            stopped.extend(stops);
        }
        report.updates_applied += applied;
        report.entries_unconfirmed += total - applied;
        Ok(())
    }
}

/// For the batch fallback: each held document, with `since` at its highest
/// packed number so the answer carries little more than the checks.
fn since_per_document(held: &Held) -> Vec<(String, i64)> {
    let mut docs: Vec<(String, i64)> = held
        .documents()
        .into_iter()
        .map(|doc_id| {
            let snapshots = held.snapshots.get(doc_id).into_iter().flatten();
            let updates = held.updates.get(doc_id).into_iter().flatten();
            let highest = snapshots
                .map(|entry| entry.sequence_num)
                .chain(updates.map(|entry| entry.sequence_num))
                .max()
                .unwrap_or(0);
            (doc_id.clone(), highest.max(0))
        })
        .collect();
    docs.sort();
    docs
}

/// Cuts `items` at [`BODY_CHUNK_ENTRIES`] or [`BODY_CHUNK_BYTES`], whichever
/// comes first; a single larger entry is a chunk of its own.
fn chunks<T>(items: &[T], length: impl Fn(&T) -> u64) -> Vec<&[T]> {
    let mut out = Vec::new();
    let (mut start, mut bytes) = (0, 0u64);
    for (at, item) in items.iter().enumerate() {
        let size = length(item);
        if at > start
            && (at - start >= BODY_CHUNK_ENTRIES || bytes + size > BODY_CHUNK_BYTES as u64)
        {
            out.push(&items[start..at]);
            (start, bytes) = (at, 0);
        }
        bytes += size;
    }
    if start < items.len() {
        out.push(&items[start..]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_are_cut_by_count_and_by_bytes() {
        let small = vec![10u64; 600];
        let cut = chunks(&small, |size| *size);
        assert_eq!(
            cut.iter().map(|c| c.len()).collect::<Vec<_>>(),
            [250, 250, 100]
        );
        let large = vec![2 * 1024 * 1024u64; 5];
        let cut = chunks(&large, |size| *size);
        assert_eq!(cut.iter().map(|c| c.len()).collect::<Vec<_>>(), [2, 2, 1]);
        let huge = vec![9 * 1024 * 1024u64, 1];
        assert_eq!(chunks(&huge, |size| *size).len(), 2);
    }

    #[test]
    fn an_entry_without_its_freshness_fields_is_not_trusted() {
        let snapshot = serde_json::json!({"sequenceNum": 4, "revision": "r"});
        assert!(read_meta(PackKind::CrdtSnapshot, Some(&snapshot)).is_some());
        let no_revision = serde_json::json!({"sequenceNum": 4, "revision": ""});
        assert!(read_meta(PackKind::CrdtSnapshot, Some(&no_revision)).is_none());
        let update = serde_json::json!({"sequenceNum": 1, "signerDeviceId": "d"});
        assert!(read_meta(PackKind::CrdtUpdate, Some(&update)).is_some());
        let zero = serde_json::json!({"sequenceNum": 0, "signerDeviceId": "d"});
        assert!(read_meta(PackKind::CrdtUpdate, Some(&zero)).is_none());
        assert!(read_meta(PackKind::CrdtUpdate, None).is_none());
        assert!(read_meta(PackKind::Record, Some(&update)).is_none());
    }
}
