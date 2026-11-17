//! `electron-import-report.json`: what the first-launch migration carried, counted. It holds no
//! secret, no note text and no path of user content; config keys and step names only.
//!
//! The file is a format this and later builds read back (a deferred vault adds its section to
//! it), so it is versioned and every field is additive: a field this build does not know is
//! kept in [`VerificationReport::extra`] and written back unchanged.

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
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for VerificationReport {
    fn default() -> Self {
        Self {
            version: REPORT_VERSION,
            app_state: None,
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
    /// Vaults inside the Electron profile directory (the sandbox vault), never carried.
    pub vaults_inside_profile: usize,
    /// `vaults` entries Electron's own reader would skip (no string `path`), carried as is.
    pub vault_entries_without_path: usize,
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
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LocalStorageReport {
    pub entries: usize,
    pub skipped: usize,
    pub torn_files: usize,
    /// The renderer already applied an earlier copy; the file was left as it is.
    pub already_applied: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DictionaryReport {
    pub words: usize,
    pub added: u32,
    /// False when both the file and its backup fail Chromium's checksum: Chromium drops those
    /// words, so they are not carried either.
    pub checksum_ok: bool,
    pub from_backup: bool,
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
}
