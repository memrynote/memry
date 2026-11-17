//! Folds one vault's Electron y-leveldb store into one full-state update per document, for the
//! vault import (Step 36, #3553, writes them as rows, cursors and outbox).
//!
//! Which store is read follows `crdt-store-path.ts`: the vault's own store under
//! `crdt-stores/` (or the directory a pending rename still names, [`YStoreReader::store_dir`]).
//! The legacy global `crdt-store/` is read only when `crdtStore.legacyStoreClaimedBy` names this
//! vault and the vault has no store of its own: Electron's next launch would move it there
//! (`inheritLegacyCrdtStore`, :117-155). When the vault has its own store, Electron leaves the
//! legacy directory in place unread (:131-139), and so does the import.
//!
//! Every document is folded, deleted notes' included, except the ones listed in
//! [`YStoreFold::skipped`]: the store's pseudo documents, the legacy partition's set-aside
//! copies, journal days the partition still owes setting aside, and documents with no content.
//! A document `yrs` cannot read fails the whole vault with
//! [`ImportError::CorruptCrdtDocument`], naming every such document.

mod update_depth;

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use memry_core::crdt::DocumentRegistry;
use memry_core::crdt::registry::UpdateSink;

use super::ImportError;
use super::config::ElectronConfig;
use super::profile::ElectronProfile;
use super::scratch::{Scratch, TornFile};
use super::ystore::YStoreReader;

/// Prefix of every pseudo document the Electron app writes into a store: `__memry_crdt_store__`
/// (`crdt-store-epoch.ts:38`), `__memry_owed_compactions__` (`crdt-provider.ts:59`), the probes
/// `__memry_preflight__` and `__memry_crdt_probe__` (`crdt-preflight-child.ts:36`,
/// `crdt-persistence.ts:29`). A note id never starts with it (`crdt-legacy-partition.ts:9-16`).
const RESERVED_PREFIX: &str = "__memry_";
/// `UNATTRIBUTABLE_DOC_PREFIX` (`crdt-legacy-partition.ts:17`).
pub const UNATTRIBUTABLE_PREFIX: &str = "__memry_unattributable__/";
/// `EMPTY_DOC_UPDATE_BYTES` (`crdt-provider.ts:69`): an encode this size holds no item and no
/// delete, and Electron seeds such a document from its markdown.
const EMPTY_STATE_BYTES: usize = 4;
/// The fold authors nothing; this only names the replay's client id.
const READER_DEVICE_ID: &str = "memry-electron-import";

/// One document as one v1 update, the input of Step 36's `VaultImportInput.docs`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoldedDoc {
    pub doc_id: String,
    /// Every stored update applied in clock order, encoded against an empty state vector.
    pub state: Vec<u8>,
    /// `memry.snapshotWatermark.v1` `appliedSequence`, the document's `crdt:<docId>` cursor.
    /// `None`: no cursor, so the first pull fetches the whole document.
    pub watermark: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    /// A store pseudo document ([`RESERVED_PREFIX`]).
    Reserved,
    /// A copy the legacy partition set aside ([`UNATTRIBUTABLE_PREFIX`]).
    Unattributable,
    /// A journal day of an inherited legacy store whose partition is still owed
    /// (`crdtStore.legacyStorePartitionPendingFor`): Electron sets it aside before it opens the
    /// store (`partitionInheritedLegacyStore`), and the day re-seeds from its markdown.
    AmbiguousLegacy,
    /// No update, or updates that fold to an empty document.
    Empty,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedDoc {
    pub doc_id: String,
    pub reason: SkipReason,
}

/// What became of the legacy global store for this vault.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LegacyStore {
    Absent,
    /// Read as this vault's store: claimed by it, and the vault has none of its own.
    Read,
    /// Claimed by another vault.
    ClaimedByOther,
    /// Present and not read: unclaimed, or claimed by this vault while its own store exists.
    LeftUnread,
}

#[derive(Debug)]
pub struct YStoreFold {
    /// Sorted by document id.
    pub docs: Vec<FoldedDoc>,
    pub skipped: Vec<SkippedDoc>,
    /// Folded documents holding updates that wait on one the store lacks. Electron's Yjs holds
    /// them back the same way; the encode carries them.
    pub incomplete: Vec<String>,
    pub legacy: LegacyStore,
    /// A pending rename's previous store directory exists next to the vault's own and was not
    /// read ([`YStoreReader::unread_previous_store`]).
    pub previous_store_unread: bool,
    /// Keys of the read store that are none of y-leveldb's shapes.
    pub ignored_keys: usize,
    /// Files of the read store that end in a cut-short record.
    pub torn_tails: Vec<TornFile>,
}

/// Folds `vault_uuid`'s store. A vault with no store folds to no documents.
pub fn fold_vault_store(
    profile: &ElectronProfile,
    vault_uuid: &str,
    config: Option<&ElectronConfig>,
    scratch: &Scratch,
) -> Result<YStoreFold, ImportError> {
    let own = YStoreReader::open(profile, vault_uuid, config, scratch)?;
    let claimed_by = config.and_then(ElectronConfig::legacy_store_claimed_by);
    let legacy_present =
        std::fs::symlink_metadata(profile.legacy_crdt_store_dir()).is_ok_and(|m| m.is_dir());
    let (store, legacy) = match (own, legacy_present, claimed_by) {
        (own, false, _) => (own, LegacyStore::Absent),
        (Some(own), true, Some(claim)) if claim == vault_uuid => {
            (Some(own), LegacyStore::LeftUnread)
        }
        (None, true, Some(claim)) if claim == vault_uuid => (
            YStoreReader::open_legacy(profile, scratch)?,
            LegacyStore::Read,
        ),
        (own, true, Some(_)) => (own, LegacyStore::ClaimedByOther),
        (own, true, None) => (own, LegacyStore::LeftUnread),
    };
    let partition_owed = config
        .and_then(ElectronConfig::legacy_store_partition_pending_for)
        .is_some_and(|pending| pending == vault_uuid);
    let previous_store_unread =
        YStoreReader::unread_previous_store(profile, vault_uuid, config).is_some();

    let Some(store) = store else {
        return Ok(YStoreFold {
            docs: Vec::new(),
            skipped: Vec::new(),
            incomplete: Vec::new(),
            legacy,
            previous_store_unread,
            ignored_keys: 0,
            torn_tails: Vec::new(),
        });
    };
    let mut fold = fold_store(&store, partition_owed)?;
    fold.legacy = legacy;
    fold.previous_store_unread = previous_store_unread;
    Ok(fold)
}

/// Folds every document of `store`. `partition_owed`: journal days are set aside.
pub fn fold_store(store: &YStoreReader, partition_owed: bool) -> Result<YStoreFold, ImportError> {
    let mut skipped = Vec::new();
    let mut jobs = Vec::new();
    for doc_id in store.doc_names() {
        let reason = if doc_id.starts_with(UNATTRIBUTABLE_PREFIX) {
            Some(SkipReason::Unattributable)
        } else if doc_id.starts_with(RESERVED_PREFIX) {
            Some(SkipReason::Reserved)
        } else if partition_owed && is_journal_day(&doc_id) {
            Some(SkipReason::AmbiguousLegacy)
        } else if store.updates(&doc_id).is_empty() {
            Some(SkipReason::Empty)
        } else {
            None
        };
        match reason {
            Some(reason) => skipped.push(SkippedDoc { doc_id, reason }),
            None => jobs.push(doc_id),
        }
    }

    let mut docs = Vec::with_capacity(jobs.len());
    let mut incomplete = Vec::new();
    let mut corrupt = Vec::new();
    for (doc_id, result) in jobs.iter().zip(fold_parallel(store, &jobs)) {
        match result {
            Ok(Fold { state, .. }) if state.len() <= EMPTY_STATE_BYTES => {
                skipped.push(SkippedDoc {
                    doc_id: doc_id.clone(),
                    reason: SkipReason::Empty,
                });
            }
            Ok(Fold { state, missing }) => {
                if missing {
                    incomplete.push(doc_id.clone());
                }
                docs.push(FoldedDoc {
                    doc_id: doc_id.clone(),
                    state,
                    watermark: store.watermark(doc_id).map(|w| w.applied_sequence),
                });
            }
            Err(kind) => {
                // The id and the failure's kind only: never bytes of the document.
                tracing::warn!(
                    scope = "electron_import",
                    doc_id,
                    kind,
                    "unreadable CRDT document"
                );
                corrupt.push(doc_id.clone());
            }
        }
    }
    if !corrupt.is_empty() {
        return Err(ImportError::CorruptCrdtDocument(corrupt));
    }
    skipped.sort_by(|a, b| a.doc_id.cmp(&b.doc_id));
    Ok(YStoreFold {
        docs,
        skipped,
        incomplete,
        legacy: LegacyStore::Absent,
        previous_store_unread: false,
        ignored_keys: store.ignored_keys(),
        torn_tails: store.torn_tails().to_vec(),
    })
}

/// `isCrossVaultAmbiguousDocId` (`crdt-legacy-partition.ts:30`): `^j\d{4}-\d{2}-\d{2}$`.
fn is_journal_day(doc_id: &str) -> bool {
    let b = doc_id.as_bytes();
    b.len() == 11
        && b[0] == b'j'
        && b[5] == b'-'
        && b[8] == b'-'
        && [1, 2, 3, 4, 6, 7, 9, 10]
            .iter()
            .all(|&i| b[i].is_ascii_digit())
}

struct Fold {
    state: Vec<u8>,
    missing: bool,
}

/// One result per job, in job order. The documents are independent, so they fold across
/// `available_parallelism - 1` threads (at least one); each thread has the default 2 MiB stack
/// the depth guard is sized for.
fn fold_parallel(store: &YStoreReader, jobs: &[String]) -> Vec<Result<Fold, &'static str>> {
    let workers = std::thread::available_parallelism()
        .map_or(1, |n| n.get().saturating_sub(1))
        .clamp(1, jobs.len().max(1));
    let next = AtomicUsize::new(0);
    let mut results: Vec<(usize, Result<Fold, &'static str>)> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..workers)
            .map(|_| {
                scope.spawn(|| {
                    let mut out = Vec::new();
                    loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        let Some(doc_id) = jobs.get(i) else {
                            return out;
                        };
                        out.push((i, fold_doc(doc_id, &store.updates(doc_id))));
                    }
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|h| h.join().expect("fold_doc catches its own panics"))
            .collect()
    });
    results.sort_by_key(|(i, _)| *i);
    results.into_iter().map(|(_, r)| r).collect()
}

/// `getYDoc` in y-leveldb: every update in clock order into one document, then the whole
/// document as one update. A panic inside `yrs` on bytes it cannot integrate counts as an
/// unreadable document, not a crash of the import.
fn fold_doc(doc_id: &str, updates: &[(u32, &[u8])]) -> Result<Fold, &'static str> {
    for (_, update) in updates {
        update_depth::check(update).map_err(|refusal| match refusal {
            update_depth::Refusal::TooDeep => "too_deep",
            update_depth::Refusal::Malformed => "malformed",
        })?;
    }
    catch_unwind(AssertUnwindSafe(|| {
        let sink: UpdateSink = Arc::new(|_, _| {});
        let document = DocumentRegistry::new(READER_DEVICE_ID, sink)
            .get_or_open(doc_id)
            .map_err(|_| "open")?;
        for (_, update) in updates {
            document
                .apply_durable_update(update)
                .map_err(|_| "undecodable")?;
        }
        Ok(Fold {
            missing: document.has_missing_updates().map_err(|_| "read")?,
            state: document.encode_state().map_err(|_| "encode")?,
        })
    }))
    .unwrap_or(Err("panic"))
}

#[cfg(test)]
mod tests;
