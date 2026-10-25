//! Moving a database file aside instead of deleting it.
//!
//! A file that cannot be used is still a file somebody might need: a corrupt
//! `data.db` can be the only copy of unsynced work, and an `index.db` written by
//! a newer build is what that build will want back after a downgrade. So the
//! storage layer renames, and never removes, what it sets aside.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::api::errors::StorageError;

/// The `-wal` and `-shm` SQLite keeps beside a database; they move with it.
const SIDECARS: [&str; 2] = ["-wal", "-shm"];

pub(crate) fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis())
}

fn suffixed(path: &Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}{suffix}", path.display()))
}

/// Renames the file and its sidecars to `<path>.<label>-<stamp>[-n]`, the sidecars
/// keeping their `-wal` / `-shm` suffix so SQLite still replays the log when the
/// set-aside file is opened. `-n` is a collision counter: an earlier quarantine
/// is never overwritten.
pub(crate) fn move_aside(path: &Path, label: &str, stamp: u128) -> Result<PathBuf, StorageError> {
    let mut backup = suffixed(path, &format!(".{label}-{stamp}"));
    let mut n = 1;
    while backup.exists() {
        backup = suffixed(path, &format!(".{label}-{stamp}-{n}"));
        n += 1;
    }

    let rename = |from: &Path, to: &Path| {
        std::fs::rename(from, to).map_err(|err| StorageError::Failed {
            what: format!("could not move {} aside: {err}", from.display()),
        })
    };
    rename(path, &backup)?;
    for suffix in SIDECARS {
        let sidecar = suffixed(path, suffix);
        if sidecar.exists() {
            rename(&sidecar, &suffixed(&backup, suffix))?;
        }
    }
    Ok(backup)
}

/// Deletes all but the `keep` newest `<path>.<label>-*` quarantines. Only for a
/// derived database (`index.db`), where a pile of set-aside copies is a disk
/// hazard and none of them is the only copy of anything.
pub(crate) fn prune(path: &Path, label: &str, keep: usize) {
    let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else {
        return;
    };
    let prefix = format!("{}.{label}-", name.to_string_lossy());
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    // `<stamp>` or `<stamp>-<n>`; anything else (`-wal`, `-shm`) is a sidecar.
    let mut found: Vec<(u128, u64, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file = entry.file_name().to_string_lossy().into_owned();
            let rest = file.strip_prefix(&prefix)?;
            let (stamp, n) = match rest.split_once('-') {
                Some((stamp, n)) => (stamp.parse().ok()?, n.parse().ok()?),
                None => (rest.parse().ok()?, 0),
            };
            Some((stamp, n, entry.path()))
        })
        .collect();
    found.sort();
    let excess = found.len().saturating_sub(keep);
    for (_, _, old) in found.into_iter().take(excess) {
        for target in [old.clone(), suffixed(&old, "-wal"), suffixed(&old, "-shm")] {
            let _ = std::fs::remove_file(target);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::temp_dir;

    #[test]
    fn corrupt_recovery_never_overwrites_an_earlier_quarantine() {
        let dir = temp_dir("quarantine-collision");
        let path = dir.path().join("data.db");

        let mut moved = Vec::new();
        for round in 0..3 {
            std::fs::write(&path, format!("round {round}")).expect("a damaged file");
            std::fs::write(dir.path().join("data.db-wal"), "log").expect("its wal");
            moved.push(move_aside(&path, "corrupt", 1_700_000_000_000).expect("move aside"));
        }

        let names: Vec<String> = moved
            .iter()
            .map(|p| p.file_name().expect("name").to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            [
                "data.db.corrupt-1700000000000",
                "data.db.corrupt-1700000000000-1",
                "data.db.corrupt-1700000000000-2",
            ]
        );
        for (round, backup) in moved.iter().enumerate() {
            assert_eq!(
                std::fs::read_to_string(backup).expect("kept"),
                format!("round {round}")
            );
            let wal = suffixed(backup, "-wal");
            assert_eq!(
                std::fs::read_to_string(wal).expect("its wal moved too"),
                "log"
            );
        }
        assert!(!path.exists());
    }

    #[test]
    fn prune_keeps_the_newest_quarantines_with_their_sidecars() {
        let dir = temp_dir("quarantine-prune");
        let path = dir.path().join("index.db");
        for stamp in [100_u128, 200, 300, 400] {
            std::fs::write(&path, "x").expect("file");
            std::fs::write(dir.path().join("index.db-wal"), "w").expect("wal");
            move_aside(&path, "old", stamp).expect("aside");
        }
        std::fs::write(dir.path().join("index.db.newer-100"), "other label").expect("other");

        prune(&path, "old", 2);

        let mut left: Vec<String> = std::fs::read_dir(dir.path())
            .expect("dir")
            .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(
            left,
            [
                "index.db.newer-100",
                "index.db.old-300",
                "index.db.old-300-wal",
                "index.db.old-400",
                "index.db.old-400-wal",
            ]
        );
    }
}
