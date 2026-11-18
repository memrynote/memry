//! `electron-import-report.json`: what the first-launch migration carried, counted. It holds no
//! secret and no note text. Paths are the vault folders the config names and vault-relative
//! paths; config keys, check and step names otherwise.
//!
//! The file is a format this and later builds read back (a deferred vault adds its section to
//! it), so it is versioned and every field is additive: a field this build does not know, at
//! any level, is kept in that struct's `extra` and written back unchanged.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::ImportError;

pub const REPORT_FILE: &str = "electron-import-report.json";
pub const REPORT_VERSION: u64 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationReport {
    pub version: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_state: Option<AppStateReport>,
    /// The secrets phase's outcome; set once it finished, so a resumed run skips it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secrets: Option<Value>,
    /// Every vault of the plan, in plan order (`currentVault` first).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub vaults: Vec<VaultSection>,
    /// Why the last run stopped; `None` once a run finished.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<Failure>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// One vault of the plan. `prep` and `stage` are the 37e1 and Step 36 report sections.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSection {
    /// As the Electron config records it.
    pub path: String,
    pub status: VaultStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vault_id: Option<String>,
    /// The CRDT store directory name under `crdt-stores/`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub store: Option<String>,
    /// The other vaults of a shared-store group, or the entry a same-folder one repeats.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shared_with: Vec<String>,
    /// The error of an unreadable vault.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prep: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub checks_passed: Vec<u8>,
    /// Checks not run, by number, with the reason.
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub checks_not_run: Map<String, Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl VaultSection {
    pub fn new(path: &str, status: VaultStatus) -> Self {
        Self {
            path: path.to_owned(),
            status,
            reason: None,
            vault_id: None,
            store: None,
            shared_with: Vec::new(),
            detail: None,
            prep: None,
            stage: None,
            checks_passed: Vec::new(),
            checks_not_run: Map::new(),
            extra: Map::new(),
        }
    }
}

/// Where a vault stands. `Prepared` and `Staged` are a run's progress, read by the next run
/// after a crash; the rest are final. A status a later build writes reads as `Unknown`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VaultStatus {
    Prepared,
    Staged,
    Imported,
    /// `core/data.db` carried the import marker before this run reached the vault.
    AlreadyImported,
    /// The vault was opened natively first; Electron's files stay as they are.
    NativeFirst,
    Sandbox,
    SameFolder,
    /// Imported when the vault is first opened (`migrate_vault`), except a shared store.
    Deferred,
    /// The vault's `data.db` reads wrong; opening it fails until it reads.
    Unreadable,
    /// Opened with no Electron `data.db` beside it: nothing to import.
    NoData,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    /// The failing check or error kind, as telemetry's `errorCode` names it.
    pub check: String,
    /// The error panel's message.
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vault: Option<String>,
}

impl Default for VerificationReport {
    fn default() -> Self {
        Self {
            version: REPORT_VERSION,
            app_state: None,
            secrets: None,
            vaults: Vec::new(),
            failure: None,
            extra: Map::new(),
        }
    }
}

impl VerificationReport {
    /// A report of another version is refused, not guessed at.
    pub fn parse(bytes: &[u8]) -> Result<Self, ImportError> {
        let report: Self =
            serde_json::from_slice(bytes).map_err(|_| ImportError::parse(REPORT_FILE, 0))?;
        if report.version != REPORT_VERSION {
            return Err(ImportError::UnsupportedVersion {
                what: REPORT_FILE,
                found: report.version.to_string(),
            });
        }
        Ok(report)
    }
}

/// The app-state phase: config, telemetry flag, localStorage, dictionary, models.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppStateReport {
    /// `None` when the profile has no `memry-config.json`.
    pub config: Option<ConfigReport>,
    pub telemetry: TelemetryReport,
    /// `None` when the profile has no localStorage store.
    pub local_storage: Option<LocalStorageReport>,
    /// `None` when the profile has no custom dictionary.
    pub dictionary: Option<DictionaryReport>,
    pub models: CopyReport,
    pub ocr_languages: CopyReport,
    /// Fields of a later build, kept as they are.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConfigReport {
    /// Top-level keys written from the Electron config.
    pub carried_keys: Vec<String>,
    /// Keys not carried on purpose (`crdtStore`).
    pub dropped_keys: Vec<String>,
    /// Keys the Tauri config already held with a different value, now Electron's.
    pub replaced_keys: Vec<String>,
    pub vaults_carried: usize,
    /// Entries already in the Tauri list (same path), kept as they were.
    pub vaults_already_present: usize,
    /// Electron's sandbox vault (`<userData>/Sandbox`), never carried.
    pub sandbox_vaults: usize,
    /// `vaults` entries Electron's own reader would skip (no string `path`), carried as is.
    pub vault_entries_without_path: usize,
    /// Fields of a later build, kept as they are.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TelemetryReport {
    pub found: bool,
    /// The file exists but is not a JSON object; Electron reads it as empty too.
    pub unreadable: bool,
    pub install_id_carried: bool,
    /// Opt-out flags (`enabled`, `autoSendDiagnostics` set to false) carried.
    pub opt_outs_carried: usize,
    /// Fields of a later build, kept as they are.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LocalStorageReport {
    pub entries: usize,
    pub skipped: usize,
    pub torn_files: usize,
    /// The renderer already applied an earlier copy; the file was left as it is.
    pub already_applied: bool,
    /// Fields of a later build, kept as they are.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DictionaryReport {
    pub words: usize,
    /// False when both the file and its backup fail Chromium's checksum: Chromium drops those
    /// words, so they are not carried either.
    pub checksum_ok: bool,
    pub from_backup: bool,
    /// The shell already applied an earlier copy; the pending-words file was left as it is.
    pub already_applied: bool,
    /// Fields of a later build, kept as they are.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CopyReport {
    pub files: usize,
    pub bytes: u64,
    pub copied: usize,
    /// The Tauri side already held a byte-equal file.
    pub already_present: usize,
    /// The Tauri side held a different file at that path; it was kept.
    pub kept_existing: usize,
    /// Symlinks and other non-regular entries, never followed or copied.
    pub skipped_non_regular: usize,
    /// Fields of a later build, kept as they are.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}
