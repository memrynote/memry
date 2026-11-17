//! The app-state phase of the first-launch migration: the Electron `memry-config.json`, the
//! telemetry install id and opt-outs, the renderer's localStorage, the custom dictionary, and the
//! downloaded embedding models and OCR languages, carried into the Tauri data dir.
//!
//! Every input is read and checked before the first write, so a corrupt or partial profile
//! fails with nothing written. Each write is whole (temp file and rename) and the phase is a pure
//! function of the untouched Electron data, so a crash repeats it from the start with the same
//! result. The Electron profile is only read.

mod copy;

use std::fs;
use std::path::Path;

use serde_json::{Map, Value, json};

use super::ImportError;
use super::config::ElectronConfig;
use super::dictionary::CustomDictionary;
use super::local_storage::{LocalStorageSnapshot, PACKAGED_ORIGIN};
use super::profile::ElectronProfile;
use super::progress::{Phase, ProgressSink, ProgressUpdate};
use super::report::{
    AppStateReport, ConfigReport, DictionaryReport, LocalStorageReport, TelemetryReport,
};
use super::scratch::Scratch;
use crate::registry::AppConfig;
use crate::shell::spell::{SpellBackend, add_words};
use crate::telemetry::TelemetryConfig;
use crate::telemetry::config::FILE_NAME as TELEMETRY_FILE;
use crate::vault::fs_atomic::atomic_write;

/// The renderer's localStorage keys, waiting for the first webview to apply them.
pub const LOCAL_STORAGE_FILE: &str = "electron-localstorage.json";
const LOCAL_STORAGE_VERSION: u64 = 1;
/// `crdtStore` names Electron's CRDT store directories, which the Tauri build does not have.
const DROPPED_CONFIG_KEYS: [&str; 1] = ["crdtStore"];
/// Copied under the same relative path. `models/voice-transcription` is not: its marker never
/// counts as downloaded in the Tauri build.
const MODELS_DIR: &str = "models/transformers";
const OCR_DIR: &str = "ocr-languages";
/// Telemetry opt-outs: only an explicit `false` is carried over a Tauri value.
const TELEMETRY_FLAGS: [&str; 2] = ["enabled", "autoSendDiagnostics"];
const STEPS: [&str; 5] = [
    "config",
    "telemetry",
    "local-storage",
    "dictionary",
    "models",
];

pub struct AppStateInput<'a> {
    pub profile: &'a ElectronProfile,
    pub scratch: &'a Scratch,
    pub tauri_data_dir: &'a Path,
    /// The running app's own config owner, so its cache sees the merge.
    pub config: &'a AppConfig,
    /// `None` when no dictionary loaded; the words are then counted, not added.
    pub spell: Option<&'a dyn SpellBackend>,
    pub progress: &'a dyn ProgressSink,
}

pub fn import_app_state(input: &AppStateInput<'_>) -> Result<AppStateReport, ImportError> {
    let profile = input.profile;
    let data_dir = input.tauri_data_dir;
    let electron_config = ElectronConfig::read(profile)?;
    let (telemetry, mut telemetry_report) = read_telemetry(profile)?;
    let local_storage = LocalStorageSnapshot::read(profile, PACKAGED_ORIGIN, input.scratch)?;
    let dictionary = CustomDictionary::read(profile)?;
    let models = copy::plan(&profile.dir.join(MODELS_DIR))?;
    let ocr = copy::plan(&profile.dir.join(OCR_DIR))?;

    let step = |index: usize| {
        input.progress.update(ProgressUpdate {
            phase: Phase::AppState,
            current: index as u32 + 1,
            total: STEPS.len() as u32,
            label: STEPS[index].to_owned(),
        });
    };
    step(0);
    let config = electron_config
        .map(|electron| merge_config(input.config, &electron, &profile.dir))
        .transpose()?;
    step(1);
    carry_telemetry(data_dir, &telemetry, &mut telemetry_report)?;
    step(2);
    let local_storage = local_storage
        .map(|snapshot| write_local_storage(data_dir, &snapshot))
        .transpose()?;
    step(3);
    let dictionary = dictionary.map(|dictionary| DictionaryReport {
        words: dictionary.words.len(),
        added: if dictionary.checksum_ok {
            add_words(input.spell, &dictionary.words)
        } else {
            0
        },
        checksum_ok: dictionary.checksum_ok,
        from_backup: dictionary.from_backup,
    });
    step(4);
    let models = copy::run(&models, &data_dir.join(MODELS_DIR))?;
    let ocr_languages = copy::run(&ocr, &data_dir.join(OCR_DIR))?;
    Ok(AppStateReport {
        config,
        telemetry: telemetry_report,
        local_storage,
        dictionary,
        models,
        ocr_languages,
    })
}

/// Key by key over the Tauri config: Electron's value wins (it is the user's state on first
/// launch), keys only Electron knows survive, `crdtStore` is dropped. `vaults` is a union by
/// path that keeps every Tauri entry, and a vault inside the profile directory (the sandbox
/// vault) is never carried, nor is `currentVault` pointing at one: opening it would create
/// `.memry/core` inside Electron's userData.
fn merge_config(
    config: &AppConfig,
    electron: &ElectronConfig,
    profile_dir: &Path,
) -> Result<ConfigReport, ImportError> {
    config.update(|map| -> Result<ConfigReport, ImportError> {
        let mut report = ConfigReport::default();
        for (key, value) in &electron.raw {
            let next = match key.as_str() {
                k if DROPPED_CONFIG_KEYS.contains(&k) => None,
                "vaults" => merge_vaults(map.get("vaults"), value, profile_dir, &mut report),
                "currentVault" if value.as_str().is_some_and(|p| inside(p, profile_dir)) => None,
                _ => Some(value.clone()),
            };
            let Some(next) = next else {
                report.dropped_keys.push(key.clone());
                continue;
            };
            if map.get(key).is_some_and(|old| *old != next) {
                report.replaced_keys.push(key.clone());
            }
            map.insert(key.clone(), next);
            report.carried_keys.push(key.clone());
        }
        Ok(report)
    })
}

/// `None` when Electron's `vaults` is not a list: Electron's own reader skips it too.
fn merge_vaults(
    tauri: Option<&Value>,
    electron: &Value,
    profile_dir: &Path,
    report: &mut ConfigReport,
) -> Option<Value> {
    let electron = electron.as_array()?;
    let mut list = tauri.and_then(Value::as_array).cloned().unwrap_or_default();
    for entry in electron {
        let Some(path) = entry.get("path").and_then(Value::as_str) else {
            report.vault_entries_without_path += 1;
            if !list.contains(entry) {
                list.push(entry.clone());
            }
            continue;
        };
        if inside(path, profile_dir) {
            report.vaults_inside_profile += 1;
        } else if list
            .iter()
            .any(|v| v.get("path").and_then(Value::as_str) == Some(path))
        {
            report.vaults_already_present += 1;
        } else {
            list.push(entry.clone());
            report.vaults_carried += 1;
        }
    }
    Some(Value::Array(list))
}

/// Whether `path` lies in the profile directory, compared as written and, when both exist, after
/// resolving links (the profile may be reached through the legacy `@memry/desktop` link).
fn inside(path: &str, profile_dir: &Path) -> bool {
    let path = Path::new(path);
    if path.starts_with(profile_dir) {
        return true;
    }
    match (fs::canonicalize(path), fs::canonicalize(profile_dir)) {
        (Ok(path), Ok(dir)) => path.starts_with(dir),
        _ => false,
    }
}

/// Electron's `telemetry.json`. A file that is not a JSON object reads as empty, as
/// `readTelemetryConfig` does; a file that cannot be read fails, so an opt-out is never lost to
/// a transient error.
fn read_telemetry(
    profile: &ElectronProfile,
) -> Result<(Map<String, Value>, TelemetryReport), ImportError> {
    let path = profile.dir.join(TELEMETRY_FILE);
    let mut report = TelemetryReport::default();
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((Map::new(), report)),
        Err(e) => return Err(ImportError::io(path, e)),
    };
    report.found = true;
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Object(map)) => Ok((map, report)),
        _ => {
            report.unreadable = true;
            Ok((Map::new(), report))
        }
    }
}

/// The install id (when it is a UUID, which the Tauri reader requires) replaces the one this
/// launch may have minted; an opt-out is carried, an opt-in only where Tauri has no value.
fn carry_telemetry(
    data_dir: &Path,
    electron: &Map<String, Value>,
    report: &mut TelemetryReport,
) -> Result<(), ImportError> {
    let tauri = TelemetryConfig::new(data_dir);
    let current = tauri.read();
    let mut updates = Map::new();
    if let Some(id) = electron.get("installId").and_then(Value::as_str)
        && uuid::Uuid::parse_str(id).is_ok()
    {
        updates.insert("installId".into(), Value::String(id.to_owned()));
        report.install_id_carried = true;
    }
    for key in TELEMETRY_FLAGS {
        match electron.get(key).and_then(Value::as_bool) {
            Some(false) => {
                updates.insert(key.into(), Value::Bool(false));
                report.opt_outs_carried += 1;
            }
            Some(true) if !current.contains_key(key) => {
                updates.insert(key.into(), Value::Bool(true));
            }
            _ => {}
        }
    }
    if updates.is_empty() {
        return Ok(());
    }
    // `merge` logs a failed write and returns; the read-back turns that into an error.
    tauri.merge(updates.clone());
    let written = tauri.read();
    if updates.iter().any(|(k, v)| written.get(k) != Some(v)) {
        return Err(ImportError::ReadBack(TELEMETRY_FILE));
    }
    Ok(())
}

/// `{version, origin, pending, entries}`. A file whose `pending` is already false was applied by
/// the renderer and stays as it is, so a rerun never re-arms it.
fn write_local_storage(
    data_dir: &Path,
    snapshot: &LocalStorageSnapshot,
) -> Result<LocalStorageReport, ImportError> {
    let path = data_dir.join(LOCAL_STORAGE_FILE);
    let mut report = LocalStorageReport {
        entries: snapshot.entries.len(),
        skipped: snapshot.skipped,
        torn_files: snapshot.torn_tails.len(),
        already_applied: false,
    };
    let applied = fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|v| v.get("pending").and_then(Value::as_bool))
        == Some(false);
    if applied {
        report.already_applied = true;
        return Ok(report);
    }
    let body = json!({
        "version": LOCAL_STORAGE_VERSION,
        "origin": PACKAGED_ORIGIN,
        "pending": true,
        "entries": snapshot.entries,
    });
    atomic_write(&path, format!("{body:#}").as_bytes())
        .map_err(|e| ImportError::io(e.path, e.source))?;
    Ok(report)
}

#[cfg(test)]
mod tests;
