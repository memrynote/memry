//! `memry-config.json`: the app-level config file, in the shape the Electron build wrote.
//!
//! The file is a JSON object this app shares, key by key, with other owners (the registry,
//! settings, window bounds, sync, updater) and with other builds. So the type is a
//! [`serde_json::Map`] that keeps key order, and every writer edits only the keys it knows:
//! an unknown key, or an unknown field inside a known entry, round-trips untouched.
//!
//! Every write is whole-file and atomic (temp file in the same directory, fsync, rename,
//! fsync of the directory) and goes through [`AppConfig::update`] under one mutex, so writers
//! never interleave. The in-memory copy changes only after the rename succeeded: a failed
//! write is an error the caller sees, never a cache that disagrees with the disk.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

/// Rename retries (Windows: antivirus and indexers hold files briefly), with the pause
/// before each. About 1.1 s in total.
const RENAME_BACKOFF_MS: [u64; 6] = [20, 40, 80, 160, 320, 480];

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    /// The file exists but could not be read, so what is in it is unknown. Writing would
    /// replace it with a guess.
    #[error("the config file {path} could not be read: {message}")]
    Unreadable { path: String, message: String },
    #[error("the config file {path} could not be written: {message}")]
    Write { path: String, message: String },
}

pub struct AppConfig {
    path: PathBuf,
    state: Mutex<State>,
}

struct State {
    map: Map<String, Value>,
    /// Set when the file could not be read for a reason other than "absent" or "not JSON".
    unreadable: Option<String>,
}

impl AppConfig {
    /// Loads `path`. A missing file is an empty config. A file that is not a JSON object is
    /// moved to `<name>.bad-<unix ms>` (never deleted) and the config starts empty; the first
    /// write then creates a fresh file. Any other read failure makes [`AppConfig::update`]
    /// refuse, so an unreadable config is never overwritten.
    pub fn load(path: PathBuf) -> Self {
        remove_stale_temp(&path);
        let mut state = State {
            map: Map::new(),
            unreadable: None,
        };
        match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(Value::Object(map)) => state.map = map,
                _ => set_aside(&path),
            },
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                tracing::error!(path = %path.display(), %err, "config file unreadable");
                state.unreadable = Some(err.to_string());
            }
        }
        Self {
            path,
            state: Mutex::new(state),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Runs `f` over the current config.
    pub fn read<R>(&self, f: impl FnOnce(&Map<String, Value>) -> R) -> R {
        f(&lock(&self.state).map)
    }

    /// Applies `f` to a copy of the config, writes the result atomically, and only then keeps
    /// it. `f` returning `Err` writes nothing.
    pub fn update<R, E: From<ConfigError>>(
        &self,
        f: impl FnOnce(&mut Map<String, Value>) -> Result<R, E>,
    ) -> Result<R, E> {
        let mut state = lock(&self.state);
        if let Some(message) = &state.unreadable {
            return Err(ConfigError::Unreadable {
                path: self.path.display().to_string(),
                message: message.clone(),
            }
            .into());
        }
        let mut next = state.map.clone();
        let out = f(&mut next)?;
        if next != state.map {
            write_atomic(&self.path, &next)?;
            state.map = next;
        }
        Ok(out)
    }
}

fn lock(state: &Mutex<State>) -> std::sync::MutexGuard<'_, State> {
    // A panic inside a closure leaves the map as it was (writes go to a copy).
    state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis())
}

fn temp_path(path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.tmp", path.display()))
}

fn remove_stale_temp(path: &Path) {
    let _ = std::fs::remove_file(temp_path(path));
}

fn set_aside(path: &Path) {
    let bad = PathBuf::from(format!("{}.bad-{}", path.display(), now_ms()));
    match std::fs::rename(path, &bad) {
        Ok(()) => tracing::warn!(
            from = %path.display(),
            to = %bad.display(),
            "config file is not a JSON object; moved aside and starting empty"
        ),
        Err(err) => {
            tracing::error!(path = %path.display(), %err, "could not move a bad config aside")
        }
    }
}

fn write_atomic(path: &Path, map: &Map<String, Value>) -> Result<(), ConfigError> {
    let fail = |message: String| ConfigError::Write {
        path: path.display().to_string(),
        message,
    };
    // A config that is a symlink keeps being one: the rename replaces the target.
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let bytes = serde_json::to_vec_pretty(map).map_err(|err| fail(err.to_string()))?;
    let temp = temp_path(&target);
    let mut file = std::fs::File::create(&temp).map_err(|err| fail(err.to_string()))?;
    let written = std::io::Write::write_all(&mut file, &bytes).and_then(|()| file.sync_all());
    if let Err(err) = written {
        let _ = std::fs::remove_file(&temp);
        return Err(fail(err.to_string()));
    }
    drop(file);
    #[cfg(unix)]
    if let Ok(meta) = std::fs::metadata(&target) {
        // Keep the mode the user (or an older build) gave the file.
        let _ = std::fs::set_permissions(&temp, meta.permissions());
    }
    let mut attempt = 0;
    loop {
        match std::fs::rename(&temp, &target) {
            Ok(()) => break,
            Err(err) if attempt < RENAME_BACKOFF_MS.len() && is_transient_rename(&err) => {
                std::thread::sleep(Duration::from_millis(RENAME_BACKOFF_MS[attempt]));
                attempt += 1;
            }
            Err(err) => {
                let _ = std::fs::remove_file(&temp);
                return Err(fail(err.to_string()));
            }
        }
    }
    sync_directory(&target);
    Ok(())
}

/// Windows reports a held target as access denied or a sharing violation (32).
fn is_transient_rename(err: &std::io::Error) -> bool {
    cfg!(windows)
        && (err.kind() == std::io::ErrorKind::PermissionDenied || err.raw_os_error() == Some(32))
}

fn sync_directory(path: &Path) {
    #[cfg(unix)]
    if let Some(dir) = path.parent()
        && let Ok(handle) = std::fs::File::open(dir)
    {
        let _ = handle.sync_all();
    }
    #[cfg(not(unix))]
    let _ = path;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    const ELECTRON_FILE: &str = r#"{
  "locale": "tr",
  "currentVault": "/v/a",
  "vaults": [
    {
      "path": "/v/a",
      "name": "a",
      "noteCount": 3,
      "taskCount": 0,
      "lastOpened": "2026-01-02T03:04:05.678Z",
      "isDefault": true,
      "futureField": {
        "kept": [
          1,
          2
        ]
      }
    }
  ],
  "sync": {
    "deviceId": "dev-1"
  },
  "someFutureKey": [
    1,
    "two",
    null
  ]
}"#;

    #[test]
    fn an_untouched_electron_file_round_trips_with_unknown_keys_and_order() {
        let dir = dir();
        let path = dir.path().join("memry-config.json");
        std::fs::write(&path, ELECTRON_FILE).expect("seed");
        let config = AppConfig::load(path.clone());

        config
            .update(|map| -> Result<(), ConfigError> {
                map.insert("locale".into(), Value::String("en".into()));
                Ok(())
            })
            .expect("update");

        let expected = ELECTRON_FILE.replace("\"tr\"", "\"en\"");
        assert_eq!(std::fs::read_to_string(&path).expect("read"), expected);
    }

    #[test]
    fn an_unparseable_file_is_moved_aside_not_overwritten_or_deleted() {
        let dir = dir();
        let path = dir.path().join("memry-config.json");
        std::fs::write(&path, b"{ not json").expect("seed");
        let config = AppConfig::load(path.clone());
        assert!(config.read(Map::is_empty));
        assert!(!path.exists(), "nothing is written until a writer asks");
        let bad: Vec<_> = std::fs::read_dir(dir.path())
            .expect("dir")
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().contains(".bad-"))
            .collect();
        assert_eq!(bad.len(), 1);
        assert_eq!(std::fs::read(bad[0].path()).expect("read"), b"{ not json");
    }

    #[test]
    fn a_failed_write_leaves_the_cache_as_the_disk_has_it() {
        let dir = dir();
        // The config's directory does not exist, so the temp file cannot be created.
        let path = dir.path().join("missing").join("memry-config.json");
        let config = AppConfig::load(path);
        let result = config.update(|map| -> Result<(), ConfigError> {
            map.insert("locale".into(), Value::String("en".into()));
            Ok(())
        });
        assert!(matches!(result, Err(ConfigError::Write { .. })));
        assert!(
            config.read(Map::is_empty),
            "the cache did not move ahead of the disk"
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_file_is_never_overwritten() {
        use std::os::unix::fs::PermissionsExt;
        let dir = dir();
        let path = dir.path().join("memry-config.json");
        std::fs::write(&path, ELECTRON_FILE).expect("seed");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).expect("chmod");
        if std::fs::read(&path).is_ok() {
            return; // running as root: the permission does not bite
        }
        let config = AppConfig::load(path.clone());
        let result = config.update(|map| -> Result<(), ConfigError> {
            map.insert("locale".into(), Value::String("en".into()));
            Ok(())
        });
        assert!(matches!(result, Err(ConfigError::Unreadable { .. })));
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).expect("chmod");
        assert_eq!(std::fs::read_to_string(&path).expect("read"), ELECTRON_FILE);
    }

    #[test]
    fn concurrent_updates_do_not_lose_each_other() {
        let dir = dir();
        let config = std::sync::Arc::new(AppConfig::load(dir.path().join("memry-config.json")));
        let threads: Vec<_> = (0..8)
            .map(|n| {
                let config = config.clone();
                std::thread::spawn(move || {
                    config
                        .update(|map| -> Result<(), ConfigError> {
                            map.insert(format!("k{n}"), Value::from(n));
                            Ok(())
                        })
                        .expect("update");
                })
            })
            .collect();
        for t in threads {
            t.join().expect("join");
        }
        let reloaded = AppConfig::load(config.path().to_path_buf());
        assert_eq!(reloaded.read(Map::len), 8);
    }
}
