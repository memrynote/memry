//! The advisory lock that serialises every write of a shared config file across processes: the
//! app and the command line (`memrynote-cli`) both write `memry-config.json` and each vault's
//! `.memry/config.json`. [`super::config::AppConfig::update`] and [`crate::vault::config::update`]
//! re-read the file before each write, but between that read and the rename another process
//! could write a key that this rename then drops (#4278).

use std::fs::{File, OpenOptions, TryLockError};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Why the lock was not taken: the lock file, the reason and its kind (`PermissionDenied` when
/// the folder refuses the lock file, so a caller can report it as the write's own permission
/// error).
#[derive(Debug)]
pub(crate) struct LockError {
    pub path: PathBuf,
    pub message: String,
    pub kind: ErrorKind,
}

/// How long a write waits for another process's write. A write holds the lock for one read,
/// write and rename, well under a second.
const WAIT: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(10);

/// Holds the lock on `<config>.lock` until the returned file is dropped. The file is never
/// removed: a process that removes it could leave two holders of two different files.
///
/// `Ok(None)` where the file system has no locks ([`unsupported`]: an NFS or SMB home): the write goes ahead unlocked, as before, with a warning, because refusing
/// would stop every config write of the app there. A lock still held after [`WAIT`] is an error.
///
/// A lock file this user may not write (another user's, left by `sudo memrynote`) is locked
/// through a read-only handle: `flock` and `LockFileEx` both lock one. One this user cannot open
/// at all takes the no-locks path, so it never stops the app's config writes.
pub(crate) fn hold(config: &Path) -> Result<Option<File>, LockError> {
    let path = PathBuf::from(format!("{}.lock", config.display()));
    let fail = |error: std::io::Error| LockError {
        path: path.clone(),
        message: error.to_string(),
        kind: error.kind(),
    };
    let file = match OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::PermissionDenied => match File::open(&path) {
            Ok(file) => file,
            Err(read) if read.kind() == ErrorKind::PermissionDenied => {
                tracing::warn!(
                    path = %path.display(),
                    %read,
                    "the lock file cannot be opened; the config is written without the lock"
                );
                return Ok(None);
            }
            // No lock file and a folder that refuses one: the write would be refused too.
            Err(_) => return Err(fail(error)),
        },
        Err(error) => return Err(fail(error)),
    };
    let deadline = Instant::now() + WAIT;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(Some(file)),
            Err(TryLockError::Error(error)) if unsupported(&error) => {
                tracing::warn!(
                    path = %path.display(),
                    %error,
                    "no file locks here; the config is written without the lock"
                );
                return Ok(None);
            }
            Err(TryLockError::Error(error)) => return Err(fail(error)),
            Err(TryLockError::WouldBlock) if Instant::now() >= deadline => {
                return Err(fail(std::io::Error::new(
                    ErrorKind::WouldBlock,
                    format!(
                        "another process held the lock for more than {} s",
                        WAIT.as_secs()
                    ),
                )));
            }
            Err(TryLockError::WouldBlock) => std::thread::sleep(POLL),
        }
    }
}

/// A file system that has no locks: `ENOLCK` (NFS without a lock daemon), `ENOTSUP` and
/// `EOPNOTSUPP` (macOS SMB and some FUSE mounts; one value on Linux), or no lock support at all.
fn unsupported(error: &std::io::Error) -> bool {
    #[cfg(unix)]
    if let Some(errno) = error.raw_os_error()
        && [libc::ENOLCK, libc::ENOTSUP, libc::EOPNOTSUPP].contains(&errno)
    {
        return true;
    }
    error.kind() == std::io::ErrorKind::Unsupported
}

#[cfg(test)]
mod tests {
    use serde_json::{Map, Value};

    use super::super::config::{AppConfig, ConfigError};

    use std::path::Path;
    use std::time::Duration;

    /// Set in the child processes of the test below: `<config path>|<key prefix>`.
    const WORKER: &str = "MEMRY_CONFIG_LOCK_WORKER";
    const UPDATES: usize = 200;

    fn wait_for(path: &Path) {
        for _ in 0..6000 {
            if path.exists() {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("{} never appeared", path.display());
    }

    /// Two processes each write their own keys into one file, starting together; every key
    /// survives.
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
        for tag in ["a", "b"] {
            wait_for(&dir.path().join(format!("ready-{tag}")));
        }
        std::fs::write(dir.path().join("go"), b"").expect("go");
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
        let dir = Path::new(path).parent().expect("dir");
        let config = AppConfig::load(path.into());
        std::fs::write(dir.join(format!("ready-{tag}")), b"").expect("ready");
        wait_for(&dir.join("go"));
        for n in 0..UPDATES {
            config
                .update(|map| {
                    map.insert(format!("{tag}{n}"), Value::from(n));
                    Ok::<_, ConfigError>(())
                })
                .expect("update");
        }
    }

    /// The errors of a file system without locks: the write goes ahead unlocked. Any other
    /// error refuses it.
    #[cfg(unix)]
    #[test]
    fn a_file_system_without_locks_is_told_from_other_errors() {
        use std::io::{Error, ErrorKind};
        for errno in [libc::ENOLCK, libc::ENOTSUP, libc::EOPNOTSUPP] {
            assert!(
                super::unsupported(&Error::from_raw_os_error(errno)),
                "errno {errno}"
            );
        }
        assert!(super::unsupported(&Error::from(ErrorKind::Unsupported)));
        for errno in [libc::EACCES, libc::EIO, libc::EBADF] {
            assert!(
                !super::unsupported(&Error::from_raw_os_error(errno)),
                "errno {errno}"
            );
        }
    }

    /// A lock another process does not let go of fails the write instead of hanging it.
    #[test]
    fn a_lock_held_past_the_wait_fails_the_write() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("memry-config.json");
        let held = std::fs::File::create(dir.path().join("memry-config.json.lock")).expect("lock");
        held.lock().expect("hold");
        let config = AppConfig::load(path.clone());
        let error = config
            .update(|map| {
                map.insert("a".into(), Value::Null);
                Ok::<_, ConfigError>(())
            })
            .expect_err("held");
        assert!(error.to_string().contains("held the lock"), "{error}");
        assert!(!path.exists(), "nothing written");
    }
}
