//! The vault phase's preparation (Step 37e1, #3554), before Step 36 (#3553) stages a vault:
//! which of the Electron config's vaults are imported and under which id, then per vault a
//! digest of the vault tree (the baseline of verification check 7), the bulk-apply journal
//! replay and the Yjs fold, in that order. A [`PreparedVault`] carries what
//! `stage_vault_import` takes from this step (`vault_id`, `docs`, `extra_owed_docs`) and the
//! vault's report section ([`report`]).
//!
//! The caller holds the Electron profile lock ([`super::ProfileLock::probe`]) for the whole
//! phase: the replay writes note files into the vault, as Electron's next launch would.

pub mod report;
pub mod tree;

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::journal_replay::{BulkApplyJournal, EntrySkip, Replay, replay};
use super::vault_evidence::electron_vault_uuid;
use super::ystore_import::{YStoreFold, fold_vault_store};
use super::{
    ElectronConfig, ElectronProfile, ImportError, Scratch, YStoreReader, read_vault_evidence,
};
pub use report::VaultPrepReport;
pub use tree::{ExpectedChanges, VaultTree};

/// Electron's sandbox vault, `<userData>/Sandbox` (`vault/sandbox.ts:12` `SANDBOX_FOLDER`).
const SANDBOX_DIR: &str = "Sandbox";
/// Step 36 (#3553) writes the canvas library into the vault; check 7 lets it differ.
pub const CANVAS_LIBRARY: &str = "canvases/library.excalidrawlib";

#[derive(Debug, Default)]
pub struct VaultPlan {
    /// `currentVault` first, then `vaults[]` in config order; each exact path string once.
    pub vaults: Vec<PlannedVault>,
    /// `vaults[]` entries naming a path an earlier entry named. Electron's `upsertVault`
    /// never writes one (`store.ts:422-445`), so only a hand edit does.
    pub duplicate_entries: usize,
    /// `vaults[]` entries without a string `path`.
    pub unreadable_entries: usize,
    /// Store directories that more than one importable vault resolves to
    /// ([`YStoreReader::store_dir`]): a copied vault folder carries its `data.db` singleton
    /// along, a pending rename points one vault at another's store, and `vaultDirName`
    /// lowercases a canonical uuid. Importing any of them would fold one store into several
    /// core vaults, so every vault of a group is [`DeferReason::SharedStore`] (Kaan, #3554:
    /// defer them all and list their paths).
    pub shared_stores: Vec<SharedStore>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedStore {
    /// The store directory's name under `crdt-stores/`, without the profile path.
    pub store: String,
    /// Each vault's id, in plan order, aligned with `paths`.
    pub vault_ids: Vec<String>,
    /// In plan order.
    pub paths: Vec<String>,
}

#[derive(Debug)]
pub struct PlannedVault {
    /// As the config records it. Paths compare as exact strings, as Electron compares them.
    pub path: String,
    pub current: bool,
    pub disposition: Disposition,
    /// The newest `__drizzle_migrations.created_at` of the vault's `data.db`, read with the
    /// plan's copy; `None` when it has no ledger or the vault is not importable.
    pub source_ledger: Option<i64>,
}

#[derive(Debug)]
pub enum Disposition {
    /// `<profile>/Sandbox`: never imported. Step 32 (#3549) regenerates it, and a core folder
    /// inside it would write into Electron's userData.
    Sandbox,
    /// Imported by `migrate_vault` when the session first opens it.
    Deferred(DeferReason),
    /// The vault's `data.db` reads wrong (SQLite refuses it, or its id is not text): not
    /// imported. The error names the row; the Electron files stay as they are.
    Unreadable(ImportError),
    /// The folder an earlier entry names under another path string (a trailing slash, another
    /// case on a case-insensitive volume, another Unicode normalisation): one `.memry/core`
    /// serves both, so it is imported once, under the earlier entry.
    SameFolder(String),
    Import(VaultId),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DeferReason {
    /// The folder is missing or cannot be reached (an unmounted drive, a denied folder).
    FolderMissing,
    DataDbMissing,
    /// `data.db` exists and could not be copied now (I/O error, denied, no scratch space).
    DataDbUnreachable,
    /// The vault resolves to a CRDT store another planned vault resolves to
    /// ([`VaultPlan::shared_stores`]). Never imported automatically.
    SharedStore,
}

/// The one id a vault is imported under: its core vault id (Step 36's
/// `VaultImportInput::vault_id`) and the name of its CRDT store, as one id serves both in
/// Electron. Resolved once per vault by [`electron_vault_uuid`], which the fold's legacy store
/// pick also names the other vaults with (`fold_vault_store`'s caller contract).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultId {
    pub vault_id: String,
    /// Neither `data.db` nor the config names the vault: a fresh v4 uuid, as Electron's
    /// `getOrCreateVaultUuid` mints one (`agent/storage/vault-id.ts:50`).
    pub minted: bool,
}

impl VaultId {
    fn resolve(singleton: Option<&str>, config_uuid: Option<&str>) -> Self {
        match electron_vault_uuid(singleton, config_uuid) {
            Some(vault_id) => Self {
                vault_id,
                minted: false,
            },
            None => Self {
                vault_id: uuid::Uuid::new_v4().to_string(),
                minted: true,
            },
        }
    }
}

/// Every vault the config names, with what the import does with it. Reads each vault's
/// `data.db` once, on a scratch copy.
pub fn plan_vaults(
    profile: &ElectronProfile,
    config: Option<&ElectronConfig>,
    scratch: &Scratch,
) -> VaultPlan {
    let Some(config) = config else {
        return VaultPlan::default();
    };
    let (stored, unreadable_entries) = config.vaults();
    let distinct: HashSet<&str> = stored.iter().map(|v| v.path.as_str()).collect();
    let current = config.current_vault();
    let sandbox = Sandbox::new(&profile.dir);
    let mut seen = HashSet::new();
    let mut vaults: Vec<PlannedVault> = current
        .into_iter()
        .chain(stored.iter().map(|v| v.path.as_str()))
        .filter(|path| seen.insert(*path))
        .map(|path| {
            // The first entry of a path, as the fold's pick reads it.
            let config_uuid = stored
                .iter()
                .find(|v| v.path == path)
                .and_then(|v| v.vault_uuid.as_deref());
            let (disposition, source_ledger) = disposition(path, config_uuid, &sandbox, scratch);
            PlannedVault {
                path: path.to_owned(),
                current: Some(path) == current,
                disposition,
                source_ledger,
            }
        })
        .collect();
    collapse_same_folders(&mut vaults);
    let mut by_store: BTreeMap<String, SharedStore> = BTreeMap::new();
    for vault in &vaults {
        if let Disposition::Import(id) = &vault.disposition {
            let dir = YStoreReader::store_dir(profile, &id.vault_id, Some(config));
            let store = dir
                .file_name()
                .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
            let group = by_store
                .entry(store.clone())
                .or_insert_with(|| SharedStore {
                    store,
                    vault_ids: Vec::new(),
                    paths: Vec::new(),
                });
            group.vault_ids.push(id.vault_id.clone());
            group.paths.push(vault.path.clone());
        }
    }
    let shared_stores: Vec<SharedStore> = by_store
        .into_values()
        .filter(|group| group.paths.len() > 1)
        .collect();
    for vault in &mut vaults {
        if shared_stores.iter().any(|g| g.paths.contains(&vault.path)) {
            vault.disposition = Disposition::Deferred(DeferReason::SharedStore);
            vault.source_ledger = None;
        }
    }
    VaultPlan {
        vaults,
        duplicate_entries: stored.len() - distinct.len(),
        unreadable_entries,
        shared_stores,
    }
}

fn disposition(
    path: &str,
    config_uuid: Option<&str>,
    sandbox: &Sandbox,
    scratch: &Scratch,
) -> (Disposition, Option<i64>) {
    if sandbox.is(path) {
        return (Disposition::Sandbox, None);
    }
    let dir = Path::new(path);
    if !fs::metadata(dir).is_ok_and(|m| m.is_dir()) {
        return (Disposition::Deferred(DeferReason::FolderMissing), None);
    }
    match read_vault_evidence(dir, scratch.root()) {
        Ok(None) => (Disposition::Deferred(DeferReason::DataDbMissing), None),
        Ok(Some(evidence)) => (
            Disposition::Import(VaultId::resolve(evidence.vault_id.as_deref(), config_uuid)),
            evidence.ledger,
        ),
        Err(error @ ImportError::Sqlite(_)) => (Disposition::Unreadable(error), None),
        Err(error) => {
            tracing::warn!(
                scope = "electron_import",
                error = %error,
                "vault data.db cannot be reached; the vault is imported when it is first opened"
            );
            (Disposition::Deferred(DeferReason::DataDbUnreachable), None)
        }
    }
}

/// Marks every importable entry whose folder an earlier importable entry names
/// [`Disposition::SameFolder`]. Folders compare by identity, not by path string: the volume
/// decides whether case or normalisation tell two names apart.
fn collapse_same_folders(vaults: &mut [PlannedVault]) {
    let mut seen: Vec<(FolderId, String)> = Vec::new();
    for vault in vaults.iter_mut() {
        if !matches!(vault.disposition, Disposition::Import(_)) {
            continue;
        }
        let Some(id) = folder_id(Path::new(&vault.path)) else {
            continue;
        };
        match seen.iter().find(|(seen_id, _)| *seen_id == id) {
            Some((_, first)) => {
                vault.disposition = Disposition::SameFolder(first.clone());
                vault.source_ledger = None;
            }
            None => seen.push((id, vault.path.clone())),
        }
    }
}

#[cfg(unix)]
type FolderId = (u64, u64);
#[cfg(not(unix))]
type FolderId = PathBuf;

/// Device and inode on Unix; elsewhere the resolved path, which Windows returns in the
/// volume's own case.
#[cfg(unix)]
fn folder_id(dir: &Path) -> Option<FolderId> {
    use std::os::unix::fs::MetadataExt;
    fs::metadata(dir).ok().map(|m| (m.dev(), m.ino()))
}

#[cfg(not(unix))]
fn folder_id(dir: &Path) -> Option<FolderId> {
    fs::canonicalize(dir).ok()
}

/// Electron's sandbox vault rule, shared by the app-state phase's config merge (Step 37b) and
/// the plan: `path` is `<profile>/Sandbox`, its parent compared as written and resolved (the
/// config may name the profile through the legacy `@memry/desktop` link). Only the parent of a
/// path named `Sandbox` is resolved, so a vault with any other name is never touched and a
/// vault elsewhere in the profile directory is still imported, as Electron keeps it.
pub(crate) struct Sandbox {
    profile_dir: PathBuf,
    resolved: Option<PathBuf>,
}

impl Sandbox {
    pub(crate) fn new(profile_dir: &Path) -> Self {
        Self {
            profile_dir: profile_dir.to_owned(),
            resolved: fs::canonicalize(profile_dir).ok(),
        }
    }

    pub(crate) fn is(&self, path: &str) -> bool {
        let path = Path::new(path);
        let Some(parent) = path
            .parent()
            .filter(|_| path.file_name() == Some(OsStr::new(SANDBOX_DIR)))
        else {
            return false;
        };
        parent == self.profile_dir
            || self
                .resolved
                .as_deref()
                .is_some_and(|dir| fs::canonicalize(parent).is_ok_and(|p| p == dir))
    }
}

/// One vault ready for Step 36's `stage_vault_import`.
#[derive(Debug)]
pub struct PreparedVault {
    pub dir: PathBuf,
    pub id: VaultId,
    /// The vault tree before the replay: check 7 compares the tree after install with it.
    pub tree_before: VaultTree,
    pub replay: Replay,
    /// Journal entries of a kind this build does not know; the journal is the profile's, so
    /// every vault reports the same count.
    pub journal_unknown: usize,
    /// `docs` is `VaultImportInput::docs`; `owed_compactions` joins `extra_owed_docs`.
    pub fold: YStoreFold,
}

/// Digests the vault, replays the journal into it, then folds its Yjs store. `path` is the
/// planned vault's config path, `id` its [`Disposition::Import`] id.
pub fn prepare_vault(
    profile: &ElectronProfile,
    config: Option<&ElectronConfig>,
    path: &str,
    id: &VaultId,
    journal: Option<&BulkApplyJournal>,
    scratch: &Scratch,
) -> Result<PreparedVault, ImportError> {
    let dir = PathBuf::from(path);
    let tree_before = VaultTree::read(&dir)?;
    let replay = journal.map(|j| replay(j, &dir)).unwrap_or_default();
    let fold = fold_vault_store(profile, path, &id.vault_id, config, scratch)?;
    Ok(PreparedVault {
        dir,
        id: id.clone(),
        tree_before,
        replay,
        journal_unknown: journal.map_or(0, |j| j.unknown.len()),
        fold,
    })
}

impl PreparedVault {
    /// What check 7 lets differ: the files the replay wrote or deleted and the canvas library,
    /// and as folders only, the folders above them and above a write that failed (the writer
    /// creates missing folders before it writes).
    pub fn expected_changes(&self) -> ExpectedChanges {
        let rel = |path: &Path| path.strip_prefix(&self.dir).ok().map(tree::key);
        let files: BTreeSet<String> = self
            .replay
            .written
            .iter()
            .chain(&self.replay.deleted)
            .filter_map(|p| rel(p))
            .chain([CANVAS_LIBRARY.to_owned()])
            .collect();
        let failed = self
            .replay
            .skipped
            .iter()
            .filter(|s| matches!(s.reason, EntrySkip::WriteFailed(_)))
            .filter_map(|s| rel(Path::new(&s.path)));
        let mut folders = BTreeSet::new();
        for file in files.iter().cloned().chain(failed) {
            let mut at = file.as_str();
            while let Some((parent, _)) = at.rsplit_once('/') {
                folders.insert(parent.to_owned());
                at = parent;
            }
        }
        ExpectedChanges { files, folders }
    }

    /// Verification check 7 after install: every path of the vault (`.memry/` aside) that
    /// differs from [`Self::tree_before`] and is not an [`Self::expected_changes`] change.
    pub fn unexpected_changes(&self) -> Result<Vec<String>, ImportError> {
        let after = VaultTree::read(&self.dir)?;
        Ok(after.changed_since(&self.tree_before, &self.expected_changes()))
    }

    pub fn report(&self) -> VaultPrepReport {
        report::of(self)
    }
}

#[cfg(test)]
mod tests;
