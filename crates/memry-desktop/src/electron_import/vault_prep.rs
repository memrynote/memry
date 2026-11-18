//! The vault phase's preparation (Step 37e1, #3554), before Step 36 (#3553) stages a vault:
//! which of the Electron config's vaults are imported and under which ids, then per vault a
//! digest of the vault tree (the baseline of verification check 7), the bulk-apply journal
//! replay and the Yjs fold, in that order. A [`PreparedVault`] carries what
//! `stage_vault_import` takes from this step (`vault_id`, `docs`, `extra_owed_docs`) and the
//! vault's report section ([`report`]).
//!
//! The caller holds the Electron profile lock ([`super::ProfileLock::probe`]) for the whole
//! phase: the replay writes note files into the vault, as Electron's next launch would.

pub mod report;
pub mod tree;

use std::collections::{BTreeSet, HashSet};
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::journal_replay::{BulkApplyJournal, Replay, replay};
use super::ystore_import::{YStoreFold, fold_vault_store};
use super::{ElectronConfig, ElectronProfile, ImportError, Scratch, read_vault_evidence};
pub use report::VaultPrepReport;
pub use tree::VaultTree;

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
}

#[derive(Debug)]
pub struct PlannedVault {
    /// As the config records it. Paths compare as exact strings, as Electron compares them.
    pub path: String,
    pub current: bool,
    pub disposition: Disposition,
}

#[derive(Debug)]
pub enum Disposition {
    /// `<profile>/Sandbox`: never imported. Step 32 (#3549) regenerates it, and a core folder
    /// inside it would write into Electron's userData.
    Sandbox,
    /// Imported by `migrate_vault` when the session first opens it.
    Deferred(DeferReason),
    /// The vault has a `data.db` whose id cannot be read: not imported. The error names the
    /// row; the Electron files stay as they are.
    Unreadable(ImportError),
    Import(VaultIds),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DeferReason {
    /// The folder is missing or cannot be reached (an unmounted drive, a denied folder).
    FolderMissing,
    DataDbMissing,
}

/// The two ids a vault is imported under, resolved once per vault through one reader
/// ([`read_vault_evidence`]), which the fold's legacy store pick also reads the other vaults
/// with (`fold_vault_store`'s caller contract).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultIds {
    /// The core vault id, Step 36's `VaultImportInput::vault_id`: the `vault_metadata`
    /// singleton's uuid (`agent/storage/vault-id.ts:39-48`), else the config `vaultUuid`, else
    /// minted.
    pub vault_id: String,
    /// The uuid Electron names the vault's CRDT store by: the config `vaultUuid`, else the
    /// singleton's uuid, else the same minted uuid.
    pub store_uuid: String,
    /// Neither the config nor `data.db` names the vault: a fresh v4 uuid, as Electron's
    /// `getOrCreateVaultUuid` mints one (`vault-id.ts:50`).
    pub minted: bool,
}

impl VaultIds {
    fn resolve(config_uuid: Option<&str>, singleton: Option<String>) -> Self {
        let (vault_id, store_uuid, minted) = match (config_uuid, singleton) {
            (Some(config), Some(singleton)) => (singleton, config.to_owned(), false),
            (Some(config), None) => (config.to_owned(), config.to_owned(), false),
            (None, Some(singleton)) => (singleton.clone(), singleton, false),
            (None, None) => {
                let uuid = uuid::Uuid::new_v4().to_string();
                (uuid.clone(), uuid, true)
            }
        };
        Self {
            vault_id,
            store_uuid,
            minted,
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
    let sandbox = Sandbox {
        profile_dir: &profile.dir,
        resolved: fs::canonicalize(&profile.dir).ok(),
    };
    let mut seen = HashSet::new();
    let vaults = current
        .into_iter()
        .chain(stored.iter().map(|v| v.path.as_str()))
        .filter(|path| seen.insert(*path))
        .map(|path| {
            // The first entry of a path, as the fold's pick reads it.
            let config_uuid = stored
                .iter()
                .find(|v| v.path == path)
                .and_then(|v| v.vault_uuid.as_deref());
            PlannedVault {
                path: path.to_owned(),
                current: Some(path) == current,
                disposition: disposition(path, config_uuid, &sandbox, scratch),
            }
        })
        .collect();
    VaultPlan {
        vaults,
        duplicate_entries: stored.len() - distinct.len(),
        unreadable_entries,
    }
}

fn disposition(
    path: &str,
    config_uuid: Option<&str>,
    sandbox: &Sandbox<'_>,
    scratch: &Scratch,
) -> Disposition {
    if sandbox.is(path) {
        return Disposition::Sandbox;
    }
    let dir = Path::new(path);
    if !fs::metadata(dir).is_ok_and(|m| m.is_dir()) {
        return Disposition::Deferred(DeferReason::FolderMissing);
    }
    match read_vault_evidence(dir, scratch.root()) {
        Ok(None) => Disposition::Deferred(DeferReason::DataDbMissing),
        Ok(Some(evidence)) => {
            Disposition::Import(VaultIds::resolve(config_uuid, evidence.vault_id))
        }
        Err(error) => Disposition::Unreadable(error),
    }
}

/// The rule of the app-state phase's config merge (Step 37b): `path` is `<profile>/Sandbox`,
/// its parent compared as written and resolved, so a vault elsewhere in the profile directory
/// is still imported, as Electron keeps it.
struct Sandbox<'a> {
    profile_dir: &'a Path,
    resolved: Option<PathBuf>,
}

impl Sandbox<'_> {
    fn is(&self, path: &str) -> bool {
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
    pub ids: VaultIds,
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
/// planned vault's config path, `ids` its [`Disposition::Import`] ids.
pub fn prepare_vault(
    profile: &ElectronProfile,
    config: Option<&ElectronConfig>,
    path: &str,
    ids: &VaultIds,
    journal: Option<&BulkApplyJournal>,
    scratch: &Scratch,
) -> Result<PreparedVault, ImportError> {
    let dir = PathBuf::from(path);
    let tree_before = VaultTree::read(&dir)?;
    let replay = journal.map(|j| replay(j, &dir)).unwrap_or_default();
    let fold = fold_vault_store(profile, path, &ids.store_uuid, config, scratch)?;
    Ok(PreparedVault {
        dir,
        ids: ids.clone(),
        tree_before,
        replay,
        journal_unknown: journal.map_or(0, |j| j.unknown.len()),
        fold,
    })
}

impl PreparedVault {
    /// The vault-relative paths check 7 lets differ: what the replay wrote or deleted and the
    /// canvas library, with the folders above them (the replay creates missing ones).
    pub fn expected_changes(&self) -> BTreeSet<String> {
        let mut out = BTreeSet::new();
        let paths = self.replay.written.iter().chain(&self.replay.deleted);
        for rel in paths
            .filter_map(|p| p.strip_prefix(&self.dir).ok())
            .map(tree::key)
            .chain([CANVAS_LIBRARY.to_owned()])
        {
            let mut at = rel.as_str();
            while let Some((parent, _)) = at.rsplit_once('/') {
                out.insert(parent.to_owned());
                at = parent;
            }
            out.insert(rel);
        }
        out
    }

    /// Verification check 7 after install: every path of the vault (`.memry/` aside) that
    /// differs from [`Self::tree_before`] and is not an [`Self::expected_changes`] path.
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
