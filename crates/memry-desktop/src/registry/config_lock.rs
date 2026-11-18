//! The advisory lock that serialises every write of `memry-config.json` across processes: the
//! app and the command line (`memrynote-cli`) both write it. [`super::config::AppConfig::update`]
//! re-reads the file before each write, but between that read and the rename another process
//! could write a key that this rename then drops (#4278).

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

use super::config::ConfigError;

/// Holds the lock on `<config>.lock` until the returned file is dropped. The file is never
/// removed: a process that removes it could leave two holders of two different files.
pub(super) fn hold(config: &Path) -> Result<File, ConfigError> {
    let path = PathBuf::from(format!("{}.lock", config.display()));
    let fail = |error: std::io::Error| ConfigError::Write {
        path: path.display().to_string(),
        message: error.to_string(),
    };
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&path)
        .map_err(fail)?;
    file.lock().map_err(fail)?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use serde_json::{Map, Value};

    use super::super::config::{AppConfig, ConfigError};

    /// Set in the child processes of the test below: `<config path>|<key prefix>`.
    const WORKER: &str = "MEMRY_CONFIG_LOCK_WORKER";
    const UPDATES: usize = 200;

    /// Two processes each write their own keys into one file; every key survives.
    #[test]
    fn updates_from_two_processes_do_not_lose_each_other() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("memry-config.json");
        let exe = std::env::current_exe().expect("test binary");
        let children: Vec<_> = ["a", "b"]
            .into_iter()
            .map(|tag| {
                std::process::Command::new(&exe)
                    .args([
                        "--exact",
                        "registry::config_lock::tests::worker",
                        "--test-threads=1",
                    ])
                    .env(WORKER, format!("{}|{tag}", path.display()))
                    .stdout(std::process::Stdio::null())
                    .spawn()
                    .expect("spawn worker")
            })
            .collect();
        for mut child in children {
            assert!(child.wait().expect("wait").success(), "worker failed");
        }
        let written = AppConfig::load_strict(path).expect("load");
        assert_eq!(written.read(Map::len), 2 * UPDATES);
    }

    /// The child side of the test above; does nothing in a normal run.
    #[test]
    fn worker() {
        let Some(spec) = std::env::var_os(WORKER) else {
            return;
        };
        let spec = spec.into_string().expect("utf-8 spec");
        let (path, tag) = spec.rsplit_once('|').expect("spec");
        let config = AppConfig::load(path.into());
        for n in 0..UPDATES {
            config
                .update(|map| {
                    map.insert(format!("{tag}{n}"), Value::from(n));
                    Ok::<_, ConfigError>(())
                })
                .expect("update");
        }
    }
}
