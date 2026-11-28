//! `electron-import.json`, written last by a finished first-launch run: with it present the run
//! never repeats, and `migrate_vault` reads it alone to learn what became of a vault.
//!
//! A format this and later builds read: `{version: 1, completedAt, electronProfile, vaults:
//! [{path, vaultUuid, status, ...}], legacyStoreReadBy?}`. Every field is additive and a field this build does not
//! know is written back unchanged.

use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::electron_import::ImportError;
use crate::electron_import::report::VaultStatus;
use crate::vault::fs_atomic::atomic_write;

pub const MARKER_FILE: &str = "electron-import.json";
pub const MARKER_VERSION: u64 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub version: u64,
    pub completed_at: i64,
    pub electron_profile: String,
    pub vaults: Vec<MarkerVault>,
    /// The vault uuid whose import read the unclaimed legacy `crdt-store/`, which Electron gives
    /// to one vault per profile, keyed by uuid as Electron's `legacyStoreClaimedBy` is. Written
    /// once, before a deferred import reads it, so a crash or a rerun never folds it into a second
    /// vault, and the vault reads it at any path. Electron's own claim wins.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy_store_read_by: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkerVault {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vault_uuid: Option<String>,
    pub status: VaultStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The CRDT store directory the vault was imported from: a deferred vault resolving to it
    /// later is refused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub store: Option<String>,
    /// sha256 of the Electron `data.db` and its WAL when imported, hex. A later launch that finds
    /// another one learns the previous app wrote the vault since (Kaan Q2: the notice is 37f's).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shared_with: Vec<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Marker {
    /// `Ok(None)` when there is no marker. A marker of another version is refused, not guessed
    /// at: no vault opens until a build that reads it runs.
    pub fn read(data_dir: &Path) -> Result<Option<Self>, ImportError> {
        let path = data_dir.join(MARKER_FILE);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(ImportError::io(&path, e)),
        };
        let marker: Self =
            serde_json::from_slice(&bytes).map_err(|_| ImportError::parse(MARKER_FILE, 0))?;
        if marker.version != MARKER_VERSION {
            return Err(ImportError::UnsupportedVersion {
                what: MARKER_FILE,
                found: marker.version.to_string(),
            });
        }
        Ok(Some(marker))
    }

    /// The legacy claim is write-once and `IMPORT_LOCK` is process-local: a process writing a
    /// marker it read before another process recorded the claim keeps that claim.
    pub fn write(&self, data_dir: &Path) -> Result<(), ImportError> {
        let path = data_dir.join(MARKER_FILE);
        if self.legacy_store_read_by.is_none()
            && let Some(Self {
                legacy_store_read_by: Some(claim),
                ..
            }) = Self::read(data_dir)?
        {
            let mut kept = self.clone();
            kept.legacy_store_read_by = Some(claim);
            return write_json(&path, &kept);
        }
        write_json(&path, self)
    }

    pub fn vault_mut(&mut self, path: &str) -> Option<&mut MarkerVault> {
        self.vaults.iter_mut().find(|v| v.path == path)
    }
}

/// Atomic: a temp file renamed over the target, so a reader sees the old file or the new one.
pub(super) fn write_json(path: &Path, value: &impl Serialize) -> Result<(), ImportError> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| ImportError::parse("report", 0))?;
    atomic_write(path, &bytes).map_err(|e| ImportError::io(path, e.source))
}
