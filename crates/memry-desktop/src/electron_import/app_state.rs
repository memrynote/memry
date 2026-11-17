//! The app-state phase of the first-launch migration: the Electron `memry-config.json`, the
//! telemetry install id and opt-outs, the renderer's localStorage, the custom dictionary, and the
//! downloaded embedding models and OCR languages, carried into the Tauri data dir.
//!
//! Every input is read and checked before the first write, so a corrupt or partial profile
//! fails with nothing written. The model and OCR copies run first: a full disk or I/O error
//! there, the likeliest write failure, leaves only verified files under those folders and no
//! state file. Each write is whole (temp file and rename) and the phase is a pure function of the
//! untouched Electron data, so a failure or a crash repeats it from the start with the same
//! result. The Electron profile is only read.

mod copy;

use std::ffi::OsStr;
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
use crate::shell::spell::{SpellBackend, add_word, normalize_word};
use crate::telemetry::TelemetryConfig;
use crate::telemetry::config::FILE_NAME as TELEMETRY_FILE;
use crate::vault::fs_atomic::atomic_write;

/// The renderer's localStorage keys, waiting for the first webview to apply them.
pub const LOCAL_STORAGE_FILE: &str = "electron-localstorage.json";
const LOCAL_STORAGE_VERSION: u64 = 1;
/// The custom dictionary words, waiting for the spell backend to load: a backend may take
/// seconds per word (Windows waits up to five for COM), so the phase never calls it.
/// `{version, pending, words}`; [`apply_pending_words`] adds them once the backend is ready.
pub const DICTIONARY_FILE: &str = "electron-dictionary.json";
const DICTIONARY_VERSION: u64 = 1;
/// Electron's sandbox vault, `<userData>/Sandbox` (`vault/sandbox.ts` `SANDBOX_FOLDER`).
const SANDBOX_DIR: &str = "Sandbox";
/// `crdtStore` names Electron's CRDT store directories, which the Tauri build does not have.
const DROPPED_CONFIG_KEYS: [&str; 1] = ["crdtStore"];
/// Copied under the same relative path. `models/voice-transcription` is not: its marker never
/// counts as downloaded in the Tauri build.
const MODELS_DIR: &str = "models/transformers";
const OCR_DIR: &str = "ocr-languages";
/// Telemetry opt-outs: only an explicit `false` is carried over a Tauri value.
const TELEMETRY_FLAGS: [&str; 2] = ["enabled", "autoSendDiagnostics"];
const STEPS: [&str; 5] = [
    "models",
    "telemetry",
    "local-storage",
    "dictionary",
    "config",
];

pub struct AppStateInput<'a> {
    pub profile: &'a ElectronProfile,
    pub scratch: &'a Scratch,
    pub tauri_data_dir: &'a Path,
    /// The running app's own config owner, so its cache sees the merge.
    pub config: &'a AppConfig,
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
    let models = copy::run(&models, &data_dir.join(MODELS_DIR))?;
    let ocr_languages = copy::run(&ocr, &data_dir.join(OCR_DIR))?;
    step(1);
    carry_telemetry(data_dir, &telemetry, &mut telemetry_report)?;
    step(2);
    let local_storage = local_storage
        .map(|snapshot| write_local_storage(data_dir, &snapshot))
        .transpose()?;
    step(3);
    let dictionary = dictionary
        .map(|dictionary| write_dictionary(data_dir, &dictionary))
        .transpose()?;
    step(4);
    let config = electron_config
        .map(|electron| merge_config(input.config, &electron, &profile.dir))
        .transpose()?;
    Ok(AppStateReport {
        config,
        telemetry: telemetry_report,
        local_storage,
        dictionary,
        models,
        ocr_languages,
        extra: Map::new(),
    })
}

/// Key by key over the Tauri config: Electron's value wins (it is the user's state on first
/// launch), keys only Electron knows survive, `crdtStore` is dropped. `vaults` is a union by
/// path that keeps every Tauri entry, and the sandbox vault is never carried, nor is
/// `currentVault` pointing at it: opening it would create `.memry/core` inside Electron's
/// userData.
fn merge_config(
    config: &AppConfig,
    electron: &ElectronConfig,
    profile_dir: &Path,
) -> Result<ConfigReport, ImportError> {
    let sandbox = Sandbox {
        profile_dir,
        resolved: fs::canonicalize(profile_dir).ok(),
    };
    config.update(|map| -> Result<ConfigReport, ImportError> {
        let mut report = ConfigReport::default();
        for (key, value) in &electron.raw {
            let next = match key.as_str() {
                k if DROPPED_CONFIG_KEYS.contains(&k) => None,
                "vaults" => merge_vaults(map.get("vaults"), value, &sandbox, &mut report),
                "currentVault" if value.as_str().is_some_and(|p| sandbox.is(p)) => None,
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
    sandbox: &Sandbox<'_>,
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
        if sandbox.is(path) {
            report.sandbox_vaults += 1;
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

struct Sandbox<'a> {
    profile_dir: &'a Path,
    /// The profile directory with links resolved, once per merge.
    resolved: Option<std::path::PathBuf>,
}

impl Sandbox<'_> {
    /// Whether `path` is `<profile>/Sandbox`, its parent compared as written and resolved (the
    /// config may name the profile through the legacy `@memry/desktop` link). Only a path named
    /// `Sandbox` is resolved, so other vaults, offline network ones included, are never touched
    /// and a vault elsewhere in the profile directory is carried, as Electron keeps it.
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

/// `{version, origin, pending, entries}`, applied by the first webview.
fn write_local_storage(
    data_dir: &Path,
    snapshot: &LocalStorageSnapshot,
) -> Result<LocalStorageReport, ImportError> {
    let body = json!({
        "version": LOCAL_STORAGE_VERSION,
        "origin": PACKAGED_ORIGIN,
        "pending": true,
        "entries": snapshot.entries,
    });
    Ok(LocalStorageReport {
        entries: snapshot.entries.len(),
        skipped: snapshot.skipped,
        torn_files: snapshot.torn_tails.len(),
        already_applied: !write_pending(&data_dir.join(LOCAL_STORAGE_FILE), &body)?,
        ..LocalStorageReport::default()
    })
}

/// Words whose file and backup both fail Chromium's checksum are counted and not carried, as
/// Chromium drops them.
fn write_dictionary(
    data_dir: &Path,
    dictionary: &CustomDictionary,
) -> Result<DictionaryReport, ImportError> {
    let mut report = DictionaryReport {
        words: dictionary.words.len(),
        checksum_ok: dictionary.checksum_ok,
        from_backup: dictionary.from_backup,
        ..DictionaryReport::default()
    };
    if dictionary.checksum_ok {
        let body = json!({
            "version": DICTIONARY_VERSION,
            "pending": true,
            "words": dictionary.words,
        });
        report.already_applied = !write_pending(&data_dir.join(DICTIONARY_FILE), &body)?;
    }
    Ok(report)
}

/// Writes a pending file unless one is there that is not `pending: true`: applied, or not ours
/// to read (unparseable, which a whole write never leaves, or of a newer shape). Such a file
/// stays as it is, so a rerun never applies it twice. False when it was left alone.
fn write_pending(path: &Path, body: &Value) -> Result<bool, ImportError> {
    match fs::read(path) {
        Ok(bytes) => {
            let pending = serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|v| v.get("pending").and_then(Value::as_bool));
            if pending != Some(true) {
                return Ok(false);
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(ImportError::io(path, e)),
    }
    atomic_write(path, format!("{body:#}").as_bytes())
        .map_err(|e| ImportError::io(e.path, e.source))?;
    Ok(true)
}

/// Adds the words [`DICTIONARY_FILE`] holds; the shell calls it once its backend is `ready()`
/// (a call before that would wait behind the load). Words the backend refuses stay pending for
/// the next call; words no backend can take (empty, too long) are dropped. Returns how many the
/// backend took.
pub fn apply_pending_words(
    data_dir: &Path,
    backend: &dyn SpellBackend,
) -> Result<u32, ImportError> {
    let path = data_dir.join(DICTIONARY_FILE);
    if !backend.ready() {
        return Ok(0);
    }
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(ImportError::io(path, e)),
    };
    let Ok(Value::Object(mut file)) = serde_json::from_slice::<Value>(&bytes) else {
        return Ok(0);
    };
    let words = match (file.get("pending"), file.get("words")) {
        (Some(Value::Bool(true)), Some(Value::Array(words))) => words.clone(),
        _ => return Ok(0),
    };
    let mut added = 0u32;
    let mut left = Vec::new();
    for word in words {
        let Some(text) = word.as_str().filter(|w| normalize_word(w).is_some()) else {
            continue;
        };
        if add_word(Some(backend), text) {
            added = added.saturating_add(1);
        } else {
            left.push(word);
        }
    }
    file.insert("pending".into(), Value::Bool(!left.is_empty()));
    file.insert("words".into(), Value::Array(left));
    atomic_write(&path, format!("{:#}", Value::Object(file)).as_bytes())
        .map_err(|e| ImportError::io(e.path, e.source))?;
    Ok(added)
}

#[cfg(test)]
mod tests;
