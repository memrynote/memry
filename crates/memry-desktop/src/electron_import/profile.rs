//! Locating an installed Electron profile and deciding which app names to try for its secrets.
//!
//! Mirrors `apps/desktop/src/main/app-identity.ts` (`isProfileDir`, `applyMemrynoteIdentity`),
//! rewritten for read-only use: the Electron app moves directories and writes the pin, this code
//! only looks.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::ImportError;
use crate::launch_env::LaunchEnv;

/// Replaces the profile search with one directory (tests and the sandboxed live app).
pub const PROFILE_DIR_VAR: &str = "MEMRY_ELECTRON_PROFILE_DIR";
pub const MEMRYNOTE_APP_NAME: &str = "memrynote";
/// Byte-identical to `apps/desktop/package.json` `name`; Chromium derives its key names from it.
pub const LEGACY_APP_NAME: &str = "@memry/desktop";
/// userData directory name of one real macOS install of the release 2026.1025.1 (Chromium's
/// default product name). It names a directory only: that install's secrets decrypt under
/// `@memry/desktop`, and `Chromium Safe Storage` is the real Chromium browser's Keychain item,
/// which this reader never asks for.
const CHROMIUM_DIR_NAME: &str = "Chromium";
pub const SECRET_STORE_FILENAME: &str = "secure-secrets.json";
pub const IDENTITY_PIN_FILENAME: &str = "app-identity.json";
const CONFIG_FILENAME: &str = "memry-config.json";
const DICTIONARY_FILENAME: &str = "Custom Dictionary.txt";
const LOCAL_STATE_FILENAME: &str = "Local State";
const NON_PROFILE_ENTRIES: [&str; 3] = ["logs", ".DS_Store", IDENTITY_PIN_FILENAME];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostOs {
    MacOs,
    Windows,
    Linux,
}

impl HostOs {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::MacOs
        } else if cfg!(windows) {
            Self::Windows
        } else {
            Self::Linux
        }
    }
}

#[derive(Debug, Clone)]
pub struct ProfileEnv {
    pub app_data: PathBuf,
    pub override_dir: Option<PathBuf>,
    pub host: HostOs,
}

impl ProfileEnv {
    /// `None` only when the OS app-data root cannot be derived from `env` and no override is set.
    pub fn from_host(env: &LaunchEnv) -> Option<Self> {
        Self::from_env(env, HostOs::current())
    }

    fn from_env(env: &LaunchEnv, host: HostOs) -> Option<Self> {
        let non_empty = |key: &str| env.get(key).filter(|v| !v.is_empty()).map(PathBuf::from);
        let override_dir = non_empty(PROFILE_DIR_VAR);
        let app_data = match host {
            HostOs::MacOs => non_empty("HOME").map(|h| h.join("Library/Application Support")),
            HostOs::Windows => non_empty("APPDATA"),
            HostOs::Linux => non_empty("XDG_CONFIG_HOME")
                .or_else(|| non_empty("HOME").map(|h| h.join(".config"))),
        };
        match (app_data, override_dir) {
            (None, None) => None,
            (app_data, override_dir) => Some(Self {
                app_data: app_data.unwrap_or_default(),
                override_dir,
                host,
            }),
        }
    }
}

/// `app-identity.json`, the app name that produced the secret store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityPin {
    pub app_name: &'static str,
    pub flipped: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPin {
    #[serde(default)]
    version: Option<serde_json::Value>,
    app_name: String,
    #[serde(default)]
    flipped: Option<serde_json::Value>,
}

impl IdentityPin {
    /// An unreadable or unparseable pin, or one with an unknown app name, is no pin
    /// (`readPin`). A pin whose `version` is present and not 1 is a layout this reader does not
    /// know and is an error: guessing the app name from it could pick the wrong key.
    pub fn read(dir: &Path) -> Result<Option<Self>, ImportError> {
        let Ok(raw) = fs::read(dir.join(IDENTITY_PIN_FILENAME)) else {
            return Ok(None);
        };
        let Ok(raw) = serde_json::from_slice::<RawPin>(&raw) else {
            return Ok(None);
        };
        if raw.version.as_ref().is_some_and(|v| v != 1) {
            return Err(ImportError::UnsupportedVersion {
                what: IDENTITY_PIN_FILENAME,
                found: raw.version.map(|v| v.to_string()).unwrap_or_default(),
            });
        }
        let app_name = match raw.app_name.as_str() {
            LEGACY_APP_NAME => LEGACY_APP_NAME,
            MEMRYNOTE_APP_NAME => MEMRYNOTE_APP_NAME,
            _ => return Ok(None),
        };
        Ok(Some(Self {
            app_name,
            flipped: raw.flipped.is_some_and(|v| v == true),
        }))
    }
}

/// App names to try, most likely first. Both names are always listed on macOS and Linux (a wrong
/// name fails the plaintext probe and costs one lookup); Windows lists one, because DPAPI does not
/// depend on the name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppNameCandidates(pub Vec<&'static str>);

#[derive(Debug, Clone)]
pub struct ElectronProfile {
    pub dir: PathBuf,
    pub host: HostOs,
    pub pin: Option<IdentityPin>,
    pub app_names: AppNameCandidates,
    pub has_config: bool,
    pub has_secure_store: bool,
    pub has_local_state: bool,
    pub has_local_storage: bool,
    pub has_legacy_crdt_store: bool,
    pub has_custom_dictionary: bool,
    /// One directory per vault under `crdt-stores/`.
    pub crdt_store_dirs: Vec<PathBuf>,
    /// Other directories that also hold a profile (never chosen, never read). More than one
    /// means two installs left data behind. Step 37 must surface them to the user instead of
    /// guessing; `locate_profile` logs a warning with the paths.
    pub other_candidates: Vec<PathBuf>,
}

impl ElectronProfile {
    pub fn config_path(&self) -> PathBuf {
        self.dir.join(CONFIG_FILENAME)
    }
    pub fn secret_store_path(&self) -> PathBuf {
        self.dir.join(SECRET_STORE_FILENAME)
    }
    pub fn local_state_path(&self) -> PathBuf {
        self.dir.join(LOCAL_STATE_FILENAME)
    }
    pub fn local_storage_dir(&self) -> PathBuf {
        self.dir.join("Local Storage").join("leveldb")
    }
    pub fn legacy_crdt_store_dir(&self) -> PathBuf {
        self.dir.join("crdt-store")
    }
    pub fn crdt_store_root(&self) -> PathBuf {
        self.dir.join("crdt-stores")
    }
    pub fn dictionary_path(&self) -> PathBuf {
        self.dir.join(DICTIONARY_FILENAME)
    }
}

/// `lstat` says real directory; a symlink never counts.
fn is_real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_dir())
}

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
}

/// A directory with an entry other than `logs`, `.DS_Store` and the pin file. Windows and Linux
/// create `logs` inside userData at every start, so an existing directory is not a profile.
fn is_profile_dir(path: &Path) -> bool {
    if !is_real_dir(path) {
        return false;
    }
    let Ok(entries) = fs::read_dir(path) else {
        return false;
    };
    entries.filter_map(Result::ok).any(|e| {
        !NON_PROFILE_ENTRIES
            .iter()
            .any(|skip| e.file_name() == *skip)
    })
}

/// A candidate path as a profile directory: a real profile dir, or a symlink followed once to a
/// real profile dir. A dangling link or a link to a non-profile is `None`.
fn resolve_candidate(path: &Path) -> Option<PathBuf> {
    if is_profile_dir(path) {
        return Some(path.to_owned());
    }
    if !is_symlink(path) {
        return None;
    }
    let target = fs::read_link(path).ok()?;
    let target = path.parent().map_or(target.clone(), |p| p.join(&target));
    is_profile_dir(&target).then_some(target)
}

/// Whether the secret store holds at least one ciphertext. An unreadable or unparseable store
/// counts as loaded, as in `storeHasCiphertexts`: ambiguity keeps the legacy name first.
fn store_has_ciphertexts(dir: &Path) -> bool {
    let path = dir.join(SECRET_STORE_FILENAME);
    if !path.exists() {
        return false;
    }
    let Ok(raw) = fs::read(&path) else {
        return true;
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&raw) else {
        return true;
    };
    value
        .get("entries")
        .and_then(|e| e.as_object())
        .is_some_and(|services| {
            services
                .values()
                .any(|accounts| accounts.as_object().is_some_and(|a| !a.is_empty()))
        })
}

/// The decision table of `applyMemrynoteIdentity`, read-only. `born_at_new_path` is true for a
/// profile found at `<appData>/memrynote` with no compatibility symlink at the legacy path.
fn app_names(
    host: HostOs,
    pin: Option<&IdentityPin>,
    has_ciphertexts: bool,
    born_at_new_path: bool,
) -> AppNameCandidates {
    let both = |first: &'static str| {
        let second = if first == LEGACY_APP_NAME {
            MEMRYNOTE_APP_NAME
        } else {
            LEGACY_APP_NAME
        };
        AppNameCandidates(vec![first, second])
    };
    // Linux: a store keeps the legacy identity outright, before any pin is consulted.
    if host == HostOs::Linux && has_ciphertexts {
        return both(LEGACY_APP_NAME);
    }
    if let Some(pin) = pin {
        return both(pin.app_name);
    }
    if host == HostOs::Windows {
        return AppNameCandidates(vec![MEMRYNOTE_APP_NAME]);
    }
    if has_ciphertexts && !born_at_new_path {
        return both(LEGACY_APP_NAME);
    }
    both(MEMRYNOTE_APP_NAME)
}

/// Files only this app writes; a stray `Chromium` directory of another program has none.
fn has_memry_files(dir: &Path) -> bool {
    dir.join(CONFIG_FILENAME).is_file()
        || dir.join(SECRET_STORE_FILENAME).is_file()
        || is_real_dir(&dir.join("crdt-stores"))
}

/// The files whose loss the migration cannot undo: secret entries or CRDT stores.
fn has_data(dir: &Path) -> bool {
    store_has_ciphertexts(dir)
        || fs::read_dir(dir.join("crdt-stores")).is_ok_and(|mut entries| entries.next().is_some())
}

/// Newest modification time of the files the running app rewrites.
fn last_used(dir: &Path) -> Option<std::time::SystemTime> {
    [CONFIG_FILENAME, "session-marker.json"]
        .iter()
        .filter_map(|name| fs::metadata(dir.join(name)).and_then(|m| m.modified()).ok())
        .max()
}

/// Finds the profile. `Ok(None)` when none exists (a fresh install, or the dangling-symlink
/// state). Nothing is created, moved or written.
pub fn locate_profile(env: &ProfileEnv) -> Result<Option<ElectronProfile>, ImportError> {
    let (dir, born_at_new_path, other_candidates) = match &env.override_dir {
        Some(dir) => match resolve_candidate(dir) {
            Some(dir) => (dir, false, Vec::new()),
            None => return Ok(None),
        },
        None => {
            let new_dir = env.app_data.join(MEMRYNOTE_APP_NAME);
            let legacy_dir = env.app_data.join("@memry").join("desktop");
            let chromium_dir = env.app_data.join(CHROMIUM_DIR_NAME);
            let usual = if let Some(dir) = resolve_candidate(&new_dir) {
                Some((dir, !is_symlink(&legacy_dir)))
            } else {
                resolve_candidate(&legacy_dir).map(|dir| (dir, false))
            };
            // `Chromium` is a generic name: it counts only with files this app writes.
            let chromium = resolve_candidate(&chromium_dir).filter(|d| has_memry_files(d));
            match (usual, chromium) {
                (None, None) => return Ok(None),
                (Some((dir, born)), None) => (dir, born, Vec::new()),
                (None, Some(dir)) => (dir, false, Vec::new()),
                (Some((dir, born)), Some(other)) => {
                    // A directory holding secrets or CRDT stores beats one without (a fresh
                    // `memrynote` that a just-launched app created); only equals fall back to
                    // the most recent use.
                    let rank = |d: &Path| (has_data(d), last_used(d));
                    if rank(&other) > rank(&dir) {
                        (other, false, vec![dir])
                    } else {
                        (dir, born, vec![other])
                    }
                }
            }
        }
    };
    let pin = IdentityPin::read(&dir)?;
    let has_ciphertexts = store_has_ciphertexts(&dir);
    let app_names = app_names(env.host, pin.as_ref(), has_ciphertexts, born_at_new_path);
    if !other_candidates.is_empty() {
        tracing::warn!(
            chosen = %dir.display(),
            others = ?other_candidates,
            "electron import: more than one Electron profile directory holds Memry data"
        );
    }
    let crdt_store_dirs = list_dirs(&dir.join("crdt-stores"))?;
    Ok(Some(ElectronProfile {
        host: env.host,
        pin,
        app_names,
        has_config: dir.join(CONFIG_FILENAME).is_file(),
        has_secure_store: dir.join(SECRET_STORE_FILENAME).is_file(),
        has_local_state: dir.join(LOCAL_STATE_FILENAME).is_file(),
        has_local_storage: is_real_dir(&dir.join("Local Storage").join("leveldb")),
        has_legacy_crdt_store: is_real_dir(&dir.join("crdt-store")),
        has_custom_dictionary: dir.join(DICTIONARY_FILENAME).is_file(),
        crdt_store_dirs,
        other_candidates,
        dir,
    }))
}

fn list_dirs(root: &Path) -> Result<Vec<PathBuf>, ImportError> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(ImportError::io(root, e)),
    };
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| is_real_dir(p))
        .collect();
    dirs.sort();
    Ok(dirs)
}

/// The directory name of a vault's CRDT store, `vaultDirName` in `lib/vault-dir-name.ts`: a
/// canonical lower-case uuid verbatim, anything else the first 32 hex of sha256 of the raw value.
pub fn vault_dir_name(vault_uuid: &str) -> String {
    use sha2::{Digest, Sha256};
    let normalized = vault_uuid.trim().to_lowercase();
    let is_uuid = normalized.len() == 36
        && normalized.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => matches!(c, '0'..='9' | 'a'..='f'),
        });
    if is_uuid {
        return normalized;
    }
    hex::encode(Sha256::digest(vault_uuid.as_bytes()))[..32].to_owned()
}

#[cfg(test)]
mod tests;
