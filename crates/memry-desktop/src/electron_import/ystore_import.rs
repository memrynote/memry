//! Folds one vault's Electron y-leveldb store into one full-state update per document, for the
//! vault import (Step 36, #3553, writes them as rows, cursors and outbox).
//!
//! Which store is read follows `crdt-store-path.ts`: the vault's own store under
//! `crdt-stores/` (or the directory a pending rename still names, [`YStoreReader::store_dir`]).
//! The legacy global `crdt-store/` is read only when the vault has no store of its own and
//! `crdtStore.legacyStoreClaimedBy` names this vault, or names nobody and this vault is the
//! one [`fold_vault_store`] picks to inherit it: Electron's next launch of a vault without a
//! store moves it there (`inheritLegacyCrdtStore`, :117-155). Electron gives an unclaimed store
//! to the next vault the user opens, which the import cannot know, so it picks `currentVault`
//! (by path) when that vault has no store of its own, else the first vault in config order
//! without one (a departure from Electron); every other vault gets [`LegacyStore::LeftUnread`],
//! so no legacy document lands in two vaults. A vault's store is named by its `data.db`
//! `vault_metadata` singleton, else its config `vaultUuid` ([`electron_vault_uuid`]); a vault
//! with neither never had one. Taking an unclaimed store owes a partition when the
//! profile lists more than one vault (:140-142, `legacyStoreCouldBeAnotherVaults`). When the
//! vault has its own store, Electron leaves the legacy directory in place unread (:131-139),
//! and so does the import.
//!
//! Every document is folded, deleted notes' included, except the ones listed in
//! [`YStoreFold::skipped`]: the store's pseudo documents, the legacy partition's set-aside
//! copies, journal days the partition still owes setting aside, documents with no content, and
//! documents `yrs` cannot read. Electron opens an unreadable document's note from its markdown
//! (`crdt-provider.ts:944-950`), and the import leaves it to do the same: one damaged document
//! never stops the vault.
//!
//! The import report (Step 37e) shows, per vault: `skipped` by reason, `incomplete`, `legacy`,
//! `previous_store_unread`, `ignored_keys`, `torn_tails` and `owed_compactions`, and from the
//! journal replay `Replay::skipped` by reason, `other_vault` and `BulkApplyJournal::unknown`.

mod update_depth;

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use memry_core::crdt::DocumentRegistry;
use memry_core::crdt::registry::UpdateSink;

use super::ImportError;
use super::config::ElectronConfig;
use super::profile::ElectronProfile;
use super::scratch::{Scratch, TornFile};
use super::vault_evidence::{electron_vault_uuid, read_vault_evidence};
use super::ystore::Lib0Any;
use super::ystore::YStoreReader;

/// Prefix of every pseudo document the Electron app writes into a store: `__memry_crdt_store__`
/// (`crdt-store-epoch.ts:38`), `__memry_owed_compactions__` (`crdt-provider.ts:59`), the probes
/// `__memry_preflight__` and `__memry_crdt_probe__` (`crdt-preflight-child.ts:36`,
/// `crdt-persistence.ts:29`). A note id never starts with it (`crdt-legacy-partition.ts:9-16`).
const RESERVED_PREFIX: &str = "__memry_";
/// `OWED_COMPACTIONS_DOC` and `OWED_COMPACTIONS_KEY` (`crdt-provider.ts:59-60`).
const OWED_COMPACTIONS_DOC: &str = "__memry_owed_compactions__";
const OWED_COMPACTIONS_KEY: &str = "owedCompactions";
/// `UNATTRIBUTABLE_DOC_PREFIX` (`crdt-legacy-partition.ts:17`).
pub const UNATTRIBUTABLE_PREFIX: &str = "__memry_unattributable__/";
/// `EMPTY_DOC_UPDATE_BYTES` (`crdt-provider.ts:73`): an encode this size holds no item and no
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
    /// Updates `yrs` cannot decode or integrate safely; the note re-seeds from its markdown.
    Unreadable,
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
    /// Read as this vault's store: claimed by it, or unclaimed and picked for it; the vault has
    /// none of its own.
    Read,
    /// Claimed by another vault.
    ClaimedByOther,
    /// Present and not read: the vault has its own store, or the unclaimed store is picked for
    /// another vault (or for none, when no vault without a store can be named).
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
    /// Notes whose compaction a detached Electron provider recorded and never pushed
    /// (`oweStoredCompactions`, `crdt-provider.ts:415-427`): Step 36 owes them again
    /// (`extra_owed_docs`).
    pub owed_compactions: Vec<String>,
}

/// Folds the store of the vault whose config entry records `vault_path`, named `vault_uuid`:
/// [`electron_vault_uuid`] of its [`read_vault_evidence`] `vault_id` and its config
/// `vaultUuid`, else the uuid the import mints for it. A vault with no store folds to no
/// documents. Called once per vault of one profile, an unclaimed legacy store is `Read` by at
/// most one of them, provided the caller:
/// - resolves every `vault_uuid` that way, as the pick names the other vaults; a vault judged
///   differently by itself and by the others can make two readers;
/// - imports each config entry once, deduplicated by exact path string (no normalizing:
///   Electron's identity is the exact string).
///
/// Each call reads the other vaults' `data.db` again (n calls, n reads each); a caller with
/// many vaults may cache them per import.
pub fn fold_vault_store(
    profile: &ElectronProfile,
    vault_path: &str,
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
        (own, true, Some(claim)) if claim != vault_uuid => (own, LegacyStore::ClaimedByOther),
        (Some(own), true, _) => (Some(own), LegacyStore::LeftUnread),
        (None, true, None)
            if !inherits_unclaimed_legacy(profile, vault_path, vault_uuid, config, scratch) =>
        {
            (None, LegacyStore::LeftUnread)
        }
        (None, true, _) => (
            YStoreReader::open_legacy(profile, scratch)?,
            LegacyStore::Read,
        ),
    };
    // `getVaults().length > 1`: every stored entry counts, readable or not.
    let other_vaults = config.is_some_and(|c| {
        let (vaults, unreadable) = c.vaults();
        vaults.len() + unreadable > 1
    });
    let partition_owed = config
        .and_then(ElectronConfig::legacy_store_partition_pending_for)
        .is_some_and(|pending| pending == vault_uuid)
        || (legacy == LegacyStore::Read && claimed_by.is_none() && other_vaults);
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
            owed_compactions: Vec::new(),
        });
    };
    let mut fold = fold_store(&store, partition_owed);
    fold.legacy = legacy;
    fold.previous_store_unread = previous_store_unread;
    Ok(fold)
}

/// Whether this vault, which has no store, is the one vault the unclaimed legacy store goes to:
/// `currentVault` when it has no store, else the first vault in config order without one,
/// compared by exact path string, as Electron compares them. A vault whose folder (followed
/// through a symlink) is gone is passed over: Electron cannot open it. Every vault's import
/// applies this rule to the same list, the vault being imported included, so at most one
/// passes. A profile of one vault (or no config) gives the store to the vault being imported.
/// Each other vault is named by [`electron_vault_uuid`] (its singleton, then its config
/// `vaultUuid`), the order the caller names the vault being imported by.
fn inherits_unclaimed_legacy(
    profile: &ElectronProfile,
    vault_path: &str,
    vault_uuid: &str,
    config: Option<&ElectronConfig>,
    scratch: &Scratch,
) -> bool {
    let Some(config) = config else {
        return true;
    };
    let (vaults, unreadable) = config.vaults();
    if vaults.len() + unreadable <= 1 {
        return true;
    }
    let is_dir = |path: &Path| std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir());
    let has_store = |path: &str| {
        let uuid = if path == vault_path {
            Some(vault_uuid.to_owned())
        } else {
            let config_uuid = vaults
                .iter()
                .find(|v| v.path == path)
                .and_then(|v| v.vault_uuid.as_deref());
            electron_vault_uuid(
                data_db_vault_uuid(Path::new(path), scratch).as_deref(),
                config_uuid,
            )
        };
        uuid.is_some_and(|uuid| is_dir(&YStoreReader::store_dir(profile, &uuid, Some(config))))
    };
    config
        .current_vault()
        .into_iter()
        .chain(vaults.iter().map(|v| v.path.as_str()))
        .filter(|path| std::fs::metadata(path).is_ok_and(|m| m.is_dir()))
        .find(|path| !has_store(path))
        == Some(vault_path)
}

/// The `vault_metadata` singleton's uuid of the vault's `data.db`. A database that cannot be read counts
/// as no uuid, and is logged.
fn data_db_vault_uuid(vault: &Path, scratch: &Scratch) -> Option<String> {
    match read_vault_evidence(vault, scratch.root()) {
        Ok(evidence) => evidence?.vault_id,
        Err(error) => {
            tracing::warn!(
                scope = "electron_import",
                error = %error,
                "unreadable vault data.db; its legacy store claim is judged without its uuid"
            );
            None
        }
    }
}

/// Folds every document of `store`. `partition_owed`: journal days are set aside.
pub fn fold_store(store: &YStoreReader, partition_owed: bool) -> YStoreFold {
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
                    "unreadable CRDT document; its note re-seeds from markdown"
                );
                skipped.push(SkippedDoc {
                    doc_id: doc_id.clone(),
                    reason: SkipReason::Unreadable,
                });
            }
        }
    }
    skipped.sort_by(|a, b| a.doc_id.cmp(&b.doc_id));
    YStoreFold {
        docs,
        skipped,
        incomplete,
        legacy: LegacyStore::Absent,
        previous_store_unread: false,
        ignored_keys: store.ignored_keys(),
        torn_tails: store.torn_tails().to_vec(),
        owed_compactions: owed_compactions(store),
    }
}

/// The note ids in the owed-compactions marker; anything else in it is ignored, as Electron
/// ignores it (`typeof noteId === 'string'`).
fn owed_compactions(store: &YStoreReader) -> Vec<String> {
    match store.meta(OWED_COMPACTIONS_DOC, OWED_COMPACTIONS_KEY) {
        Some(Lib0Any::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                Lib0Any::String(id) => Some(id.clone()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
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
/// `available_parallelism - 1` workers (at least one).
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

/// Stack of a fold thread: what a spawned thread gets, which holds `yrs`'s `Any` decoding
/// within [`update_depth::MAX_ANY_DEPTH`], plus one level of `yrs`'s recursive type delete and
/// GC per type item. Measured per level (macOS arm64, 18 Nov, 10,000 and 40,000 nested arrays
/// deleted) at 1,376 bytes in a debug build and 352 in release; these leave about three times
/// that. The stack is reserved, not committed, so a large one costs address space only.
const FOLD_STACK_BASE: usize = 2 << 20;
const FOLD_STACK_PER_TYPE: usize = if cfg!(debug_assertions) {
    4 << 10
} else {
    1 << 10
};

/// `getYDoc` in y-leveldb: every update in clock order into one document, then the whole
/// document as one update, on a thread whose stack holds the deepest nesting the document's
/// type items allow. A panic inside `yrs` on bytes it cannot integrate counts as an
/// unreadable document, not a crash of the import.
fn fold_doc(doc_id: &str, updates: &[(u32, &[u8])]) -> Result<Fold, &'static str> {
    let bytes: Vec<&[u8]> = updates.iter().map(|(_, update)| *update).collect();
    let type_items = update_depth::check(&bytes).map_err(|refusal| match refusal {
        update_depth::Refusal::TooDeep => "too_deep",
        update_depth::Refusal::TooManyTypes => "too_many_types",
        update_depth::Refusal::Malformed => "malformed",
    })?;
    fold_on_sized_stack(doc_id, updates, type_items)
}

/// `type_items` bounds the type nesting `updates` can build.
fn fold_on_sized_stack(
    doc_id: &str,
    updates: &[(u32, &[u8])],
    type_items: usize,
) -> Result<Fold, &'static str> {
    std::thread::scope(|scope| {
        std::thread::Builder::new()
            .name("ystore-fold".to_owned())
            .stack_size(FOLD_STACK_BASE + type_items * FOLD_STACK_PER_TYPE)
            .spawn_scoped(scope, || integrate(doc_id, updates))
            .map_err(|_| "spawn")?
            .join()
            .unwrap_or(Err("panic"))
    })
}

fn integrate(doc_id: &str, updates: &[(u32, &[u8])]) -> Result<Fold, &'static str> {
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
